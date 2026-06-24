# macOS 无感热更新改造

将 macOS 自动更新从「下载 dmg + 手动拖拽安装」改为「下载 zip + 退出时静默替换 + 下次启动生效」。

## 背景与目标

原方案（`src/main/updater.ts`）下载 `.dmg` 后调用 `shell.openPath` 弹出 Finder，用户需手动把 MIR 拖入 Applications——每次更新都要介入。

新方案下载 `.zip`、解压、在应用退出时用 `rename` 原子替换 `/Applications/MIR.app`，用户下次打开即为新版。除首次安装需确认一次 Gatekeeper 外，后续更新完全静默。

## 为什么能做到无感

- 下载走 Node.js `https` + `fs`，不经过浏览器/Finder，产出文件**不带 `com.apple.quarantine`** 属性。
- 没有 quarantine → Gatekeeper 不触发 → 不会弹「无法验证开发者」对话框。
- macOS 允许替换正在运行的 `.app`（进程已 mmap 旧 inode，替换不影响运行中进程），退出后下次启动加载新二进制。

## 改动清单

### 1. `src/main/updater.ts` — 核心重写

- 下载目标从 `MIR-{ver}-arm64.dmg` 改为 `MIR-{ver}-arm64-mac.zip`。
- 新增 `extractZip`：调用系统 `unzip` 解压到临时目录。
- 新增 `findAppBundle`：从解压目录定位 `.app` bundle。
- 新增 `isTranslocated`：检测 App Translocation（从 dmg 直接运行），拒绝更新并提示用户先安装到 Applications。
- 新增 `findInstalledAppPath`：从 `app.getPath('exe')` 反推 `.app` bundle 路径。
- 新增 `replaceInstalledApp`：三步原子替换——`mv 旧 → backup`、`mv 新(staging) → 当前路径`、`rm backup`；失败时回滚。
- 新增 `performPendingUpdate`：供 `before-quit` 调用，执行替换并返回是否成功。
- `applyUpdate`（UI「立即重启」按钮）：替换成功后 `app.relaunch()` + `app.exit(0)`。
- `UpdaterStatus` 新增 `extracting` 状态。
- `fetchLatestVersion` / `downloadFile` / `extractZip` 改用 `Promise.withResolvers()`（遵守项目规则）。
- 移除 `shell.openPath(dest)` 自动打开 dmg 的逻辑。

### 2. `src/main/index.ts` — 退出钩子

- 导入 `performPendingUpdate`。
- 新增 `before-quit` 监听：`event.preventDefault()` 阻止首次退出 → 异步执行替换 → `app.quit()` 放行二次退出。用 `isApplyingUpdate` 标志避免循环。
- `updateMenuForState` 新增 `extracting` 状态的菜单文案「正在解压 v{ver}…」。

### 3. `package.json`

- `version`: `0.1.13` → `0.1.14`。
- `build.mac.target` 在 `dmg` 之外新增 `zip`（arm64）。dmg 保留供首次安装，zip 供热更新。

### 4. `src/renderer/src/components/UpdateToast.vue`

- `ready` 状态按钮：「重新打开安装包 / 关闭」→「立即重启 / 退出时更新」。
- `reopen` 函数改名 `restartNow`。

### 5. i18n 文案

- `en.json` / `zh-CN.json` 的 `updater.ready` 改为提示「重启生效或退出时自动更新」；新增 `restartNow`、`onQuit`，移除 `reopen`。

### 6. `src/renderer/env.d.ts`

- `UpdaterStatus` 联合类型加 `'extracting'`，与 main 侧一致。

## 验证结果

| 检查项 | 结果 |
|---|---|
| `npm run typecheck` | 通过（0.50s） |
| `npm run pack` | 成功产出 `release/MIR-0.1.14-arm64-mac.zip` (115M) 与 `release/MIR-0.1.14-arm64.dmg` (115M) |
| zip 结构 | 顶层为 `MIR.app/`，含完整 bundle（456 文件） |
| 命名匹配 | `MIR-0.1.14-arm64-mac.zip` 与 updater 构造的下载 URL `MIR-{version}-{arch}-mac.zip` 一致 |

打包末尾的 `GH_TOKEN is not set` 报错仅影响自动发布到 GitHub Releases，不影响本地产物。

## 未完成事项

以下因进程占用未在本会话完成：

1. **替换 /Applications 旧版**：当前安装的是 `0.1.12`（`/Applications/MIR.app`），且 MIR 进程正在运行（PID 48163 等 Helper 进程）。需先退出 MIR，再执行替换：
   ```bash
   osascript -e 'quit app "MIR"'
   rm -rf /Applications/MIR.app
   cp -R release/mac-arm64/MIR.app /Applications/
   ```
   或直接挂载 dmg 拖拽安装。

2. **发布到 GitHub Releases**：需设 `GH_TOKEN` 后 `npm run pack` 才会自动上传。上传后，旧版 MIR 会通过 `initUpdater` 的定时检查拉取 0.1.14 的 zip 并在退出时静默替换。

3. **更新 README**：`README.md` 第 101-110 行「自动更新（macOS）」章节描述的是旧 dmg 流程（「下载完成自动打开安装包，用户只需把 MIR 拖入应用程序文件夹」），应改为描述新的 zip 静默替换流程。

## 关键设计决策

- **替换时机选 `before-quit` 而非下载完成后立即替换**：避免运行中进程访问被替换的 bundle 导致崩溃。
- **`rename` 而非 `cp -R`**：同文件系统下 `rename` 原子且瞬时；`cp` 非原子，中途崩溃会留下损坏的 .app。
- **保留 staging 路径检测**：`checkForUpdate` 开头会检查是否已下载同版本，避免重复下载。
- **未签名也能工作**：整个链路不依赖代码签名或 notarization，Gatekeeper 因无 quarantine 属性而完全不介入。
