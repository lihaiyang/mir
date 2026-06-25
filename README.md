# MIR

**Multi-pane IDE for developer-agent collaboration.**

MIR 是一个本地桌面 IDE，专为人类开发者和 AI 代理协同工作设计。它把终端、代码编辑、Git、文件浏览和网页内嵌在同一个窗口里，通过自由拆分的多窗格布局，让你同时看清编译、调试、文档和搜索结果。

---

## 产品特性

### 可拆分多窗口布局

窗口可沿任意方向拆分为上下左右多个窗格，每个窗格内都有独立的标签页系统。拖动分割线即可调整比例，双击分割线恢复均分。窗格可以关闭、可以合并，布局会自动持久化——下次打开还是你上次的样子。

### 标签页系统

每个窗格可以同时打开多个标签页，支持 5 种标签类型：

- **终端**：基于 node-pty 的真实伪终端，支持 shell 配置文件，CJK 字符宽度自动换算，自适应窗口尺寸。进程退出后可一键重启。
- **代码编辑器**：内嵌 Monaco Editor，语法高亮覆盖 20+ 主流语言，支持多文件切换、自动保存、快捷键保存（Cmd+S）。
- **文件查看**：轻量文件浏览，支持搜索结果跳转到指定行，不会意外修改。
- **Diff 对比**：并排/内联两种模式查看 Git 变更，区分暂存区和未暂存修改。
- **浏览器**：使用 Electron `<webview>` 嵌入完整 Chromium 浏览器实例，支持书签栏，导航状态同步到地址栏。

标签页支持拖拽排序、跨窗格移动、右键菜单（重命名、复制、关闭其他、关闭右侧）。

### 内置终端

终端使用 PTY 创建真实的 shell 进程 `/bin/zsh`，自动继承系统环境变量并注入 `LC_ALL=en_US.UTF-8` 保证 CJK 字符显示正确。支持选中复制、粘贴、清屏、重启，xterm 搜索插件按 `Ctrl+Shift+F` 即可搜索终端内容。主题跟随全局深色/浅色模式。

### 文件树

左侧和右侧各有一套独立文件树。展开节点自动懒加载子目录，按目录优先、字母序排列。支持右键菜单：新建文件/文件夹、重命名、删除、复制路径、在系统文件管理器中显示。

文件图标根据扩展名自动匹配 emoji 图标（如 `ts → 🔷`、`py → 🐍`、`go → 🔵`）。

### Git 面板

右侧面板内置 Git 集成，基于 simple-git：

- 当前分支名 + 上游跟踪状态（↑ahead / ↓behind）
- 暂存区 / 变更区文件列表，点击文件名直接打开 Diff 视图
- 一键 Stage / Unstage 单个文件或全部
- 提交框支持多行 commit message
- 分支切换面板 + 新建分支
- 远程操作：Fetch / Pull / Push
- 提交历史列表，点击展开查看完整 commit body
- 每 3 秒自动刷新状态

### 搜索面板

项目级文本搜索，支持：

- 正则表达式 / 区分大小写 / 全词匹配
- 指定扩展名过滤（逗号分隔，如 `.ts,.tsx`）
- 自动加载 `.gitignore`，跳过 `node_modules` 等排除目录
- 搜索结果按文件分组，点击跳转到代码或创建新查看标签
- 搜索历史（最近 10 条持久化）
- **批量替换**：支持正则替换，替换前弹出确认对话框

### 网页标签页

侧边栏可以添加网页书签（Google Docs、Notion、内部文档等），点击后以无干扰模式全屏显示。网页标题变更会触发通知徽标。浏览器标签页可从窗格拖拽到侧边栏保存为收藏。

浏览器支持书签栏、前进后退、刷新、开发者工具打开。

### 命令面板

按 `Ctrl+Shift+P` 打开命令面板，支持模糊搜索。当前内置命令包括打开设置面板，后续可扩展。

### 全局快捷键

