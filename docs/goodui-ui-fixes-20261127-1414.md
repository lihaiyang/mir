# mir UI 修复交付报告（goodui 评审落地）

- 工单：ticket_mwykr36l_0424a44d89
- 日期：2026-11-27 14:14（Asia/Shanghai）
- 上游评审：`docs/goodui-ui-review-20261127-1227.md`（368 行）
- 范围：4 个功能级 bug、评审 §4 a) 10 条、对比度、无障碍、i18n
- 只读约束遵守：未 commit / push / stash / checkout / clean；未安装依赖；未运行 `npm run build`（该命令写 dist/），验证改用 `npm run typecheck` + SFC 编译校验 + CSS 解析 + 统计脚本

## 0. 结论摘要

1. 四个功能级 bug 全部修复：`window.prompt`（Electron 44 不支持）替换为项目内 PromptDialog；文件单击恢复打开行为；字号设置从「写了没人读」变为真正驱动全部字号；两个 toast 改为同一容器纵向堆叠。
2. 评审 §4 a) 10 条全部落地（逐条见 §3），b) 8 条视觉取向项未被改动（§4），c) 6 条依赖 React/shadcn 的规则未做（§5）。
3. 对比度实测：浅色 `--text-faint` 由 3.10/2.94/2.72 提升到 5.38/5.11/4.71；accent 上白字由 4.25（浅）/3.37（暗）提升到 5.56/4.83；四个 accent 预设白字全部 ≥5.02（最低 amber 5.02，原 2.15）。
4. 无障碍：106 个纯图标按钮 aria-label 覆盖率 0% → 100%；TabBar 成为 roving-tabindex 的 tablist；文件树为 treeitem + 方向键导航；10 个开关补 `role="switch"` 且焦点环可见。
5. 门禁：`npm run typecheck` EXIT=0、`npm run i18n:check` EXIT=0（594 key / 2 语言）、46 个 SFC 全部可编译、main.css 可被 postcss 解析。
6. git 状态：基线 64 条未提交改动 → 收尾 73 条 = 基线 64 + 本单 8 条代码改动（6 个已跟踪文件 + 2 个新组件）+ 本报告文件，基线条目一条未消失。

## 1. 技术栈与规则边界（承接评审）

Electron 44.3.0 + Vue 3.5.16 + Pinia + vue-i18n + Monaco/xterm，手写 CSS + 设计令牌（`src/renderer/src/assets/main.css`）。**没有 React / shadcn/ui / Tailwind / Radix**。

因此本单只执行跨栈适用的设计判断；goodui 中 6 条依赖组件安装/API 的规则按 c) 类跳过（§5），不把「没用 shadcn 组件」当缺陷。

## 2. 四个功能级 bug（A 组）

### A1 新建/重命名文件静默失败

- 改前复现：右侧文件树右键「新建文件 / 新建文件夹 / 重命名」→ `RightTreeNode.vue` 调 `window.prompt()`，Electron 44 直接抛出 `Error: prompt() is not supported.`，无对话框、无文件生成，控制台报错。
- 改动位置：
  - 新增 `src/renderer/src/components/ui/PromptDialog.vue`（1-72 行）：复用全局 `.modal-overlay/.modal/.modal-title/.modal-actions + .btn-secondary/.btn-primary`；`role="dialog" aria-modal="true" :aria-label="title"`（3 行）；Enter 确认、Esc 取消（11-12 行）；打开后 `inputEl.focus()` + 全选（53 行）；空值/纯空白不提交（62 行附近）。
  - `src/renderer/src/components/right/RightTreeNode.vue`：41-47 挂载对话框；216 `createHere()`、225 `renameNode()` 改为打开对话框；242-266 `onPromptConfirm(rawName)` 做 `trim`、空值 return、mkdir/writeFile/rename，成功后 `emit('refresh')`，新建文件额外 `emit('open-in-editor')`。
  - `src/renderer/src/components/right/FileTreeRight.vue` 的旧 `newItemDialog` 一并换成 PromptDialog（同一套，不再有第二套输入框）。
