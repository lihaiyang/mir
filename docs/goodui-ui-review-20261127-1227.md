# mir 界面评审（goodui 视角）

- 评审对象：`mir`（Electron 桌面 IDE / 编码工作台），工作目录 `/Users/lihaiyang12/Documents/GitHub/mir`
- 评审依据：`/Users/lihaiyang12/.agents/skills/goodui/SKILL.md`（366 行），逐条对照 `## Rules`（第 35–46 行，8 条）与 `## Review checklist`（第 47–54 行，5 条），并用 `## Quick decisions`（第 20–33 行）作为控件语义的判定框架
- 评审方式：静态只读取证（读源码 + grep + 3 个一次性扫描脚本 + 1 个 Electron 行为探针）。**未修改任何源码、配置或锁文件，未安装依赖，未运行任何会写文件的构建/格式化/测试命令**；本次唯一新增文件是这份报告
- 评审时间：2026-11-27 12:27

## 0. 核心结论

**设计体系是这套代码里做得最好的部分**：`src/renderer/src/assets/main.css` 用 419 行搭出一套完整的语义 token——明暗两套（`:root` 1–129 行 / `[data-theme='light']` 131–193 行）、间距 4px 基准（79–84）、圆角（87–92）、三级阴影（95–98）、动效刻度（101–104）、键盘专用焦点环（107、229–233）、绝对字号刻度（110–122），连 diff/terminal/ANSI 都各有子色板（41–68、159–185）。硬编码色值只出现 3 处且两处在 token 文件里。**这套东西的设计水平明显高于它的工程执行水平。**

真正的问题集中在四处：

1. **无障碍几乎为空**：整个 renderer `aria-label` 出现 0 次、`tabindex` 0 次，106 个纯图标按钮无一个有无障碍名称（其中 35 个连 `title` 都没有）；标签栏和文件树的每一行都是不可聚焦的 `<div>`，键盘用户无法切换标签、无法浏览文件树。
2. **反馈层是最弱的一环**：通知 toast 与更新 toast 用同一个 `bottom:40px right:16px` 锚点互相遮挡；错误提示 4 秒自动消失；长文案单行省略截断（`nowrap + ellipsis`）且无 tooltip；容器没有任何 `aria-live`。
3. **「看起来能调、其实没接上」**：字号设置写入 `--base-font-size`，但全项目 0 处 rem/em，字号都是绝对 px，所以调了几乎不变；accent 预设只覆盖 3 个 token，焦点环、选中底色、`--text-accent` 仍停在默认蓝；浅色主题下直接套用深色调的预设色，amber 在白底只有 **2.15:1**。
4. **两个功能级问题**：文件树的「新建文件 / 新建文件夹 / 重命名」用 `window.prompt()`，Electron 44 已不支持，点了完全没反应；文件树的文件行单击也无任何反应（只有双击才打开），但光标是 pointer。

## 1. 技术栈与 goodui 适用性（先确认再评审）

### 1.1 UI 技术栈

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 框架 | Electron 44.3.0 + Vue 3.5.16（`<script setup>` 组合式 API） | `package.json:38-73` 依赖块；`src/renderer/src/main.ts`；renderer 共 44 个 `.vue` 组件 |
| 状态 | Pinia 2.3.1 | `package.json:38-73`；`src/renderer/src/stores/*.ts` |
| 国际化 | vue-i18n 9.14.4，zh-CN / en 两套 | `src/renderer/src/locales/zh-CN.json`、`en.json`（583 个 key） |
| 编辑器 / 终端 | Monaco 0.55、xterm 6、node-pty | `package.json:38-73` |
| 样式方案 | 手写 CSS：1 个全局 token 文件 + 每组件 scoped CSS | `src/renderer/src/assets/main.css`（419 行）；44 个 `.vue` 各自带 `<style scoped>` |
| **React / shadcn/ui / Tailwind / Radix** | **全部未使用** | 仓库无 `components.json`、无 `tailwind.config.*`、无 `postcss.config.*`；对全量依赖做 `tailwind|react|shadcn|radix|lucide|element-plus|naive|vuetify|ant-design` 匹配：**0 命中** |

**结论：mir 是 Electron + Vue 3 + 手写 CSS 的项目，不是 React + shadcn/ui 项目。** goodui 的组件安装类规则（130 个组件清单、`npx shadcn@latest add`、`tone` prop、`data-style` 风格包、`GooduiLocaleProvider`、`ms/me` 逻辑属性）在本项目里没有落点；可迁移的是它作为设计品味基准的判断项：层级、控件语义、色彩体系、动效克制、可访问性、留白与栅格、文案、状态覆盖。**下文不会把「没有使用 shadcn 组件」记成缺陷。**

### 1.2 适用性矩阵（Rules 8 条 + Checklist 5 条，逐条判定）

判定口径：**A** = 可直接适用；**B** = 部分适用（跨栈设计原则可执行，组件/API 层不适用）；**C** = 不适用（依赖 React/shadcn 机制或本项目不存在该场景）。