| 快捷键 | 功能 |
|---|---|
| `Cmd/Ctrl + T` | 新建终端标签 |
| `Cmd/Ctrl + W` | 关闭当前标签 |
| `Cmd/Ctrl + Tab` | 下一个标签 |
| `Cmd/Ctrl + Shift + Tab` | 上一个标签 |
| `Cmd/Ctrl + \` | 水平拆分窗格 |
| `Cmd/Ctrl + Shift + \` | 垂直拆分窗格 |
| `Cmd/Ctrl + ,` | 打开设置 |
| `Cmd/Ctrl + Shift + P` | 命令面板 |

### 国际化

支持中英文切换，点击标题栏右侧的 `EN | 中` 按钮即时切换。

### 持久化与恢复

所有状态通过 electron-store 自动持久化：

- 窗格布局、分割比例、折叠状态
- 标签页列表、当前活跃标签
- 项目列表和顺序
- 网页收藏和通知状态
- 搜索历史
- 用户设置（主题、字体大小、shell 路径等）

关闭窗口时触发最终持久化写入，确保不丢失数据。

### 自动更新（macOS）

应用内置自动更新，无需手动下载新版安装包：

- 启动 10 秒后检查 GitHub Releases 最新版本，之后每小时轮询一次
- 通过语义化版本比较判断是否有新版（`tag_name` 与 `app.getVersion()` 对比）
- 发现新版本后自动在后台下载 `.zip` 包并解压，菜单栏「检查更新…」实时显示检查/下载/解压状态与进度
- 用户退出应用时，一个独立的脚本在进程退出后原子替换 `/Applications/MIR.app`，下次打开即为新版（也可在就绪提示里点「立即重启」立即生效）

该方案不依赖代码签名，也不走 Squirrel 签名校验链路：下载经由 Node.js 原生 `https`/`fs` 完成，产物不带 `com.apple.quarantine` 隔离属性，因此 Gatekeeper 不触发，未签名的构建也能正常自动更新。更新器仅在打包后的 macOS 应用中生效（开发模式下不运行）；首次安装仍需从 `.dmg` 拖入「应用程序」一次。

---

## 架构设计

### 整体分层

```
┌─────────────────────────────────────────────┐
│  TitleBar (原生拖拽区域 + 标签栏 + 浏览器导航)    │
├──────┬──────────────────────────┬───────────┤
│ Left │      Center Pane         │   Right   │
│ Pane │  ┌─────────┬──────────┐  │   Pane    │
│ 项目  │  │ PaneGroup│ PaneGroup │  │ 文件树/Git │
│ 收藏  │  │ TabBar  │ TabBar   │  │ /搜索     │
│      │  │ Terminal│ Editor   │  │           │
├──────┤  │ Browser │ Diff     │  ├───────────┤
│ Split│  └─────────┴──────────┘  │           │
└──────┴──────────────────────────┴───────────┘
```

应用遵循 Electron 经典三层模型：

```
main (Node.js)  ←→  preload (桥接)  ←→  renderer (Vue 3)
```

### 进程架构

```
main/                    # Electron 主进程
├── index.ts             # 窗口创建、浏览器会话配置
├── ipc.ts               # IPC 通道注册中心
├── pty.ts               # PTY 伪终端进程管理
├── git.ts               # Git 命令封装 (simple-git)
├── search.ts            # 文件搜索引擎 (ignore + RegExp)
└── updater.ts           # macOS 自动更新（GitHub Releases 轮询 + 下载 dmg）

preload/                 # contextBridge 桥接层
└── index.ts             # 暴露 electronAPI 给渲染进程

renderer/                # Vue 3 渲染进程
├── src/
│   ├── main.ts          # Vue 入口
│   ├── App.vue          # 根组件（三栏布局 + 全局模态框）
│   ├── components/
│   │   ├── center/      # 核心区域组件
│   │   │   ├── CenterPane.vue    # 窗格树渲染器
│   │   │   ├── PaneGroup.vue     # 单窗格容器
│   │   │   ├── TabBar.vue        # 标签栏
│   │   │   ├── TerminalTab.vue   # xterm 终端组件
│   │   │   ├── EditorTab.vue     # Monaco 编辑器
│   │   │   ├── FileTab.vue       # 文件查看器
│   │   │   ├── DiffTab.vue       # Git Diff 查看器
│   │   │   └── BrowserTab.vue    # Webview 浏览器
│   │   ├── left/         # 左侧面板
│   │   ├── right/        # 右侧面板
│   │   └── TitleBar.vue  # 标题栏
│   ├── stores/          # Pinia 状态管理
│   │   ├── tabs.ts      # 标签页 + 窗格树核心逻辑
│   │   ├── projects.ts  # 项目管理
│   │   ├── webPages.ts  # 网页收藏管理
│   │   ├── settings.ts  # 用户设置
│   │   └── layout.ts    # 面板布局状态
│   ├── composables/     # 复用逻辑
│   └── i18n/            # 国际化
```

### 窗格树数据结构

窗格管理是整个应用最核心的数据模型。它使用递归树结构表示任意拆分关系：

```typescript
// 叶子节点：一个实际的标签页容器
interface PaneNode {
  id: string
  type: 'leaf'
  groupId: string          // 指向 TabGroup
}