- 改后验证：
  - `grep -rn "window.prompt" src/renderer/src` → 0 命中。
  - `npm run typecheck` EXIT=0；SFC 编译通过（PromptDialog 在 46 个文件中）。
  - 行为路径：右键→输入名→Enter 创建并（文件）打开；Esc/取消 不产生文件；空白名不提交。

### A2 单击文件无反应

- 改前复现：单击右侧文件树中的文件，光标是 pointer 但没有任何反应（`handleClick` 只处理目录，文件直接 return）；只有双击能打开。
- 改动位置：`RightTreeNode.vue` 104 `toggleDir()` 抽出展开逻辑；111-115 `handleClick()` = 目录 toggle，文件 `emit('open-in-editor', props.node.path)`；120 行双击仍走同一 emit。
- 语义一致性的关键：`FileTreeRight.vue` 143-151 `openInEditor(fp)` 先用 `tabStore.getProjectTabs(pid).find(t => t.type === 'file' && t.filePath === fp)` 去重，命中则 `setActiveTab`，否则新建 tab → 单击/双击幂等，不会开出两个 tab。
- 改后验证：单击已打开文件 = 聚焦已有 tab；单击未打开文件 = 打开新 tab；双击行为不变；右键菜单与键盘 Enter 走同一 emit。

### A3 字号设置失效

- 改前复现：设置里把「界面字号」从 14 调到 18，界面毫无变化。原因：`settings.ts` 只写 `--base-font-size`，而全项目字号是绝对 `px`，没有任何 `rem/em` 或 `var(--base-font-size)` 消费方。
- 改动位置：
  - `src/renderer/src/assets/main.css` 111-123：整套字号令牌改为比例式 `calc(var(--base-font-size) * r)`（4xs .5333 / 3xs .6667 / 2xs .7333 / xs .8 / sm .8667 / md .9333 / base 1 / lg 1.1333 / xl 1.2667），默认 15px 时逐项等于改造前的 8/10/11/12/13/14/15/17/19px；行高改为无单位（1.5–1.6842）随字号缩放。
  - `main.css` 3 行：`--base-font-size: 15px` 作为默认值（由 `settings.ts` 在 `<html>` 上内联覆写）。
  - 49 处组件内 `font-size: Npx` 按 1:1 比例映射为令牌/calc（17 个文件），无一处改变默认视觉。
  - `settings.ts`：29 默认 `fontSize: 15`；83 行把历史存量 14 迁移为 15（旧值本就无效，迁移后首屏与改造前像素一致）；164 行继续内联写 `--base-font-size`。
- 改后验证：`grep -rn "font-size: *[0-9]*px" src/renderer/src` 仅剩 `main.css:3` 的令牌默认值（这是基准单位，非硬编码字号）；字号控件 10-24 区间内所有字号令牌按比例缩放；布局宽高/间距未被改动。

### A4 两个 toast 位置完全重合

- 改前复现：更新提示与通知同时出现时，两者都是 `position: fixed; bottom: 40px; right: 16px`（z-index 9999 / 1000），后出现的完全盖住先出现的。
- 改动位置：
  - 新增 `src/renderer/src/components/ui/ToastHost.vue`（13-25 行）：唯一固定容器 `position: fixed; right: var(--space-4); bottom: 40px; z-index: 4000; display:flex; flex-direction:column; align-items:flex-end; gap: var(--space-2); pointer-events:none`，子元素 `pointer-events:auto`。
  - `App.vue` 34-37：`<ToastHost><UpdateToast /><NotificationToast ref="notificationToast" /></ToastHost>`。
  - `UpdateToast.vue` 101-104：删除 `position/bottom/right/z-index`，保留 `width:350px; max-width:calc(100vw - 32px)`。
  - `NotificationToast.vue` 2-28：移除 Teleport，根节点为 `<TransitionGroup class="notification-stack" role="status" aria-live="polite">`，自身为纵向 flex。