| # | 条目 | 判定 | 本项目落点 / 不适用理由与证据 |
| --- | --- | --- | --- |
| R1 | 颜色只来自主题 token 与 `tone` prop，不得 `bg-red-500` 这类硬编码 | **B** | token 化已做：`main.css:1-193` 定义 + 全项目 `var(--*)` 引用；tone prop 无对应（无组件 props 体系）。硬编码色值扫描：`.vue`/`.css` 中共 87 处十六进制，其中 81 处是 `main.css` 的 token 自身定义、5 处是 `SettingsTab.vue:393-397` 的色板常量、1 处是 `MarkdownPreview.vue:26` 的错误串内联 `color:#e55`。→ 真正的硬编码问题只有 1 处，见 §3.3 |
| R2 | 同屏至多 1 个循环动效；所有组件尊重 `prefers-reduced-motion` | **B** | 全项目 `prefers-reduced-motion` **0 命中**；`animation: ... infinite` 共 12 处（清单见 §3.4）。同屏可能出现多个 `spin`（多个 in_progress 工具卡同时转，`ToolCallCard.vue:13`） |
| R3 | 内置文案统一走 `GooduiLocaleProvider` + 语言包 | **C** | 本项目已用 vue-i18n（583 key，`scripts/i18n-check.mjs` 通过）；provider 是 React context 机制，Vue 无对应物也不需要。**但「内置文案不能硬编码」这条意图仍然适用且未达标**，记入 A8 |
| R4 | 布局用逻辑属性 ms/me/ps/pe，使 `dir="rtl"` 成立 | **C** | 产品只有 zh-CN / en 两个语言（`src/renderer/src/locales/`），无 RTL 场景；Electron 单窗口从不设置 `dir` |
| R5 | 真实元素：按钮就是 `<button>`；纯图标按钮必须有 `aria-label` | **B** | 完全适用且当前未达标：`aria-label` 0 次、106 个纯图标按钮（见 A1、§3.8） |
| R6 | `data-style` 风格包统管外观，不得用组件级覆盖对抗 | **C** | 无风格包机制；视觉风格由 `main.css` 一套 token 决定，不存在「预设风格 vs 组件覆盖」的冲突面 |
| R7 | UI 音效可选、默认关闭 | **C** | 桌面 IDE 无音效设计；goodui 自身也默认关闭，无落地需求 |
| R8 | 字体用 kit 字体，禁止引入 Inter/Geist/Google Fonts | **B** | 意图已满足：`@font-face` 0 命中、无 Google Fonts 引用，`--font-ui` 为系统栈含 PingFang SC（`main.css:124`）。kit 字体本身不适用 |
| C1 | 每个交互元素都是 goodui/shadcn 组件且只用文档化 props | **C** | 无 React/shadcn。等价诉求「基础控件应复用既定类而非就地手写」在本项目成立，且执行不到位（`UpdateToast.vue:133-155` 自造 `.btn`，`PermissionCard.vue:185-191` 内联拼一次性样式），记入 A8 |
| C2 | 无硬编码色值；`.dark` / 浅色两套都成立 | **B** | 硬编码色值仅 3 处（见 R1）；**浅色主题下有真实缺陷**：accent 预设不区分主题 + 派生 token 未随预设更新（A5、§3.3） |
| C3 | 同屏至多 1 个循环动效 | **B** | 同 R2 |
| C4 | 纯图标控件有 `aria-label`；非英文应用挂 `GooduiLocaleProvider` | **B / C** | 前半完全适用且未达标（A1）；后半见 R3 |
| C5 | 390px 宽无横向溢出 | **C** | 桌面应用，主窗口 `minWidth: 800, minHeight: 600`（`src/main/index.ts:347-348`），不存在 390px 视口 |

**可适用比例：13 条中 B = 7 条、C = 6 条、A = 0 条 → 约 54% 可跨栈执行，46% 与本项目技术栈无关。** 凡是 C 类，本文不再作为缺陷出现。


## 2. Review checklist 五条硬判定

| # | 条目 | 判定 | 依据 |
| --- | --- | --- | --- |
| 1 | 每个交互元素都是 goodui/shadcn 组件 | **不适用**（记为 C1） | 无 React/tailwind/components.json；等价诉求的执行情况见 A8 |
| 2 | 无硬编码色值；深浅两套都成立 | **部分不通过** | 硬编码色值仅 3 处（§3.3），深色主题对比度全部达标；**浅色主题 + accent 预设不成立**（A5，amber 白底 2.15:1） |
| 3 | 同屏至多 1 个循环动效 | **不通过** | 12 处 `infinite` 动画、0 处 `prefers-reduced-motion`（§3.4） |
| 4 | 纯图标控件有 `aria-label` | **不通过** | 全 renderer `aria-label` 0 次，106 个纯图标按钮（A1） |
| 5 | 390px 宽无横向溢出 | **不适用**（记为 C5） | 桌面窗口 `minWidth: 800`（`src/main/index.ts:347`） |

## 3. 分维度取证评审

### 3.1 视觉层级与信息密度

**骨架与分级**：`App.vue:3-41` 是「标题栏 / 三栏（左 + 分隔条 + 中 + 分隔条 + 右）/ 状态栏」结构；底色分四级——窗口 `--bg-primary`、侧栏与标题栏 `--bg-secondary`、悬浮层 `--bg-elevated`、凹陷编辑区/终端 `--bg-sunken`（`main.css:8-15`），配上 `--shadow-1..3`（95–98）的抬升层级，和 goodui 的 surface 分级是同一套思路，**这是全站最扎实的地方**。

**信息密度控制得克制**，三个正向范式：

- 工具调用折叠为单行：`ToolCallCard.vue:3-17` 一行内放下「展开箭头 + 工具类型图标 + 标题 + 状态图标 + 状态文案」，只有展开才渲染 diff/终端块（`:19-75`），diff 还有行数上限提示（`:57-59`）；
- 思考块默认折叠并标注体量：`ChatMessage.vue:35-46`（`Thinking` + `{count} chars`）；
- 命令面板「分组 + 高亮匹配 + 底部 kbd 提示 + 结果计数」：`CommandPalette.vue:14-39`。

**扣分项**：

| 问题 | 证据 |
| --- | --- |
| 微字号低于自定下限：`--text-xs` 是 12px（`main.css:110`），但 10px 用了 18 次、11px 用了 11 次（`scan-scale.cjs`，16 个文件） | `.agent-badge{font-size:10px}` `RightTreeNode.vue:186`；`.file-emoji{font-size:11px}` `RightTreeNode.vue:180` |
| 字号刻度存在但常被绕过：字面量 8px×1、10px×18、11px×11、12px×5、13px×8、14px×1、18px×2、20px×1、30px×1 | 同上扫描；对比 `main.css:110-122` 的 `--text-xs..xl`（12/13/14/15/17/19） |
| 三栏头部高度不成栅格：标题栏 38px、中栏标签条 40px、左栏面板头 36px、右栏面板头 32px、状态栏 26px | `TitleBar.vue:224`、`TabBar.vue:507`、`LeftPane.vue:749`、`RightPane.vue:80`（`SessionHeader.vue:320` 同为 32px）、`StatusBar.vue:419`。左右两栏同处一个水平线却差 4px，内容基线对不齐 |

### 3.2 控件语义（开关 / 复选框 / 下拉 / toast / 对话框）

**开关：外观对，语义错。** 10 个「即时生效的设置」都套了 switch 外壳（`.toggle` 包 `<input type=checkbox>` + `.toggle-track`），但没有 `role="switch"`，读屏会念成「复选框，已选中」：

- `SettingsTab.vue:126-129`（autoUpdate）、`:135-138`（showPanelIcons）、`:144-147`（markdownPreview）、`:320`、`:329`
- `AcpSettingsSection.vue:49-52`、`:60-63`、`:71-74`、`:81-84`
- 全项目 `role="switch"` 命中 0 次，`<input type=radio>` 0 个

goodui 的判定是「即时生效的开关不该用复选框」——它在意的是语义而不是配色，所以这里算**该改**（A3）。

**其余 5 个复选框是过滤器，用复选框合理**：`FileTreeRight.vue:8`（showHidden）、`SearchPanel.vue:7/10/13`（Aa / \b / .*）、`UserscriptsSettingsSection.vue:65`、`HarnessSettingsSection.vue:165`。