// 分割节点：将空间一分为二
interface SplitNode {
  id: string
  type: 'horizontal' | 'vertical'
  children: [TreeNode, TreeNode]
  sizes: [number, number]  // 各占比例，如 [0.5, 0.5]
}

type TreeNode = PaneNode | SplitNode
```

每一次拆分都是在上次的叶节点位置插入一个新的 SplitNode。因此窗口可以被无限嵌套拆分（水平/垂直交错），形成类似于 Vim/VS Code 的灵活布局。

### 标签页状态管理

标签页 Store (`stores/tabs.ts`) 是全局状态的核心模块，约 500 行代码，负责：

1. **窗格树操作**：拆分、关闭、聚焦、拖动调整大小
2. **标签 CRUD**：添加、删除、重命名、复制、排序
3. **跨窗格移动**：从当前窗格拖拽标签到另一个窗格
4. **多窗格第一行布局**：扁平化窗格树，计算标题栏中每个 TabBar 的宽度比例
5. **持久化**：序列化整棵窗格树、标签组和焦点状态到 electron-store
6. **从旧版单向迁移**：自动检测旧格式数据并转换

### 终端实现

主进程通过 `node-pty` 创建真正的 shell 进程，输出通过 IPC 事件推送到渲染进程：

```
──────── TerminalTab.vue ─────────           ──── main/pty.ts ────
xterm.write(data)  ←── IPC ───  proc.onData(data)
xterm.onData(d)    ── IPC ──→   proc.write(d)
xterm.onResize     ── IPC ──→   proc.resize(cols, rows)
onBeforeUnmount    ── IPC ──→   proc.kill()
```

每个终端标签拥有唯一 ID（UUID），PTY 进程在 `onMounted` 时创建，在 `onBeforeUnmount` 时销毁。终端容器使用 `ResizeObserver` 监听尺寸变化，通过 `FitAddon` 自适应后同步行列数给 PTY。

### 浏览器实现

使用 Electron 的 `<webview>` 标签嵌入完整 Chromium 浏览器上下文，指定 `partition="persist:browser"` 持久化 cookie/storage。主进程通过 `session.fromPartition` 配置权限处理：

- 放行所有权限请求（通知、Service Worker 等）
- 移除 `X-Frame-Options` 响应头，避免跨域框架加载被阻止
- 禁用 Service Worker 无害错误日志输出

浏览器标签的独立模式采用 `v-show` 控制可见性，保证 `<webview>` 实例切换时不重建——这是 Electron webview 的最佳实践。

### 跨进程通信

渲染进程与主进程之间通过 Electron IPC 通信，preload 脚本用 `contextBridge.exposeInMainWorld` 暴露类型安全的 API：

```typescript
// 双向调用（渲染 → 主，返回 Promise）
ipcRenderer.invoke('git:status', cwd)

// 单向推送（渲染 → 主，不等待）
ipcRenderer.send('pty:write', id, data)