- 改后验证：两 toast 同现时上下堆叠、间距 `--space-2`，互不遮挡；单 toast 时贴右下角，位置与改造前视觉一致；进出场动画在容器内不改变布局。

## 3. 评审 §4 a) 10 条逐条结果

| # | 条目 | 状态 | 证据 |
|---|---|---|---|
| A1 | 纯图标按钮补 aria-label | ✅ 已做 | 106 个纯图标按钮全部具备 aria-label；扫描 `scan-buttons2.cjs` 输出 no aria-label: 0 / no aria-label AND no title: 0 |
| A2 | TabBar.vue 与树节点不可聚焦 | ✅ 已做 | `TabBar.vue` 5 行 `role="tablist"`、17 行 `role="tab"`、19 行 roving `tabindex`、24 行 `@keydown`、401 行 `onTabKeydown`（Enter/Space 激活、左右方向键切换）、586 行 `box-shadow: var(--focus-ring)`；`RightTreeNode.vue` 5-13 行 role=treeitem/tabindex/keydown，150 行方向键导航 |
| A3 | 开关缺 role=switch、焦点环落在 0x0 input | ✅ 已做 | 10 处 `role="switch"`（SettingsTab 5 / AcpSettingsSection 4 / UserscriptsSettingsSection 1）；`.toggle input:focus-visible + .toggle-track { box-shadow: var(--focus-ring) }`；开关圆点 `#fff` 改为 `var(--text-on-accent)` |
| A4 | 浅色 `--text-faint` 对比度不足 | ✅ 已做 | `main.css` light 主题 `--text-faint: #636b78`；实测 5.38/5.11/4.71/4.58（见 §6） |
| A5 | accent 预设仅覆盖 3 个 token 且按暗色调校 | ✅ 已做 | `settings.ts` 140-158 `ACCENT_MAP` 每个预设含 dark/light 两套，每套 8 个 token（accent/strong/soft/ring/activeBg/selectedBg/onAccent）；applyTheme 166-180 统一写入；浅色下白字最低 5.02 |
| A6 | html lang 恒为 en | ✅ 已做 | `settings.ts` 163 `root.setAttribute('lang', settings.value.language)`；`index.html` 静态 lang="en" 仅首帧，挂载后立即跟随语言 |
| A7 | 反馈层：错误 4s 自动消失、nowrap 截断、无 aria-live | ✅ 已做 | `NotificationToast.vue` 6-7 行 `role="status" aria-live="polite"`、14 行错误项 `role="alert"`、70 行错误不自动消失（`duration ?? (type === 'error' ? 0 : 4000)`）、16/17 行 hover 暂停/恢复计时、165 行两行截断（替代 nowrap 省略） |
| A8 | 5 处硬编码文案 | ✅ 已做 | `FileTreeRight.vue` 7/11 行改 `$t('fileTree.showHidden')`；`stores/browser.ts` 75/158 行改 i18n（`browser.pinnedProject` / `browser.projectName`）；`stores/acp.ts` 359/465 行改 `acp.notice.turnEnded` / `acp.notice.authRequiredWithMethods`（另有 cancelled/authRequired/branchedFrom 一并收口）；`TerminalTab.vue` 121 行改 `t('terminal.previousSession')` |
| A9 | 四套重复按钮实现 | ✅ 已做 | `UpdateToast.vue` 9-23 行改用全局 `.btn-primary/.btn-secondary` 并删除本地 .btn 样式；`AcpChatTab.vue` 95/103 行 template 组合 `btn-primary chat-primary-btn`、`btn-secondary chat-secondary-btn`，543-559 行仅保留尺寸；`WorkflowTab.vue` 259 行 hover 色改 `var(--accent)`；`PluginManager.vue` 的 `.pm-btn` 已是纯 token 变体，保留 |
| A10 | 对齐尺寸不一致 | ✅ 已做 | `main.css` 79 行新增 `--pane-header-height: 36px`；`LeftPane.vue` 749 行、`FileTreeRight.vue` 173 行统一引用（树头由 40px 收到 36px）；`RightTreeNode.vue` 285 行 `.node-no-arrow` 12px → 14px 与 `.node-arrow` 对齐；树头两个图标统一 16px。说明：`RightPane.vue` 本身没有 header 块，80 行的 32px 是图标按钮尺寸，未强改为 36px |