**原生 select 14 处**：`AcpSettingsSection.vue:37`、`AcpChatTab.vue:89`、`SessionHeader.vue:52/61/75/94`、`SettingsTab.vue:63/199`、`HarnessSettingsSection.vue:79/135/204`、`WorkflowTab.vue:41/46`、`AcpAgentsPanel.vue:188`。goodui 明确说「应用 UI 里不要原生 `<select>`」，但本项目没有 select 组件，且桌面端原生下拉的可用性/性能并不差 → 归入争议项 B5，不作为缺陷。

**反馈用 toast 而不是 alert：主路径做对了**（`NotificationToast.vue` 是全站统一通道）。但**破坏性确认全部依赖原生 `confirm()`**，共 8 处：`PluginManager.vue:146`、`TabBar.vue:438/446/456`、`CenterPane.vue:437`、`UserscriptsSettingsSection.vue:191`、`App.vue:415`、`RightTreeNode.vue:124`。原生 confirm 在 Electron 里可用且天然阻断，比自绘弹窗更安全，所以不列为缺陷；但项目已经有 `.modal-overlay/.modal` 基础设施（`main.css:327-365`，`FileTreeRight.vue:35-51` 在用），后续要统一视觉时应往这里靠。

**对话框**：`SettingsOverlay.vue:7-8` 是唯一声明了 `role="dialog"` + `aria-modal="true"` 的浮层；`CommandPalette.vue:2-3`（`cp-overlay/cp-modal`）与 `FileTreeRight.vue:35-36`（`modal-overlay/modal`）都没有角色声明，也没有焦点陷阱——命令面板靠自动聚焦输入框（`:4-13`）掩盖了这个问题，但 Esc 后焦点去向未定义。

**进度反馈不完整**：`PermissionCard.vue:90-97` 提交后只把按钮 disable，没有 spinner/loading 文案；`AcpChatTab.vue:108` 的 `createError` 是裸文本，没有图标也没有可关闭性。

### 3.3 色彩与 tone

**体系成熟度：高。** 419 行 token 文件里，语义色、diff 色、终端/ANSI 色各成子体系（`main.css:22-68`；浅色版 `131-193`），浅色主题连终端底色都专门挑过并写明对比度依据（`:163-164` 注释「All ANSI entries clear 5:1 on #e3e6ea」）。**硬编码色值只有 3 处**：`main.css` 内 81 处十六进制（就是 token 定义本身，合规）、`SettingsTab.vue:393-397` 的 5 个色板常量、`MarkdownPreview.vue:26` 错误串里的内联 `color:#e55`。这一点比绝大多数手写 CSS 的项目干净。

**实测对比度（WCAG 2.x，脚本见附录）**：

| 组合 | 比值 | 判定 |
| --- | --- | --- |
| 深色 text-primary / bg-primary | 18.19 | 达标 |
| 深色 text-secondary / bg-primary | 8.90 | 达标 |
| 深色 text-faint / bg-primary · bg-secondary · bg-hover | 5.13 · 4.83 · **4.06** | 主底达标，hover 底不达 AA |
| 深色 accent / bg-primary | 5.64 | 达标 |
| 浅色 text-secondary / bg-primary | 5.98 | 达标 |
| **浅色 text-faint / 白底 · #f8f9fb · #eef0f4** | **3.10 · 2.94 · 2.72** | **全部低于 AA 4.5**（`main.css:146`） |
| 浅色 accent / 白底 | 4.25 | 边缘（AA 差一点） |
| 白字压 `--accent #5686fe` | **3.37** | UI 组件 3:1 达标，正文 4.5 不达标（`main.css:32`；用于 `UpdateToast.vue:148-149`、`DiffTab.vue:232-233`、`AcpAgentsPanel.vue:980-981`、`:1108-1109`） |
| **预设 amber #f59e0b / 白底** | **2.15** | 浅色主题下不可用（`settings.ts:106` vs 浅色 accent `main.css:154`） |
| **预设 rose #f43f5e / 白底** | **3.67** | 同上不达 AA（`settings.ts:105`） |

**accent 预设只覆盖一半 token**（A5）：`settings.ts:112-121` 在选中预设时只写 `--accent`、`--accent-strong`、`--accent-soft` 三个变量，既不写 `--accent-ring`（`main.css:35` 定义，`:107` 的焦点环用它），也不写 `--text-accent`（`main.css:147` 浅色；文件夹图标 `RightTreeNode.vue:179` 用它）、`--bg-active`/`--bg-selected`（`main.css:13-14` 里是硬编码的 `rgba(86,134,254,…)`）。结果：切到 emerald/rose 之后，按钮变了色，但**焦点环、选中行底色、文件夹图标仍是默认蓝**。

**默认色板与真实默认不一致**：`SettingsTab.vue:393` 把 'default' 预览写成 `#3b82f6`，真实默认是 `#5686fe`（`main.css:32`）——用户看到的色板与实际结果不是一个颜色。

**语义色被当色板用（命名债，B6）**：`--text-danger` 被当背景（`main.css:393` `.btn-danger`）、`--text-success` 被当圆点填充（`SessionHeader.vue:331`、`AcpSettingsSection.vue:1226`、`AcpAgentsPanel.vue:1013`）、`--text-warning` 被当背景（`TitleBar.vue:260`、`TabBar.vue:585-588`、`LeftPane.vue:1007`）。视觉没错，但 token 命名与用途脱节，goodui 的 `tone` 概念（primary/neutral/success/warning/danger/info × 表面/文字）在这里缺失，等于每处都要自己记住「用 --text-* 当底色」。

**主题写入有两份真相（B7）**：`App.vue:2` 在 `.app` 元素上绑 `:data-theme`，`settings.ts:110` 又往 `document.documentElement` 写同名属性。目前两者同源不会打架，但一旦出现「根元素深色 + 局部浅色」或反向，就会互相覆盖。


### 3.4 动效与反馈

**动效刻度是克制的**：`--transition-fast: 120ms` / `--transition-base: 180ms` / `--ease-out: cubic-bezier(.22,1,.36,1)`（`main.css:101-104`）；按钮按下位移 0.5px（`:246`）；菜单/遮罩/弹窗入场 `menu-in`/`overlay-in`/`modal-in`（`:306`/`:338`/`:349`）；标签重排 160ms 只用 `transform`（`TabBar.vue:542-544`）。没有任何装饰性循环、没有 layout 抖动 —— 符合 goodui「入场与 hover 动效不受限」的口径。

**12 处 `animation: … infinite`（全部是加载/状态指示，不是装饰）**：