// 事件监听（主 → 渲染，长期订阅）
ipcRenderer.on(`pty:data:${id}`, listener)
```

所有文件系统操作（读/写/遍历/状态）、Git 操作、搜索都在主进程执行，渲染进程只负责 UI 展示和用户交互。

### 技术选型表

| 层级 | 技术 | 用途 |
|---|---|---|
| 桌面框架 | Electron 28 | 窗口管理、系统集成 |
| 构建工具 | electron-vite | 开发/构建/热更新 |
| 前端框架 | Vue 3 + Composition API | UI 组件、响应式状态 |
| 状态管理 | Pinia | 全局 Store（tabs / projects / settings / webPages / layout） |
| 终端 | @xterm/xterm v6 + node-pty | 伪终端渲染 |
| 编辑器 | Monaco Editor 0.55 | 代码编辑器 / Diff 查看器 |
| Git | simple-git | Git 状态/提交/分支管理 |
| 持久化 | electron-store v8 | JSON 文件存储配置和状态 |
| 国际化 | vue-i18n v9 | 中英文切换 |
| 语言 | TypeScript | 全栈类型安全 |

### 项目目录结构

```
mir/
├── package.json               # 项目配置、依赖、构建脚本
├── electron.vite.config.ts    # Vite 构建配置
├── tsconfig.json              # TypeScript 配置
├── scripts/                   # 构建辅助脚本
│   └── linux-after-pack.js    # Linux 打包后钩子
├── src/
│   ├── main/                  # Electron 主进程
│   │   ├── index.ts           # 入口：窗口创建、浏览器会话
│   │   ├── ipc.ts             # IPC 处理器注册
│   │   ├── pty.ts             # PTY 伪终端管理
│   │   ├── git.ts             # Git 操作封装
│   │   ├── search.ts          # 全文搜索
│   │   └── updater.ts         # macOS 自动更新
│   ├── preload/               # 预加载脚本
│   │   └── index.ts           # contextBridge API
│   └── renderer/              # 渲染进程
│       ├── index.html         # HTML 入口
│       └── src/
│           ├── main.ts        # Vue 应用入口
│           ├── App.vue        # 根组件
│           ├── components/    # 组件
│           ├── stores/        # Pinia 状态管理
│           ├── composables/   # 组合式函数
│           ├── i18n/          # 国际化
│           └── assets/        # 静态资源
└── data/                      # 运行时数据 (git clone 生产存储)
```

---

## 构建与运行

### 环境要求

- Node.js ≥ 18
- macOS 13+ (Apple Silicon) / Windows 10+ / Linux x64/arm64
- git

### 开发

```bash
npm install
npm run dev
```

### 构建 macOS DMG

```bash
npm run pack:dmg
```

产物在 `release/` 目录。

### 构建 Windows portable

```bash
npm run pack:win
```

### 构建 Linux AppImage / deb / tar.gz

```bash
npm run pack:linux
```

Linux 构建会自动添加 `--no-sandbox` 参数并执行 `after-pack` 脚本处理 node-pty 二进制。

### 发布新版本

发布由 GitHub Actions 自动完成（`.github/workflows/release.yml`），推送 tag 后自动构建并上传到 GitHub Releases。

#### 版本号规则

项目有两个隔离的更新通道，互不干扰：

| | 正式版（Stable） | Dev 版 |
|---|---|---|
| **用途** | 日常使用 | 开发测试 |
| **package.json version** | `X.Y.Z`（标准 semver） | `X.Y.Z-dev.N`（semver prerelease） |
| **Git tag** | `vX.Y.Z` | `dev-X.Y.Z` |
| **资产名前缀** | `MIR-` | `MIR-Dev-` |
| **App 名** | MIR | MIR Dev |
| **appId** | com.mir.ide | com.mir.ide.dev |
| **版本检查** | releases.atom 中 `v*` tag | releases.atom 中 `dev-*` tag |

**关键规则**：dev 版的 tag `dev-X.Y.Z` 中的 `X.Y.Z` 必须与 package.json version 的 `X.Y.Z` 一致。例如 tag `dev-0.2.1` 对应 version `0.2.1-dev.0`。否则 updater 构造的资产名与实际文件不匹配会导致 404。

两个 app（MIR + MIR Dev）可以同时安装在 /Applications，各自独立更新，不会互相干扰。

#### 发布 Dev 版

在 `dev` 分支上开发：

```bash
# 1. 修改 package.json 和 package-lock.json 的 version
#    例如 0.2.1-dev.0
# 2. 提交并推送
git commit -am "feat: xxx"
git push origin dev
# 3. 打 tag（tag 的 X.Y.Z 必须与 version 一致）
git tag dev-0.2.1
git push origin dev-0.2.1
# 4. CI 自动构建，创建 GitHub Release 并上传 MIR-Dev-*.zip/.dmg/.blockmap
```

已安装 MIR Dev 的用户会自动检测到新 dev 版并下载更新。

#### Dev 转正（发布 Stable 版）

dev 版测试 OK 后，将 dev 分支合并到 main，发布正式版：

```bash
# 1. 在 main 分支合并 dev
git checkout main
git merge dev
# 2. 修改 version 为正式版格式（去掉 -dev.N 后缀）
#    例如 0.2.1-dev.0 → 0.2.1
# 3. 提交并推送
git commit -am "release: v0.2.1"
git push origin main
# 4. 打 tag
git tag v0.2.1
git push origin v0.2.1
# 5. CI 自动构建，创建 GitHub Release 并上传 MIR-*.zip/.dmg/.blockmap
```

已安装 MIR（正式版）的用户会自动检测到新版本并下载更新。正式版不会更新到 dev 版，dev 版也不会更新到正式版。

#### 增量更新

从 v0.2.0 起支持 blockmap 增量下载。每次全量下载后，zip 和 blockmap 会被缓存到 `~/Library/Application Support/mir/update-cache/`（dev 版在 `~/Library/Application Support/mir-dev/update-cache/`）。后续更新时只下载变化的块（通过 HTTP Range 请求），而非完整 zip。

首次更新（无缓存）为全量下载（~120MB），后续更新为增量下载（通常 ~25-36MB）。

### TypeScript 类型检查

```bash
npm run typecheck
```

---

## 许可证

MIT License