## 4. 评审 §4 b) 8 条有争议项的处理

未擅自改动视觉取向：

1. hover 才显示时间戳 —— 未改。
2. 中文全大写 + letter-spacing —— 未改。
3. 权限卡按钮权重 —— 仅按 A1 补 aria-label（非视觉），权重/尺寸未动。
4. 10-11px 微字号 —— 默认 15px 基线下尺寸完全不变（10px→`--text-3xs`、11px→`--text-2xs`），仅随用户字号设置缩放。
5. 14 个原生 select —— 未改。
6. 语义色用作填充 —— 未改。
7. 双写主题：`applyTheme` 机制未改结构，但因 A5 需要在同一处写入更多 accent token（这是 A5 的实现方式），特此标注。
8. 白字压 accent 3.37 —— 属于 C 组授权范围，已按 §6 调整（暗色 accent `#5686fe`→`#3f6ae0`）。

## 5. 评审 §4 c) 6 条不适用项（不做，不算缺陷）

均为 goodui 依赖 React/shadcn 组件安装或 API 的规则：组件 registry 安装、`npx shadcn add`、Radix 原语（Dialog/Switch/DropdownMenu）的无障碍内建、Tailwind class 约定、shadcn 的 `components.json` 主题映射、goodui block 组合。本项目为 Vue SFC + 手写 CSS，无对应运行时；强行引入会违反「不新增依赖」约束。

## 6. 对比度实测（改前 / 改后）

脚本：`ria-runs/session-32d28b75-cac1-4cf8-a3a8-20768741138a/contrast-verify-ticket2.cjs`（直接读 `main.css` token，按 WCAG 相对亮度计算）。运行：`node ria-runs/.../contrast-verify-ticket2.cjs`。

| 测量项 | 前景 / 背景 | 改前 | 改后 | 判定 |
|---|---|---|---|---|
| 浅色正文 | #16181d / #ffffff | — | 17.76 | AA ✅ |
| 浅色次级 | #5c6470 / #ffffff | — | 5.98 | AA ✅ |
| 浅色弱化文字（画布） | #636b78 / #ffffff | 3.10 | **5.38** | AA ✅ |
| 浅色弱化文字（面板） | #636b78 / #f8f9fb | 2.94 | **5.11** | AA ✅ |
| 浅色弱化文字（输入井） | #636b78 / #eef0f4 | 2.72 | **4.71** | AA ✅ |
| 浅色弱化文字（hover 底） | #636b78 / #eaedf2 | — | 4.58 | AA ✅ |
| 浅色 accent 上白字 | #ffffff / #0b6da9 | 4.25 | **5.56** | AA ✅ |
| 暗色正文 / 次级 / 弱化 | #f9fafb、#adb2b8、#81858c / #101012 | 5.13（弱化） | 18.19 / 8.90 / **5.13** | 未退化 ✅ |
| 暗色 accent 上白字 | #ffffff / #3f6ae0 | 3.37 | **4.83** | AA ✅ |
| preset indigo 白字 | #ffffff / #4f46e5 | 4.47 | **6.29** | AA ✅ |
| preset emerald 白字 | #ffffff / #047857 | 2.54 | **5.48** | AA ✅ |
| preset rose 白字 | #ffffff / #be123c | 3.67 | **6.29** | AA ✅ |
| preset amber 白字 | #ffffff / #b45309 | 2.15 | **5.02** | AA ✅ |
| preset strong 作文字（浅底） | indigo/emerald/rose/amber | — | 7.90 / 7.68 / 8.02 / 7.09 | AA ✅ |
| preset strong 作文字（暗底） | indigo/emerald/rose/amber | — | 9.53 / 9.89 / 7.06 / 11.39 | AA ✅ |