| 位置 | 用途 |
| --- | --- |
| `AcpChatTab.vue:567` `.spin` 1.1s、`PlanCard.vue:152`、`ToolCallCard.vue:414`、`WorkflowTab.vue:351` | 加载 spinner |
| `SessionHeader.vue:334` `pulse` 1.2s、`LeftPane.vue:1021/1024` `notify-pulse` 1.2s | 会话进行中/未读脉冲 |
| `AcpSettingsSection.vue:1230`、`AcpAgentsPanel.vue:1017/1150` `acp-pulse` 1s | 连接状态点 |
| `ChatMessage.vue:276` `caret-blink` 1s steps(2) | 流式光标 |
| `BrowserPanel.vue:1121` `bp-spin` .7s | 浏览器加载 |

判定：**语义上都站得住**（都是「正在进行」的必要指示），不按「装饰循环」记缺陷；但两个硬缺口成立——(a) 全项目 **`prefers-reduced-motion` 0 命中**，前庭敏感用户无法关掉；(b) 同屏可能同时出现多个循环（多张 `in_progress` 工具卡各自带 `spin`，`ToolCallCard.vue:13`，叠加会话头 `pulse` 与左栏 `notify-pulse`），违反 checklist「至多 1 个循环动效」的字面要求。

**反馈链路是全局最弱的一环**（错误提示与普通提示混在一起时尤其明显）：

| 问题 | 证据 |
| --- | --- |
| 错误提示 4 秒自动消失，与普通提示同寿命 | `NotificationToast.vue:44` `show(type, text, duration = 4000)` 对 `error` 一视同仁 |
| 计时器不因 hover/聚焦暂停 | `NotificationToast.vue:47-49` 裸 `setTimeout` |
| 长文案被单行截断且无 tooltip | `NotificationToast.vue:91` `max-width: 380px` + `:124` `white-space: nowrap; text-overflow: ellipsis` |
| 容器没有可播报语义 | `NotificationToast.vue:3-16` 无 `role="status"` / `aria-live` |
| 整卡可点击关闭，误触即丢失 | `NotificationToast.vue:10` 卡片 `@click` 直接关闭 |
| **两套 toast 同锚点互相遮挡** | `NotificationToast.vue:66-69`（`bottom:40px; right:16px; z-index:1000`）与 `UpdateToast.vue:102-104`（同锚点，`z-index:9999`） |

### 3.5 留白与对齐栅格

间距刻度是标准的 4px 基准 6 档（`main.css:79-84`），实际使用 `var(--space-*)` 153 次、`var(--radius-*)` 208 次 —— 刻度确实在用。但**绕过率同样高**：字面量 `gap` 167 次 vs `gap: var(--space-*)` 61 次，字面量 `border-radius` 31 次（`scan-scale.cjs`）。刻度成了「可选工具」而非「唯一来源」。

具体错位（都能直接看见）：

| 问题 | 证据 |
| --- | --- |
| 同层级文件行比文件夹行左移 2px：箭头占位 14px，文件占位 12px | `RightTreeNode.vue:170` `.node-arrow{width:14px}` vs `:171` `.node-no-arrow{width:12px}`，缩进本身是 `depth*12+6`（`:5`） |
| 同一工具栏内图标尺寸不一致：15px 与 18px 并排 | `FileTreeRight.vue:16` `:size="15"` vs `:17` `:size="18"` |
| 左/右面板头内边距策略不同 | `LeftPane.vue:750` `padding: 8px 10px 4px 18px` vs `RightPane.vue:80` 只给 `height: 32px` |
| 两处空态质感差一个档次 | `CommandPalette.vue:30-32` 只有一行文本；`AcpChatTab.vue:17-39` 有图标 + 标题 + 提示 + 快捷命令 chips |

分栏使用固定 px 宽 + 分隔条（`App.vue:7`/`:12`/`:20`/`:25`），这是桌面 IDE 的常规做法，不按「不符合响应式栅格」记问题。

### 3.6 文案

**i18n 基建达标**：zh-CN / en 两套共 583 个 key，`scripts/i18n-check.mjs` 通过；独立脚本核对「代码里实际用到的 495 个 key」，**0 缺失、88 个未使用**。

**硬编码用户可见文案 5 处**（都是绕过 i18n 的漏网之鱼）：

| 文案 | 位置 | 性质 |
| --- | --- | --- |
| `title="Show hidden files"` | `FileTreeRight.vue:7` | 中文界面里的英文 tooltip（同组件其它文案都走 `$t`） |
| `'浏览器'` | `stores/browser.ts:74` | 硬编码中文（项目名） |
| `浏览器 ${idx}` | `stores/browser.ts:157` | 硬编码中文（标签名） |
| `'已取消本轮'` / `本轮结束：${stopReason}` | `stores/acp.ts:353` | 硬编码中文（会话通知） |
| `──── 上次会话 ────` | `TerminalTab.vue:121` | 硬编码中文（终端分隔线） |

**「中文标签套英文排版手法」（B2）**：16 处 `text-transform: uppercase` 且几乎都配 `letter-spacing: 0.05–0.12em`（`AcpSettingsSection.vue:910/1038`、`CommandPalette.vue:185`、`SettingsTab.vue:573`、`LeftPane.vue:760`、`FileTreeRight.vue:169`、`SearchPanel.vue:342`、`GitPanel.vue:482`、`AcpChatTab.vue:454`、`BrowserPanel.vue:1368`、`StatusBarPicker.vue:226`、`HarnessSettingsSection.vue:859`、`CenterPane.vue:564`、`WorkflowTab.vue:325`、`AcpAgentsPanel.vue:865/1197`）。英文下这是标准的小型大写标签；中文下 `uppercase` 空转，`0.06em` 字距却真实生效，把「文件」「搜索」「Git」这类两字标签撑散。

**语言标签不跟随**：`src/renderer/index.html:2` 写死 `<html lang="en">`，全项目无任何代码更新它（`documentElement` 只被写过 `data-theme`，`settings.ts:110`）→ 切到中文后，读屏仍按英文发音，字体回退也按英文规则选字。

### 3.7 空态 / 错误态 / 加载态

扫描 44 个组件的 template：**13 个有空态标记、10 个有 loading/spinner/skeleton、15 个有 error 相关标记**（外壳类组件 App/TitleBar/StatusBar 本不需要，不扣分）。

**做得好的**：`AcpChatTab.vue:17-40` 空态（图标 + agent 名 + 引导语 + slash 命令 chips 可直点填充输入框）；`:6-9` 加载 banner（spinner + 文案）；`:78-109` 「标签页没有会话」状态（选 agent + 开始会话 + 打开面板 + 失败原因），这是全站最完整的一套状态设计。

**缺的**：

| 问题 | 证据 |
| --- | --- |
| 文件树只有「未打开项目」一个空态；目录为空 / 读取失败时渲染 0 行 → 一片空白，无提示、无 loading、无 error 分支 | `FileTreeRight.vue:3`（唯一空态）与 `:19-31`（`v-for` 直出）；全组件 template 无 loading/error |
| 无骨架屏体系，列表类界面切换项目时是空白等待 | 全项目 `skeleton` 0 命中（`scan-tone-states.cjs`） |
| 权限卡提交后无 submitting 态，只有按钮 disable | `PermissionCard.vue:90-97` |
| Markdown 渲染失败把英文 + 硬编码色的 HTML 直接注入正文 | `MarkdownPreview.vue:26` `'<p style="color:#e55">Render error</p>'` |

### 3.8 可访问性

**统计基线**（对整个 `src/renderer/src` grep）：`aria-label` **0 次**、`tabindex` **0 次**、`role="…"` **5 次**（`AcpSettingsSection.vue:8` tablist、`:13` tab、`SettingsOverlay.vue:7` dialog、`ChatComposer.vue:4` listbox、`:11` option）、`aria-*` **5 次**（`SettingsOverlay.vue:8` aria-modal、`:53` aria-hidden、`ChatMessage.vue:30` aria-hidden、`ChatComposer.vue:12` aria-selected、`ui/Icon.vue:14` aria-hidden）。把全局图标统一标 `aria-hidden` 是正确做法。

| 问题 | 证据 |
| --- | --- |
| **106 个纯图标按钮，0 个有无障碍名称**；其中 35 个连 `:title` 都没有 | `scan-buttons2.cjs` 扫描结果；典型：`TitleBar.vue:27/28/29`（后退/前进/刷新）、`TabBar.vue:38`（关闭标签）、`:70`（更多菜单）、`BrowserTab.vue:5/6/7`、`BrowserPanel.vue:237/314/315/316`、`NotificationToast.vue:14`（关闭通知）、`ToolCallCard.vue:3`、`ChatMessage.vue:36` |
| **标签栏不可键盘操作**：每个标签是 `<div>`，只有 `@mousedown`/`@click`/`@contextmenu`，无 `role`/`tabindex`/`keydown` | `TabBar.vue:14` |
| **文件树不可键盘操作**：行是 `<div>`，无 `tabindex`/`role`；且单击只对目录有效（`:87-93`），文件必须双击（`:95-99`） | `RightTreeNode.vue:3-9`、`:87-99`、`:164` `cursor:pointer` |
| **开关的键盘焦点不可见**：```input``` 被压成 `width:0;height:0;opacity:0`，而全局焦点环是 `box-shadow` 环，落在 0 尺寸元素上等于消失 | `SettingsTab.vue:761-766` + `main.css:229-233` |
| 输入框只有 placeholder，没有 label | `ChatComposer.vue:43-53`（placeholder 来自 `:145-147`）、`CommandPalette.vue:4-13`；`SettingsTab.vue:107-118` 的 `.row-label` 与输入框无 `for/id` 关联 |
| 对比度（浅色 `--text-faint` 2.72–3.10、白字压 accent 3.37） | `main.css:146`/`:32`，完整表见 §3.3 |
| toast 不播报 | `NotificationToast.vue:3-16` 无 `aria-live`/`role="status"` |


## 4. 三类归档

### a) 明确违反且该改（10 条）

| ID | 问题 | 证据 | 建议改法 |
| --- | --- | --- | --- |
| **A1** | 纯图标按钮没有无障碍名称 | 全 renderer `aria-label` 0 次；106 个纯图标按钮 0 个有名称，35 个连 `:title` 都没有（`scan-buttons2.cjs`）；例：`TitleBar.vue:27/28/29`、`TabBar.vue:38/70`、`NotificationToast.vue:14` | 给 `.icon-btn` 统一加 `aria-label`（复用现有 i18n key 或新增 `common.close`/`titlebar.back` 这类），`:title` 保留给人做 tooltip；可先批量补 35 个既无 label 也无 title 的 |
| **A2** | 标签栏与文件树整体不可键盘操作 | `TabBar.vue:14` 标签是 `<div>`（仅 mousedown/click/contextmenu，无 role/tabindex/keydown）；`RightTreeNode.vue:3-9` 树行同样是 `<div>` | 标签改 `role="tab"` + `tabindex` + 左右键/Enter/Delete 处理（或直接换成 `<button>`）；树行加 `role="treeitem"` + `tabindex` + 上下键/Enter/空格 |
| **A3** | 开关语义错误且键盘焦点不可见 | 10 个开关是 `<input type=checkbox>` 无 `role="switch"`（`SettingsTab.vue:126-138/144-147/320/329`、`AcpSettingsSection.vue:49-84`）；input 被压成 0×0（`SettingsTab.vue:761-766`），而焦点环是 0 尺寸元素上的 `box-shadow`（`main.css:229-233`） | 加 `role="switch"`；把焦点可视化挪到轨道上：`.toggle input:focus-visible + .toggle-track { box-shadow: var(--focus-ring) }` |
| **A4** | 浅色主题的次要文字对比度不足 | `--text-faint: #8b93a0`（`main.css:146`）在白底 3.10、`#f8f9fb` 2.94、`#eef0f4` 2.72，均低于 AA 4.5；深色同 token 5.13/4.83 达标 | 浅色 `--text-faint` 调到 `#6b7380` 一带（白底约 4.6）；或把它限制在装饰性场景，正文/说明改用 `--text-secondary` |
| **A5** | accent 预设只覆盖 3 个 token，且不区分主题 | `settings.ts:112-121` 只写 `--accent`/`--accent-strong`/`--accent-soft`；`--accent-ring`（`main.css:35`，焦点环 `:107` 在用）、`--text-accent`（`:147`）、`--bg-active`/`--bg-selected`（`:13-14` 硬编码 rgba(86,134,254,…)）不跟随。预设色本身是深色调（`settings.ts:103-106`），套到浅色主题：amber 白底 **2.15:1**、rose **3.67:1** | `ACCENT_MAP` 拆成 dark/light 两组；并把 ring/selected/text-accent 一起派生（或用 `color-mix` 从 `--accent` 统一算） |
| **A6** | `<html lang>` 永远是 `en` | `src/renderer/index.html:2`；全项目只有 `data-theme` 被写（`settings.ts:110`），`lang` 无人更新 | 在 locale 变化处加一行 `document.documentElement.lang = locale.value` |
| **A7** | 反馈层行为不可靠 | 错误也是 4s 自动消失（`NotificationToast.vue:44`）、计时不暂停（`:47-49`）、长文案 nowrap 截断（`:91`/`:124`）、整卡可点关闭（`:10`）、容器无 `aria-live`（`:3-16`） | error 类型改为常驻（手动关闭），其它类型 hover 暂停；文本允许两行 + `title` 兜底；容器加 `role="status" aria-live="polite"`；关闭区只留右上角按钮 |
| **A8** | 5 处用户可见文案绕过 i18n | `FileTreeRight.vue:7`（英文 title）、`stores/browser.ts:74`、`:157`、`stores/acp.ts:353`、`TerminalTab.vue:121` | 全部改走 `t()`；`browser.ts` 的名称改为存储「为用户标签」而非拼接中文 |
| **A9** | 同一件东西有 4 套按钮实现 | `main.css:366-404`（`.btn-primary/.btn-secondary/.btn-danger`）、`AcpChatTab.vue:550-555`（`.chat-primary-btn`）、`WorkflowTab.vue:255-259`（`.wf-btn-primary`）、`PluginManager.vue:280`（`.pm-btn-primary`）、`UpdateToast.vue:133-155`（自造 `.btn/.btn.primary` 并覆盖 hover/disabled） | 统一到 `main.css` 的 3 个基础类；确有场景差异时只加 size 修饰类，不再复制整套声明 |
| **A10** | 同一层级内 2px/3px 级错位 | 文件行比文件夹行左移 2px（`RightTreeNode.vue:170` 14px vs `:171` 12px）；同一工具栏 15px 与 18px 图标并排（`FileTreeRight.vue:16/17`）；左栏头 36px vs 右栏头 32px（`LeftPane.vue:749` vs `RightPane.vue:80`） | 箭头占位统一 14px（无箭头也保留同宽占位）；工具栏图标统一 16px；左右面板头统一高度或统一 padding 策略 |