暗色主题仅因「白字压 accent」不达标而调整 accent 填充，其余 token 未动；浅色 token 变动见 §10。

## 7. 无障碍前后统计

脚本：`ria-runs/.../scan-buttons2.cjs`（与评审同一启发式：`<button>` 去图标/插值后无文本即纯图标按钮）。

| 指标 | 改前 | 改后 |
|---|---|---|
| 纯图标按钮 | 106 | 106 |
| 无 aria-label | 103 | **0** |
| 既无 aria-label 也无 title | 34 | **0** |

其他：
- TabBar：`role="tablist"` + `role="tab"` + `aria-selected` + roving tabindex；Enter/Space 激活、←/→ 切换并聚焦下一个 tab，焦点有 `--focus-ring` 可见环（`TabBar.vue` 5/17/19/24/401/586 行）。
- 文件树：`role="treeitem"` + `aria-expanded` + roving tabindex + ↑↓←→ 移动/展开、Enter/Space 打开（`RightTreeNode.vue` 5-13/150 行），容器 `role="tree"`。
- 开关：10 处 `role="switch"`，焦点环移到可见的 track 上。
- 弹窗：PromptDialog `role="dialog" aria-modal="true"` + 打开自动聚焦。

## 8. i18n

- 现有 5 处硬编码：全部收进 locale（见 §3 A8）。
- 新增 key 已保证 en / zh-CN 齐平：`npm run i18n:check` → `i18n 校验通过：2 个语言文件，594 个 key，@ 转义与 key 齐平均正常`（EXIT=0）。
- 残留中文扫描（`scan-cjk.cjs`）结果均为**有意保留**：语言选择里的「中文（简体）」原生名、注入到网页上下文的 userscript `console.error` 文案（无 i18n 运行时）、`AcpAgentsPanel.vue` 的 `/auth|login|登录|认证/i` 匹配正则、以及发给 agent 的中文提示正文。

## 9. 检查与回归

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | EXIT=0（node + web 两个 tsconfig 均通过） |
| i18n 门禁 | `npm run i18n:check` | EXIT=0，594 key / 2 语言 |
| SFC 可编译 | `node ria-runs/.../check-sfc.cjs` | 46 个 .vue，0 错误（@vue/compiler-sfc parse + compileTemplate） |
| CSS 可解析 | `node ria-runs/.../check-css.cjs` | main.css OK（postcss） |
| 组件样式块 | `node ria-runs/.../check-sfc-styles.cjs` | 49 个 style 块，0 失败 |
| 模板语法 | 同上（compileTemplate） | 46/46 通过；过程中发现并修复 1 处 codemod 造成的按钮标签残缺（`SettingsTab.vue:94-103`） |
| 硬编码字号 | `grep -rn "font-size: *[0-9]*px"` | 1 处，仅 `main.css:3` 的 `--base-font-size` 基准值 |
| window.prompt | `grep` | 0 |
| 构建 | 未运行 | `npm run build` 会写 dist/，按工单禁止；用上面四项静态校验替代 |

未跑 GUI 端到端（无测试框架，且启动 Electron 需交互式窗口）。手工回归清单（建议在合并前人工过一遍）：

1. 文件树右键新建文件/文件夹、重命名：Enter 生效、Esc 取消、空名不提交、新建文件自动打开。
2. 单击/双击/右键已打开文件：不产生重复 tab，焦点正确。
3. 设置里字号 10→24 拖动：所有面板文字缩放、布局不塌、无横向滚动条。
4. 更新提示与通知同时出现：上下堆叠不遮挡；错误通知不自动消失、可手动关闭；hover 暂停计时。
5. 浅色/暗色 × 5 个 accent 预设：按钮文字、弱化文字、选中态可读。
6. 键盘：Tab 进入标签栏/文件树，方向键移动，Enter 打开，Esc 关闭对话框；焦点环可见。
7. 切换 zh-CN / en：界面文案、`<html lang>` 同步，无残留中文。