### b) 有争议 / 取决于设计取向（8 条）

| ID | 事项 | 证据 | 取舍 |
| --- | --- | --- | --- |
| **B1** | 消息时间只能 hover 才出现 | `ChatMessage.vue:2` `:title="timeLabel"` 挂在整行 | 静默阅读 vs 时间可发现性。一个会话里多次来回后，用户想核对「这条是什么时候的」只能靠悬停猜。建议折中：hover 时在气泡角落淡入时间，而不是依赖原生 tooltip |
| **B2** | 中文标签套用 `uppercase` + 0.05–0.12em 字距 | 16 处，见 §3.6 | 英文的「小型大写标签」是很专业的做法，但中文下 `uppercase` 无效、字距把两字标签撑散。建议用 `:lang(en)` 限定，中文下把字距归零 |
| **B3** | 权限卡里「总是允许」与「仅这一次」视觉完全相同 | `PermissionCard.vue:185-191` 两个 allow 共享同一段反白强调样式；reject 是弱化三级样式（`:172-183`、`:198`），X 关闭等于拒绝（`:3-11`、`:112-125`） | 效率 vs 误授权风险。「总是允许」是不可逆授权，与其他动作同等强调会推高误点率。建议把 allow_always 降为次级（描边），或在按钮上明写作用域（「总是允许（本项目）」） |
| **B4** | 10–11px 微字号广泛使用 | 10px×18 处、11px×11 处（`scan-scale.cjs`），如 `.agent-badge`(`RightTreeNode.vue:186`)、`.file-emoji`(`:180`) | 桌面 IDE 的高信息密度传统 vs 可读性。中文 10px 在非 Retina 屏上明显偏小；建议最小 11px 且只用于装饰性角标 |
| **B5** | 14 处原生 `<select>` | 见 §3.2 列表（`SessionHeader.vue:52/61/75/94` 最集中） | goodui 主张 app UI 不用原生 select；但桌面端原生下拉有系统级可用性（键盘、输入法、长列表性能），自绘成本高。建议只在「设置面板」这类高频可见处替换，聊天工具栏保留原生 |
| **B6** | 语义色被当色板填充用 | `--text-danger` 作背景（`main.css:393`）、`--text-success` 作圆点填充（`SessionHeader.vue:331` 等）、`--text-warning` 作背景（`TabBar.vue:585-588` 等） | 视觉上没问题，是命名债。建议后续新增 `--tone-danger-bg`/`--tone-success-bg` 这类表面色 token，命名与用途对齐 |
| **B7** | 主题有两处写入源 | `App.vue:2` `:data-theme` 绑在 `.app`；`settings.ts:110` 写到 `documentElement` | 目前同源不打架；若将来要支持「局部反色」（如深色界面里嵌浅色预览）就会冲突。建议只保留 `documentElement` 一处 |
| **B8** | 白字压在 accent 上只有 3.37:1 | `main.css:32` + `.btn-danger`/`UpdateToast`/`DiffTab`/`AcpAgentsPanel` 的用法（见 §3.3） | UI 组件的 3:1 标准达标，正文的 4.5:1 不达标。若这些按钮文案都是 12–13px 常规字重，严格说不够；加深 accent 或把按钮文案提到 14px/600 都能解决，取哪个取决于品牌强度 |

### c) 不适用（6 条，及具体理由）

| ID | goodui 条目 | 为什么本项目用不上 |
| --- | --- | --- |
| **C1** | 「每个交互元素都是 goodui/shadcn 组件，只用文档化 props」 | mir 无 React、无 Radix、无 Tailwind、无 `components.json`／`tailwind.config.*`／`postcss.config.*`，依赖里 `react|radix|tailwind|shadcn` 全部 0 命中。goodui 的 130 个组件是 `.tsx`，通过 `npx shadcn add` 拷进 `components/goodui/`，无法在 Vue SFC 里使用。**等价诉求**（基础控件复用既定实现）已在 A9 按跨栈口径记录 |
| **C2** | `GooduiLocaleProvider` + locale 语言包 | 本项目已用 vue-i18n（583 key、2 语言、`scripts/i18n-check.mjs` 通过）；provider 是 React context + `lib/goodui-locale` 的实现，Vue 侧无对应物，也不缺这套能力。**意图**（内置文案不硬编码）已在 A8 记录 |
| **C3** | 逻辑属性 `ms/me`/`ps/pe`，支持 `dir="rtl"` | 产品只有 zh-CN 与 en 两个 locale（`src/renderer/src/locales/`），无 RTL 语言；Electron 单窗口从不设置 `dir`，写逻辑属性不会产生任何用户可见差异 |
| **C4** | `data-style="brutal|glass|retro98|…"` 风格包 | 本项目外观由 `main.css` 一套 token 决定，没有「多套风格预设互斥覆盖」的机制，也不存在需要防守的组件级对抗 |
| **C5** | UI 音效（`sound` prop / `lib/goodui-sounds`） | 桌面 IDE 没有音效设计，goodui 自身也默认关闭；引入需要额外资源与开关，与当前产品定位无关 |
| **C6** | 390px 宽无横向溢出 | 桌面应用，主窗口 `minWidth: 800`、`minHeight: 600`（`src/main/index.ts:347-348`），不存在 390px 视口；横向溢出风险应改按「最小窗口 800×600」评估 |


## 5. 功能级问题（影响可用性，不属于视觉建议）

> 本章只收「功能受损」的问题：控件点不动、操作没反应、信息被遮挡或截断、设置项不生效。检查方式是静态阅读事件绑定与布局约束 + 一个 Electron 行为探针；**本次未启动应用做真实点击/键盘走查**（只读评审，不运行构建），因此以下结论来自代码路径分析，而非实测截图。

### BUG-1 文件树的「新建文件 / 新建文件夹 / 重命名」完全不工作

- **表现**：右键文件树任意节点 → 建文件 / 建文件夹 / 重命名，点了**没有任何反应**：不弹窗、不报错、文件系统无变化。
- **触发路径**：`RightTreeNode.vue:101-114` `showNodeMenu` → `:108`/`:109` `createHere(false/true)`、`:110` `renameNode`。
- **根因**：这两个函数用 `window.prompt()` 取名字——`RightTreeNode.vue:131` `const name = prompt(isDir ? t('fileTree.folderName') : t('fileTree.fileName'))`、`:149` `const newName = prompt(t('fileTree.newName'), props.node.name)`。**Electron 已不支持 `window.prompt()`**，调用直接抛异常；两处都没有 `try/catch`，函数是 `async`、由菜单 action 调用，抛出的 rejection 无人处理 → 静默失败。
- **证据**：探针 `ria-runs/session-32d28b75-cac1-4cf8-a3a8-20768741138a/probe-prompt.cjs`，在本仓库的 Electron 44.3.0 下执行，输出：
  ```
  PROMPT_RESULT={"threw":true,"error":"Error: prompt() is not supported."}
  ```
- **修复方向（成本极低）**：同一个功能、同一棵树的父组件里已经有一个可用的模态实现——`FileTreeRight.vue:35-51` 的 `newItemDialog`（标题 + 输入框自动聚焦 + Enter/Esc + 取消/创建按钮）。把 `createHere` 改为打开该对话框（或把对话框提到 tree 组件共用），`renameNode` 复用同一模式的改名对话框即可。
- **不受影响的部分**：`deleteNode`（`RightTreeNode.vue:124`）用的是 `confirm()`，Electron 支持；另外 7 处 `confirm()`（`PluginManager.vue:146`、`TabBar.vue:438/446/456`、`CenterPane.vue:437`、`UserscriptsSettingsSection.vue:191`、`App.vue:415`）同样正常。所以症状是「删除能用，新建/改名不能用」，更容易让人以为是权限问题。

### BUG-2 文件树单击文件无任何反应

- **表现**：文件行有 `cursor: pointer`（`RightTreeNode.vue:164`）和 hover 底色（`:169`），但单击后**不打开、不选中、没有任何高亮**；只有双击才会打开编辑器。
- **根因**：事件处理不对称。整行只绑了 `@click="handleClick"`（`:6`）与 `@dblclick="handleDblClick"`（`:7`）；而 `handleClick`（`:87-93`）对文件直接 `return`：

  ```ts
  function handleClick(e: MouseEvent) {
    if (!props.node.isDirectory) return   // 文件：什么都不做
    ...
  }
  ```

  真正打开文件的是 `handleDblClick`（`:95-99`）。同时组件里**没有选中状态**（没有 `selectedPath`，样式里也没有 `.is-selected`），所以单击连视觉反馈都没有。
- **影响**：这是文件树最高频的交互面。「看起来能点、点了没反应」比「样式难看」更伤信任，也是新用户第一次用就会撞上的坑。
- **修复方向**：单击 = 选中（引入 `selectedPath` + `.is-selected` 底色，顺带为 A2 的键盘操作提供落点），双击 = 打开；或按 VS Code 习惯单击直接打开预览。

### BUG-3 「界面字号」设置几乎不生效

- **表现**：设置 → 通用 → 界面字号（数字框 10–24），改数值后界面文字**基本不变**；只有极少数没有显式写 `font-size` 的元素跟着变。
- **证据链**：`SettingsTab.vue:111-117`（`<input type="number" min="10" max="24">`，无单位、无 step）→ `settings.ts:111` `setProperty('--base-font-size', …)` → 但整个 renderer 里只有 `main.css:205`（body）读这个变量；全项目 `rem`/`em` 使用数为 **0**，`--text-xs..xl` 是绝对 px（`main.css:110-122`），组件里也普遍写 px（10–30px 共 50 余处，见 `scan-scale.cjs`）。
- **根因**：字号体系是「绝对 px 刻度」，而设置项按「根字号缩放」的思路实现——两套机制根本不咬合。
- **修复方向**：二选一。(a) 诚实版：把设置项改成 compact / comfortable / large 三档，直接换 `--text-*` 刻度值；(b) 彻底版：全站 px → rem（含组件内联字号），让 `--base-font-size` 真正生效。同时给输入框补单位与步长。

### BUG-4 两套 toast 互相遮挡 + 长通知被截断

- **表现 A（遮挡）**：应用更新提示出现时，右下角的更新卡片正好压住通知卡片的位置（更新卡片在上层），错误提示被盖住。
- **根因 A**：两个独立组件各自 `position: fixed` 抢同一块屏幕区域——`NotificationToast.vue:66-69`（`bottom: 40px; right: 16px; z-index: 1000`）与 `UpdateToast.vue:102-104`（同样的 `bottom: 40px; right: 16px`，`z-index: 9999`）。`App.vue:35-36` 同时挂载两者，却没有共享堆叠容器。
- **表现 B（信息丢失）**：通知文本强制单行——`NotificationToast.vue:91` `max-width: 380px`、`:124` `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`，也没有 `title` 或展开入口。带路径的 i18n 错误（如「打开文件失败：/Users/…/xxx.ts」）会被截成省略号，用户看不到真正原因。
- **修复方向**：建立单一 toast 容器（在 `App.vue` 里放一个 host，更新提示作为其中一种 item，或改锚到标题栏下方）；通知文本允许两行并用 `title` 兜底。这与 A7 是同一处改动，建议合并做。

### 检查范围与未覆盖

- **已检查**：布局裁剪与固定尺寸约束（ellipsis/overflow/固定宽高）、事件绑定是否有死区（click vs dblclick vs mousedown）、状态同步兜底（`AcpChatTab.vue:78-109` 的失效标签页、主题双写 B7）、控件可见尺寸与命中区域。
- **未检查（如实说明）**：没有启动应用做真实鼠标/键盘走查；没有跑 axe/Lighthouse（Electron 无该链路）；未覆盖主进程窗口行为（`src/main/index.ts`）、插件子系统（`src/renderer/src/plugins`）与 webview 内网页。

## 6. 优先级改进清单（按「影响用户程度 × 改动成本」排序，10 条）