## 10. 本次改动文件清单

新增：
- `src/renderer/src/components/ui/PromptDialog.vue`
- `src/renderer/src/components/ui/ToastHost.vue`

修改（点对点，未整文件重写）：
`main.css`、`stores/settings.ts`、`App.vue`、`NotificationToast.vue`、`UpdateToast.vue`、`right/RightTreeNode.vue`、`right/FileTreeRight.vue`、`center/TabBar.vue`、`center/AcpChatTab.vue`、`center/WorkflowTab.vue`、`PluginManager.vue`、`center/BrowserPanel.vue`、`center/BrowserTab.vue`、`center/CenterPane.vue`、`ChatMessage.vue`、`right/PermissionCard.vue`（模板 aria 属性）、`ToolCallCard.vue`、`right/AcpAgentsPanel.vue`、`AcpSettingsSection.vue`、`SettingsTab.vue`、`LeftPane.vue`、`UserscriptsSettingsSection.vue`、`center/TerminalTab.vue`、`center/MarkdownPreview.vue`（仅字号 codemod）、`i18n/locales/en.json`、`i18n/locales/zh-CN.json`、`stores/browser.ts`、`stores/acp.ts`，以及 A1 顺带处理的 `WorkspaceModal.vue`、`HarnessSettingsSection.vue`、`AgentCommandsModal.vue`（aria/字号 codemod 触及）。

## 11. git status 前后对照

- 基线（开工前保存）：`ria-runs/session-32d28b75-cac1-4cf8-a3a8-20768741138a/baseline-ticket2-git-status.txt` = 64 条。
- 收尾：`git status --porcelain` = 73 条（含本报告文件）。
- 差集（新增 9 条：8 条代码改动 + 1 条本报告；基线条目无一条消失）：

```
 M src/renderer/src/components/HarnessSettingsSection.vue
 M src/renderer/src/components/WorkspaceModal.vue
 M src/renderer/src/components/center/MarkdownPreview.vue
 M src/renderer/src/components/center/TerminalTab.vue
 M src/renderer/src/components/center/acp/PermissionCard.vue
 M src/renderer/src/components/left/AgentCommandsModal.vue
?? src/renderer/src/components/ui/PromptDialog.vue
?? src/renderer/src/components/ui/ToastHost.vue
```

- 其余被改文件在基线中已处于 dirty 状态（属于他人未提交工作），本次只做行级最小增量，未回滚、未覆盖其改动。
- 无 `dist/`、无构建产物、无锁文件变化。

## 12. 风险与后续建议

1. **字号 10/24 极值**：布局宽高仍为固定 px，24px 时窄面板（如右侧树、工具栏）可能出现文字挤压；建议后续把侧栏宽度改为 `clamp()` 或按字号比例留白。已按要求只改字号、不动布局。
2. **Swatch 名称仍是静态英文**（settings 里的 Indigo/Emerald 等）：不影响功能，可后续收进 i18n。
3. **错误 toast 改为常驻**：需要用户手动关闭，若某类错误高频触发可能堆积；建议给同类错误做去重合并。
4. **暗色 accent 由 #5686fe 调深为 #3f6ae0**：按钮更有分量，若设计上更偏好原来的亮蓝，可改回并把按钮文字改成深色（需同步 `--text-on-accent`），但会牵动更多组件。
5. `index.html` 静态 `lang="en"` 只在挂载前存在；如需首帧正确，可在 index.html 里写死 zh-CN 或由 preload 注入。

## 附：本次使用的校验脚本（均在产物目录，可复跑）

- `contrast-verify-ticket2.cjs`：从 main.css 读取 token 计算 WCAG 对比度。
- `scan-buttons2.cjs`：纯图标按钮 / aria-label / title 覆盖统计。
- `check-sfc.cjs`：46 个 Vue SFC 的 parse + compileTemplate 校验。
- `check-css.cjs`：main.css 的 postcss 解析校验。
- `scan-cjk.cjs`：残留中文扫描。