| # | 改什么 | 动哪里 | 为什么值得先改 |
| --- | --- | --- | --- |
| 1 | 修好文件树的新建/改名（BUG-1） | `RightTreeNode.vue:129-154` 改为复用 `FileTreeRight.vue:35-51` 的已有对话框 | 核心功能「点了完全没反应」，而可用的对话框就在同一个功能的父组件里，几乎是接线工作 |
| 2 | 让文件行单击有反应（BUG-2） | `RightTreeNode.vue:87-99` + `.tree-node` 加选中态样式 | 最高频的交互面，现在单击像卡死；改动只是两个函数加一条样式 |
| 3 | 给全部纯图标按钮补无障碍名称（A1） | 各组件的 `.icon-btn`；优先补 35 个连 `title` 都没有的（`TitleBar.vue:27-29`、`TabBar.vue:38/70`、`NotificationToast.vue:14` 等） | 机械但量大，是「从完全没有到有」的最大单点收益，也让后续可访问性改动有基线 |
| 4 | 标签栏与文件树接入键盘（A2） | `TabBar.vue:14`、`RightTreeNode.vue:3-9` 改语义元素 + 键位处理 | 键盘用户现在完全无法切换标签、无法浏览文件树，属于能力缺失而非体验瑕疵 |
| 5 | accent 预设派生全部相关 token 并分主题取值（A5） | `settings.ts:102-121`（`ACCENT_MAP` 拆 dark/light，`applyTheme` 一并更新 ring/selected/text-accent） | 主题色是可感知的显性功能，现状是「换色只换一半」；浅色主题下 amber 只有 2.15:1，等于不可用 |
| 6 | 提高浅色主题的次要文字对比度（A4） | `main.css:146` `--text-faint` | 一行改动，一次消掉浅色主题所有说明性文字的 AA 不达标问题 |
| 7 | 开关补 `role="switch"` 与可见焦点（A3） | `SettingsTab.vue:126-147`、`:761-795`、`AcpSettingsSection.vue:49-84` | 10 个设置项共用一套改法；顺带修掉「Tab 到开关完全看不出焦点」 |
| 8 | 反馈层一次性收口（A7 + BUG-4） | `NotificationToast.vue:3-16/44-49/66-69/91/124`、`UpdateToast.vue:102-104/133-155` | 错误被 4 秒吞掉、被截断、被更新提示盖住——三件事是同一个组件的同一处改造，分开做会重复返工 |
| 9 | 字号设置二选一：真生效或降级为档位（BUG-3） | `settings.ts:111`、`SettingsTab.vue:107-118`（或全站 px→rem） | 「调了没用的设置项」比没有这个功能更伤信任，而且它现在会让人怀疑其它设置是否也没接上 |
| 10 | 一批低风险一致性清理（A6/A8/A9/A10） | `index.html:2` 的 `lang`、5 处硬编码文案、4 套按钮实现、12/14px 与 15/18px 的对齐 | 单条影响都小，但都是「顺手改完就再也不回来」的账，合并成一个 chore 提交最经济 |

**没有进 top10 的项**：B1（时间戳 hover）、B2（中文 uppercase/字距）、B3（权限卡权重）、B4（10–11px）、B5（原生 select）、B6（语义色命名债）、B7（主题双写）、B8（白字压 accent）——这些都属于「有明确取舍、需要先定设计取向」的项，价值真实但不够紧急，等上面 10 条落地后再按取向决定。


## 7. 附录：取证方法与只读声明

### 7.1 取证手段

1. **完整读取评审依据**：`/Users/lihaiyang12/.agents/skills/goodui/SKILL.md` 全文 366 行，其中 `## Rules`（35–46）、`## Review checklist`（47–54）、`## Quick decisions`（20–33）逐条抄录进 §1.2 适用性矩阵与 §2 硬性判定，不含凭印象的转述。
2. **静态阅读**：`src/renderer/src/assets/main.css`（419 行设计令牌与全局样式）、`src/renderer/src/stores/settings.ts`、4 个 shell 组件（`App.vue` / `TitleBar.vue` / `TabBar.vue` / `StatusBar.vue`）、3 个面板容器与各功能区组件；共 44 个 `.vue` 模板纳入状态覆盖统计。
3. **一次性扫描脚本**（均落在产物目录 `ria-runs/session-32d28b75-cac1-4cf8-a3a8-20768741138a/`，只读、不改仓库）：
   - `scan-scale.cjs` —— 字号/间距/圆角的字面量 vs 令牌变量使用比例
   - `scan-buttons.cjs` / `scan-buttons2.cjs` —— 纯图标按钮与其 `aria-label` / `title` 覆盖情况
   - `scan-contrast.cjs` —— 按 WCAG 相对亮度公式计算深浅两套主题的对比度
   - `check-i18n-keys.cjs` —— `t()` 实际使用的 key 与语言文件之间的差集
   - `scan-tone-states.cjs` —— tone 色被当作背景/圆点使用的位置、空态/加载态/错误态覆盖
4. **行为探针**：`probe-prompt.cjs` —— 在本仓库的 Electron 44.3.0 下实测 `window.prompt()`，用于坐实 BUG-1 的根因（输出见 §5 BUG-1）。
5. **未使用运行时工具**：没有启动应用做真实鼠标/键盘走查，没有跑 axe / Lighthouse（Electron 无该链路）。因此本报告的 bug 结论来自代码路径与行为探针，而非点击实测；§5 已就此显式声明范围。

### 7.2 只读声明与基线对比

开工前 `git status --short` 记录为 **63 条**（已存档于 `ria-runs/session-32d28b75-cac1-4cf8-a3a8-20768741138a/baseline-git-status.txt`），其中包含仓库原有的已修改跟踪文件与未跟踪文件，**均为评审前既有状态，本次评审未触碰、未回滚、未处理**。

评审完成后再次执行 `git status --short`，共 **64 条**；与基线的差集只有一行：

```
56a57
> ?? docs/goodui-ui-review-20261127-1227.md
```

即：**除本报告这一个新增文件外，仓库没有任何新增改动**。全程未执行 `git checkout`、`git clean`、`git stash`、任何提交操作、任何依赖安装、任何会写文件的构建/格式化/测试命令。

### 7.3 证据可信度说明

- §1.2 与 §2 的判定直接来自 skill 原文；§3–§5 的每条结论都带「文件路径:行号」，数值类结论（对比度、计数、比例）由上述脚本产出，可重跑复核。
- 对无法坐实的事项（例如「每个组件在深浅两套主题下是否都成立」需要逐组件切换验证）本报告不做断言，只给出可验证的令牌与对比度结论。
- 三处带主观成分的判断已显式归入 B 类（有争议）而非 A 类（该改）：§4-B1 时间戳仅 hover 可见、§4-B2 中文标签使用 uppercase + 字距、§4-B3 权限卡片按钮权重。取证只能证明现状，不能证明是缺陷。
