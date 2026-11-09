# MIR 接入 ACP（Agent Client Protocol）客户端能力 — 设计方案

> 状态：已实施（M1–M6）
> 参考实现：`formulahendry.acp-client` 0.2.0（VS Code 扩展，`/Users/lihaiyang12/Downloads/formulahendry.acp-client-0.2.0.vsix`）
> 协议 SDK：`@agentclientprotocol/sdk@0.21.1`（与参考实现同版本，`PROTOCOL_VERSION = 1`）

---

## 1. 背景与目标

[ACP（Agent Client Protocol）](https://agentclientprotocol.com) 是编辑器与编码 Agent 之间的双向 JSON-RPC 协议：编辑器侧（client）启动 Agent 子进程，Agent 通过协议上报消息流、思考、工具调用、计划、权限申请，并反向调用编辑器的文件系统与终端能力。

参考实现 `formulahendry.acp-client` 把这个能力带进了 VS Code：侧边栏管理 Agent 与会话、Webview 聊天、工具调用卡片、权限确认、模式/模型切换、历史会话恢复、官方 Agent Registry 浏览。MIR 目前的 "Agent" 能力仅是一个命令启动器（`AgentCommandsModal.vue`，把 `opencode` 之类的 CLI 丢进终端 Tab），没有任何协议层打通。

**目标**：在 MIR 内实现一等公民的 ACP 客户端能力——

1. 在 MIR 里配置任意 ACP Agent（内置默认列表 + 自定义 + 官方 Registry），一键拉起；
2. 每个会话一个聊天 Tab（流式消息、思考、工具调用、计划、用量），支持多会话并行；
3. 权限申请以卡片形式在会话内确认（可配置全自动放行）；
4. Agent 反向调用 MIR 的文件读写与终端能力；
5. 模式 / 模型 / 配置项切换，斜杠命令，会话历史与恢复；
6. 与 MIR 现有工程约定一致（主进程 IPC、preload 白名单、Tab/右栏注册、i18n、插件式图标）。

**非目标（本期不做）**：

- 不做 Agent 侧实现（MIR 只是 client）；
- 不把聊天消息全文持久化到磁盘（Agent 支持 `session/load` 时由 Agent 回放；否则只保留会话摘要）；
- 不做 MCP server 注入（`newSession` 的 `mcpServers` 传空数组）；
- 不做 ACP 的 `document/*`、elicitation 等前沿扩展方法。

---

## 2. 参考实现拆解（VSIX 0.2.0）

从 `extension.js.map` 还原出 29 个 TS 源文件，核心结构与映射关系：

| VSIX 模块 | 职责 | MIR 对应 |
| --- | --- | --- |
| `core/AgentManager` | 用登录 shell 启动 Agent 子进程，管理 pid/退出，`SIGTERM`→5s→`SIGKILL` | `src/main/acp/agentProcess.ts` |
| `core/ConnectionManager` | `node:stream` ↔ Web Streams、`ndJsonStream`、报文 tap 日志、`initialize` 握手 | `src/main/acp/connection.ts` |
| `core/AcpClientImpl` | 实现 ACP `Client` 接口（permission / sessionUpdate / fs / terminal） | `src/main/acp/client.ts` |
| `core/SessionManager` | 会话状态机、`session/new`、prompt/cancel、mode/model/config、load/resume、auth 重试 | `src/main/acp/sessionManager.ts` |
| `core/SessionHistoryStore` | Agent 不支持 `session/list` 时用 `workspaceState` 兜底 | `src/main/acp/history.ts` |
| `handlers/FileSystemHandler` | `fs/read_text_file`（优先未保存缓冲区）、`fs/write_text_file` | `src/main/acp/handlers/fs.ts` |
| `handlers/TerminalHandler` | `terminal/create|output|wait_for_exit|kill|release` | `src/main/acp/handlers/terminal.ts` |
| `handlers/PermissionHandler` | QuickPick 选择权限选项 / `allowAll` 自动放行 | `src/main/acp/handlers/permission.ts` |
| `ui/ChatWebviewProvider`（2559 行） | Webview 聊天界面 | `components/center/AcpChatTab.vue` + `components/center/acp/*` |
| `ui/SessionTreeProvider` | 侧边栏 Agent/会话树 | `components/right/AcpAgentsPanel.vue` |
| `config/AgentConfig` + `RegistryClient` | Agent 配置、官方 Registry 拉取（5 分钟缓存） | `src/main/acp/config.ts`、`registry.ts` |
| `utils/StreamAdapter` | `Readable.toWeb` / `Writable.toWeb` | `src/main/acp/agentProcess.ts` 内联 |
| `utils/Logger` + `TelemetryManager` | 日志 / 遥测 | `logTraffic` + MIR 主进程日志；不做遥测 |

**关键行为（照搬协议语义，不照搬 UI）**：

- 启动命令：macOS/Linux 用 `spawn(loginShell, ['-l', '-c', 'cmd args...'], { stdio: 'pipe', env: {...process.env, ...agent.env}, cwd })`，参数逐项 `shellEscape`；`zsh/bash/ksh` 加 `-l`，`fish/sh/dash` 不加，找不到 `$SHELL` 时探测 `/bin/bash`、`/usr/bin/bash`、`/bin/sh`。这样 `npx`、`uvx`、`kiro-cli` 等都能用用户的 PATH。
- 握手：`initialize({ protocolVersion: 1, clientInfo: { name, version }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } })`。
- 认证：`session/new` 返回 code `-32000`（或错误信息匹配 `/auth.?required/i`）时，向 UI 暴露 `authMethods`，用户选择后调 `authenticate({ methodId })` 并重试一次。
- `session/load` 前必须先把会话登记进内存（否则回放的通知会被丢弃），并广播 `load-start` / `load-end`。
- 会话能力探测：`initialize` 返回的 `agentCapabilities.loadSession`、`sessionCapabilities.list`、`sessionCapabilities.resume`，能力缺失时 UI 禁用对应按钮、用本地历史兜底。

---

## 3. 架构决策

### 3.1 为什么放主进程，而不是做成 MIR 插件

MIR 有插件体系（`src/main/plugins.ts` + `src/renderer/src/plugins/loader.ts`），ACP 理论上可以做成插件，但：

1. **进程生命周期**：Agent 子进程必须跟随应用退出、跟随窗口销毁，需要在 `before-quit` 统一收口；插件没有这个钩子。
2. **终端与文件系统**：`terminal/*` 需要 node-pty 与统一回收，`fs/*` 需要与编辑器未保存缓冲区协作；插件拿不到 `pty.ts` 的内部状态（也没有对外契约）。
3. **分发**：插件目录在 `userData/plugins`，装/升级/签名是另一套流程；ACP 是产品核心能力，不该依赖插件安装。
4. **类型与构建**：插件主进程入口是独立构建产物（`build:plugins`），与主进程共享类型不方便；放主进程可以直接用 `@shared` 类型、`tsconfig.node.json` 全量类型检查。

结论：**主进程内建模块 + 渲染器内建 Tab/面板**，后续如需扩展再把稳定 API 抽成插件契约。

### 3.2 为什么用 SDK 0.21.1，而不是最新 2.x

- 2.x 换了 API 风格（`client({name})` + `onRequest`/`onNotification` + `connectWith`）并拆出 `./unstable`、`./experimental/v2` 子路径，生态里的 Agent 仍以协议 v1 为准；
- 参考实现用 0.21.1 已在真实 Agent（Claude Code / Gemini / Codex / opencode 等）上验证；
- 0.21.1 的 `ClientSideConnection`/`AgentSideConnection`/`ndJsonStream` 正好覆盖客户端与 Mock Agent 两侧，测试可以复用同一份 SDK。

SDK 为 ESM-only（`"type": "module"`），而 MIR 主进程产物是 CJS。因此把 `@agentclientprotocol/sdk` + `zod` 放在 **devDependencies**，由 electron-vite 打进 `out/main/index.js`（`externalizeDepsPlugin` 只外部化 `dependencies`），打包配置（`files`、`asarUnpack`、`verify-package.sh`）完全不用改。若放 `dependencies`，运行时需要 `require()` 一个 ESM 包，且要把 ~3MB 代码再拷进 app.asar。

### 3.3 一个 Agent 进程承载多个会话

VSIX 的做法是「一个 Agent 只能有一个活动会话」（`agentSessions: Map<agentName, sessionId>`）。ACP 协议本身允许一个连接上开多个 session，MIR 是多 Tab IDE，希望：

- 同一个 Agent（如 Claude Code）可以开多个聊天 Tab，并行跑不同任务；
- 减少重复拉起 `npx ...` 的开销（冷启动几秒）。

因此模型改为：**`agentId` → 唯一的 Agent 进程 + 连接；`sessionId` → 多个会话**。进程崩溃时该 Agent 下所有会话标记 `interrupted`，UI 提供「重连并恢复」（有 `session/load`/`resume` 能力时）。

### 3.4 会话消息不落盘（v1）

聊天记录体量大，且 ACP 允许 `session/load` 由 Agent 回放。本地只持久化**会话摘要**（`agentId / sessionId / cwd / title / firstPrompt / 时间`），用于面板展示与「恢复」入口；Agent 不支持 load/resume 时，历史条目只读（可复制 sessionId、可删除）。

---

## 4. 总体架构

```
┌───────────────────────────── Electron 主进程 ─────────────────────────────┐
│ src/main/acp/                                                             │
│   config.ts        Agent 配置（electron-store: acp:config）                 │
│   registry.ts      官方 Registry（cdn.agentclientprotocol.com，5min 缓存）   │
│   agentProcess.ts  登录 shell 启动 / ndjson 流 / 退出与信号                   │
│   connection.ts    ClientSideConnection + initialize + 能力探测 + 报文日志    │
│   client.ts        AcpClientImpl（Client 接口，转交 handlers）               │
│   handlers/fs.ts        fs/read_text_file, fs/write_text_file              │
│   handlers/terminal.ts  terminal/create|output|wait_for_exit|kill|release  │
│   handlers/permission.ts requestPermission（UI 审批 / 自动放行）             │
│   sessionManager.ts 会话状态机 + Agent 进程池 + 事件广播                      │
│   history.ts       会话摘要持久化（electron-store: acp:history）             │
│   index.ts         registerAcpIpc() → ipcMain.handle('acp:*') + 事件推送     │
└──────────────▲───────────────────────────────────┬────────────────────────┘
               │ ipcRenderer.invoke               │ webContents.send('acp:event')
┌──────────────┴───────────────────────────────────▼────────────────────────┐
│ preload/index.ts   window.electronAPI.acpXxx(...) / onAcpEvent(cb)         │
├────────────────────────────────────────────────────────────────────────────┤
│ Renderer                                                                   │
│   stores/acp.ts                 agents / sessions / chat items / perm 状态  │
│   components/center/AcpChatTab.vue          会话 Tab（聊天）                │
│   components/center/acp/*                   消息/工具/计划/权限/输入组件      │
│   components/right/AcpAgentsPanel.vue       右栏 Agents + Sessions          │
│   components/settings/AcpSettingsSection.vue 设置分区（Agent CRUD/Registry） │
│   plugins/builtin.ts           注册 tab 类型 'acp-chat'、右栏 'acp-agents'   │
└────────────────────────────────────────────────────────────────────────────┘
```

新增目录/文件：

```
src/shared/acp.ts                      # 主/渲染共用 DTO（IPC 契约）
src/main/acp/{index,config,registry,agentProcess,connection,client,sessionManager,history,types}.ts
src/main/acp/handlers/{fs,terminal,permission}.ts
src/renderer/src/stores/acp.ts
src/renderer/src/components/center/AcpChatTab.vue
src/renderer/src/components/center/acp/{ChatMessage,ToolCallCard,PlanCard,PermissionCard,ChatComposer,SessionHeader}.vue
src/renderer/src/components/right/AcpAgentsPanel.vue
src/renderer/src/components/settings/AcpSettingsSection.vue
scripts/acp-mock-agent.mjs            # 基于 SDK AgentSideConnection 的 Mock Agent
scripts/acp-selftest.mjs              # 协议层自动化自测
docs/acp-client.md                    # 本文档
```

---

## 5. 进程与连接层

### 5.1 启动（`agentProcess.ts`）

```ts
spawn(loginShell, ['-l', '-c', [command, ...args].map(shellEscape).join(' ')],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...agent.env }, cwd })
```

- `stderr` 逐块收集（尾部 8KB 环形缓冲，用于错误提示），并广播 `agent-stderr`；
- 退出时广播 `agent-status = closed`，原因（code/signal/stderr 尾部）带给 UI；
- `kill()`：`SIGTERM` → 5s 后 `SIGKILL`；应用退出时 `shutdownAll()` 同步遍历 kill。

### 5.2 连接（`connection.ts`）

```ts
const readable = Readable.toWeb(proc.stdout as Readable) as ReadableStream<Uint8Array>
const writable = Writable.toWeb(proc.stdin as Writable) as WritableStream<Uint8Array>
const stream = ndJsonStream(writable, readable)
const connection = new ClientSideConnection(() => clientImpl, stream)
const init = await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientInfo, clientCapabilities })
```

- `logTraffic` 开启时用两个 `TransformStream` 夹一层 tap，把 JSON-RPC 双向报文写入环形缓冲（`acp:traffic` 可查，用于调试 Agent 兼容问题）；
- 能力汇总：`agentCapabilities.loadSession`、`sessionCapabilities.list/resume`、`promptCapabilities`（image/audio/embeddedContext），存入 `AgentRuntime`，供 IPC 与 UI 使用。

### 5.3 客户端实现（`client.ts`）

`Client` 接口只有 `requestPermission` 与 `sessionUpdate` 是必需方法，其余为可选：

| 方法 | 实现 |
| --- | --- |
| `requestPermission(params)` | `handlers/permission.ts`：`allowAll` → 选第一个 `allow_once/allow_always`；否则发 `permission-request` 事件，等 UI 回传 `optionId`（60s 超时/取消 → `{outcome:'cancelled'}`） |
| `sessionUpdate(notification)` | 直接透传给渲染器（`session-update` 事件），主进程只做 `session_info_update` / `config_option_update` / `available_commands_update` 的本地状态同步 |
| `readTextFile` | 读磁盘 UTF-8（保留 BOM 处理），支持 `line`（1-based）/`limit` |
| `writeTextFile` | 建父目录 + 写入；完成后广播 `file-written`（渲染器据此 reload 已打开且未修改的编辑器） |
| `createTerminal` / `terminalOutput` / `waitForTerminalExit` / `killTerminal` / `releaseTerminal` | node-pty 起进程；输出环形缓冲（`outputByteLimit`，默认 1MB，超出从头截断）；`waitForTerminalExit` 支持超时 |

---

## 6. 会话模型与状态机

```ts
interface LiveSession {
  sessionId: string
  agentId: string
  cwd: string
  title?: string
  status: 'active' | 'loading' | 'interrupted' | 'closed'
  modes?: SessionModeState
  configOptions?: SessionConfigOption[]
  availableCommands: AvailableCommand[]
  firstPrompt?: string
  createdAt: number
  updatedAt: number
}
```

- 创建：`newSession({ cwd, mcpServers: [] })`；`cwd` 默认 `project.path`，可在面板里覆盖。
- 发送：`prompt({ sessionId, prompt: ContentBlock[] })`，返回 `{ stopReason }`；期间广播 `prompt-start` / `prompt-end`。
- 取消：`cancel({ sessionId })`。
- 配置：`setSessionConfigOption({ sessionId, configId, value })` → 用返回的 `configOptions` 覆盖本地；`mode`/`model` 优先走 `category === 'mode'|'model'` 的配置项，否则 `setSessionMode` / `unstable_setSessionModel`。
- 加载：`loadSession({ sessionId, cwd, mcpServers: [] })` 前先登记占位会话（状态 `loading`），回放通知先进入渲染器 store 的 per-session 缓冲，`load-end` 后落定；失败（`/not found|no such|unknown session/i`）时清理本地历史。
- 恢复：`resumeSession`（能力存在时），不重放历史。
- 认证：`session/new` 失败且为 auth-required → 返回 `{ authRequired: true, methods }`，UI 展示登录按钮 → `acpAuthenticate(agentId, methodId)` → 重试。

---

## 7. IPC 契约

`src/shared/acp.ts` 导出 DTO；`preload` 逐个方法暴露；主进程 `ipcMain.handle('acp:xxx')`。

### 7.1 请求/响应

| preload 方法 | 主进程 channel | 说明 |
| --- | --- | --- |
| `acpGetConfig()` | `acp:get-config` | 读配置 |
| `acpSetConfig(patch)` | `acp:set-config` | 写配置，返回新配置 |
| `acpGetHarnessConfig()` | `acp:get-harness-config` | 读 MIR Harness 配置文件快照（含默认值 / 环境变量覆盖 / 解析错误） |
| `acpSetHarnessConfig(config)` | `acp:set-harness-config` | 原子写 MIR Harness 配置 |
| `acpDiscoverHarnessModels({apiBase,apiKey})` | `acp:discover-harness-models` | 从接口拉取模型列表（OpenAI / Anthropic / Gemini / Ollama / 通用 JSON） |
| `acpGetState()` | `acp:get-state` | 重载后恢复：运行中的 Agent + 会话 |
| `acpGetAgents()` | `acp:get-agents` | Agent 运行时状态列表 |
| `acpGetRegistry()` | `acp:get-registry` | 官方 Registry |
| `acpCreateSession({agentId,cwd})` | `acp:create-session` | 拉起 Agent（如需）+ newSession |
| `acpLoadSession({agentId,sessionId,cwd})` | `acp:load-session` | 恢复并由 Agent 回放 |
| `acpResumeSession({agentId,sessionId,cwd})` | `acp:resume-session` | 恢复但不回放 |
| `acpCloseSession(sessionId)` | `acp:close-session` | 关闭单个会话（`session/close` 可选） |
| `acpDisconnectAgent(agentId)` | `acp:disconnect-agent` | 关会话 + 杀进程 |
| `acpSendPrompt({sessionId,blocks})` | `acp:send-prompt` | 返回 `{stopReason}` |
| `acpCancelPrompt(sessionId)` | `acp:cancel-prompt` | 取消本轮 |
| `acpSetConfigOption({sessionId,configId,value})` | `acp:set-config-option` | 返回最新 options |
| `acpSetMode({sessionId,modeId})` | `acp:set-mode` | |
| `acpSetModel({sessionId,modelId})` | `acp:set-model` | |
| `acpListSessions({agentId,cwd})` | `acp:list-sessions` | Agent 端历史 |
| `acpListHistory()` | `acp:list-history` | 本地会话摘要 |
| `acpForgetSession({agentId,sessionId})` | `acp:forget-session` | 删除本地摘要 |
| `acpAuthenticate({agentId,methodId})` | `acp:authenticate` | 认证并重试 |
| `acpRespondPermission({requestId,optionId})` | `acp:respond-permission` | `optionId=null` 表示取消 |
| `acpGetTraffic()` | `acp:get-traffic` | 调试报文（`logTraffic` 开启时） |

### 7.2 事件（`webContents.send('acp:event', event)`）

```ts
type AcpEvent =
  | { type: 'agent-status'; info: AgentRuntimeInfo }
  | { type: 'session-created'; session: AcpSessionSummary }
  | { type: 'session-updated'; sessionId: string; patch: Partial<AcpSessionSummary> }
  | { type: 'session-removed'; sessionId: string }
  | { type: 'session-update'; sessionId: string; update: SessionUpdate }
  | { type: 'permission-request'; requestId: string; sessionId: string; toolCall: ToolCallUpdate; options: PermissionOption[] }
  | { type: 'permission-resolved'; requestId: string }
  | { type: 'prompt-start'; sessionId: string }
  | { type: 'prompt-end'; sessionId: string; stopReason?: string; error?: string }
  | { type: 'auth-required'; agentId: string; sessionId?: string; methods: AcpAuthMethod[] }
  | { type: 'file-written'; sessionId?: string; path: string }
  | { type: 'agent-stderr'; agentId: string; chunk: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string; sessionId?: string }
```

渲染器只依赖这些 DTO；协议类型（`SessionUpdate`、`ToolCallContent`、`PermissionOption`…）通过 `import type` 从 SDK 引入（编译期擦除，不会把 SDK 打进渲染器）。

---

## 8. 渲染器设计

### 8.1 状态模型（`stores/acp.ts`）

```ts
type ChatItem =
  | { kind: 'user'; id: string; text: string; at: number }
  | { kind: 'agent'; id: string; text: string; streaming: boolean; at: number }
  | { kind: 'thought'; id: string; text: string; at: number }
  | { kind: 'tool'; id: string; toolCall: ToolCall; at: number }
  | { kind: 'plan'; id: string; entries: PlanEntry[]; at: number }
  | { kind: 'notice'; id: string; level: 'info'|'warn'|'error'; text: string; at: number }

interface SessionState {
  summary: AcpSessionSummary
  items: ChatItem[]
  pendingPermissions: PermissionRequest[]
  promptInFlight: boolean
  modes?: SessionModeState
  configOptions?: SessionConfigOption[]
  commands: AvailableCommand[]
  usage?: UsageUpdate
}
```

Reducer 规则（对齐 ACP 语义）：

- `agent_message_chunk` → 追加到最后一条 `agent` 项（不存在或已结束则新建），`messageId` 变化时新起一条；
- `agent_thought_chunk` → 追加到 `thought` 项（默认折叠）；
- `tool_call` → upsert（按 `toolCallId`）；`tool_call_update` → 字段级合并（`undefined` 保留、`null` 清空）；
- `plan` → 替换整条计划卡片；
- `available_commands_update` / `current_mode_update` / `config_option_update` / `session_info_update` / `usage_update` → 更新会话级状态；
- `user_message_chunk` → 仅在 `session/load` 回放时使用。

### 8.2 聊天 Tab（`AcpChatTab.vue`）

顶栏：Agent 名 + 会话标题（可重命名）+ 状态点（运行中/中断/错误）+ 配置选择器（mode ⚡ / model 🧠 / thought_level 💭，来自 `configOptions.category`）+ 断开/新建按钮。

消息区：

- 用户消息右对齐气泡；Agent 消息左侧 Markdown（复用 `markdown-it`，延迟渲染最后一条流式消息以控制重绘）；
- 思考块默认折叠（"思考过程 · N 字"）；
- 工具调用卡片：图标按 `kind`（read/edit/execute/search/think…）、标题、状态（running ⟳ / completed ✓ / failed ✗）、`content` 里 diff 渲染为左右/统一 diff 文本、terminal 内容折叠展示、`locations` 可点击跳转到编辑器对应行；
- 计划卡片：条目状态（pending/in_progress/completed）+ 优先级色条；
- 权限卡片：工具标题 + 选项按钮（allow_once / allow_always / reject_once / reject_always），一次选择后置灰；
- 空态：Agent 提示 + 推荐命令（来自 Registry 的 `example` 或内置文案）。

输入区：多行文本框（Enter 发送、Shift+Enter 换行）、发送/停止按钮、附加文件（走 `showOpenDialog`，转成 `resource_link` block）、斜杠命令补全（`availableCommands`）。

### 8.3 右栏 Agents 面板（`AcpAgentsPanel.vue`）

- Agent 列表：状态点（idle/starting/ready/error）、displayName、命令摘要；行内操作（新建会话、断开、重启、查看 stderr）；
- 每个 Agent 展开：运行中会话（点击打开/激活对应 Tab，显示 Turn 状态）+ 历史会话（来自 `acp:list-history` 与 Agent 的 `session/list`，支持恢复/复制 sessionId/忘记）；
- 顶部：`+ 新建会话`（选 Agent + 工作目录）、`刷新`、`设置`（跳设置页 ACP 分区）。

### 8.4 设置分区（`AcpSettingsSection.vue`）

- Agent 列表编辑：name / command / args（按空格或 JSON 数组）/ env（KEY=VALUE 多行）/ 启用开关 / 删除；
- 恢复内置默认 Agent；
- 浏览官方 Registry：搜索、一键添加（npx 或二进制分发）；
- 全局：`autoApprovePermissions`（ask / allowAll）、`logTraffic`、默认工作目录。

### 8.5 Tab / 面板注册与图标

- `plugins/builtin.ts`：`registerTabType({ type: 'acp-chat', component: AcpChatTab, icon: 'message-square', defaultTitle })`、`registerRightPanel({ id: 'acp-agents', label: t('acp.panel.title'), icon: 'bot', component: AcpAgentsPanel })`；
- `Tab` 增加可选字段 `acpSessionId?: string`，由面板/`acp-store` 打开会话时写入；
- 新图标写入 `components/ui/icons.ts`：`bot`、`message-square`、`sparkles`、`shield-check`、`terminal-square`、`plug`、`brain`、`list-checks`、`loader`。

---

## 9. 内置默认 Agent 列表

当前内置三个 Agent：MIR 自己的 `mir-harness`（详见 [`docs/mir-harness.md`](./mir-harness.md)）与两个外部 Agent；
本地 mock agent 只保留给离线自测，不再出现在默认列表里。

| id | 名称 | 命令 | 实测能力 |
| --- | --- | --- | --- |
| `mir-harness` | MIR Harness | `{{EXEC_PATH}} {{APP_PATH}}/out/main/agent/index.js`（env `ELECTRON_RUN_AS_NODE=1`） | MIR 内置 Agent，OpenAI 兼容接口 + 5 个工具；`loadSession` + `sessionCapabilities.{list,resume,close}`，配置项 `model` / `thought_level`，模式 `ask` / `code` |
| `pi` | Pi Coding Agent | `npx -y pi-acp@latest` | `initialize` → `agentInfo.name=pi-acp`，`loadSession: true`，`sessionCapabilities.{list,delete}`，auth method `pi_terminal_login`（terminal 类型，登录走 `pi` 自身配置） |
| `deepseek-harness` | DeepSeek Harness | `dsh --profile acp` | `initialize` → `agentInfo.name=deepseek-harness-acp`，`sessionCapabilities.{close,list,resume}`，`authMethods: []` |
| `mock` | Mock Agent (调试) | `node scripts/acp-mock-agent.mjs` | 本地假 Agent，覆盖全部 `SessionUpdate` 形状，供 `npm run acp:selftest` 与 UI 自测（不在默认列表） |

其它 Agent（Claude Code / Gemini / Codex / Copilot / Qwen / OpenCode / Auggie / Qoder / OpenClaw / Kiro / Hermes）
不再默认内置，可在设置里「添加智能体」或从注册表浏览添加，命令与 VSIX 默认值一致。

> **升级迁移（`ACP_CONFIG_VERSION=3`）**：老版本落盘的历史内置项（含旧默认的 mock），首次读取配置时按
> `command|args` 签名识别并替换为新的默认项；用户自建过、或改过命令的条目原样保留。
> 迁移只做一次（版本号写在 `acpSchemaVersion` 键）。

---

## 10. 安全与权限

- Agent 进程以当前用户权限运行（与 VS Code 扩展一致）；MIR 不做沙箱，但**默认 `autoApprovePermissions = 'ask'`**，所有工具调用都需用户确认；
- 权限卡片展示 `toolCall.title`、`kind`、`rawInput`（折叠）；`reject` 直接回 `cancelled`；
- `fs/write_text_file` 若路径在项目根之外，聊天里提示「Agent 在项目外写入」并记录 `notice`（v1 不阻断，后续可加路径白名单）；
- 终端命令由 Agent 发起、由 MIR 执行，输出上限 1MB；`kill_terminal`/`release_terminal` 保证不泄漏进程；
- `stderr` 仅作为诊断信息展示，不执行任何内容。

---

## 11. 错误处理与降级

| 场景 | 行为 |
| --- | --- |
| Agent 启动失败/命令不存在 | `agent-status: error`，stderr 尾部展示；面板可编辑配置后重试 |
| 进程中途崩溃 | 该 Agent 所有会话 `interrupted`，聊天里插入 notice；可「重连并恢复」 |
| 协议版本不匹配 | `initialize` 报错原样展示，提示升级 Agent |
| 认证要求 | 返回 `authRequired`，UI 展示登录方法按钮；成功后重试一次 |
| 无 `session/list` | 仅展示本地历史（`history.ts`） |
| 无 `loadSession`/`resume` | 历史条目禁用「恢复」，悬浮提示不支持 |
| 权限审批超时（60s） | 回 `cancelled`，卡片标记「已超时」 |
| 文本体积过大 | 消息渲染上限（单条 200KB 折叠）、终端输出 1MB 截断 |
| 窗口 reload（dev HMR） | 主进程状态保留，渲染器启动时 `acpGetState()` 重建 Tab 与会话状态；消息流丢失则显示「已重载」提示 |

---

## 12. 测试与验证

1. **协议自测（无需联网）**：`node scripts/acp-selftest.mjs`
   - 用 SDK `ClientSideConnection` 直接驱动 `scripts/acp-mock-agent.mjs`；
   - 覆盖：`initialize` 能力协商、`session/new`、流式消息顺序、思考块、`tool_call`+`tool_call_update`、`plan`、`requestPermission`（选中与取消）、`fs/read_text_file`（含 line/limit）、`fs/write_text_file`、`terminal/create`→`output`→`wait_for_exit`、`session/cancel`、`session/list`、`session/load` 回放。
2. **主进程端到端**：用临时 harness 把 `src/main/acp/**` 用 esbuild 打包、`electron` 模块打桩，走真实 IPC 通道对 `scripts/acp-mock-agent.mjs` 跑完整流程（建/载/续会话、prompt、权限、取消、崩溃恢复、fs/terminal handler）。仓库内只保留协议自测，避免引入 esbuild 依赖。
3. **类型与构建**：`npm run typecheck`、`npm run build`。
4. **手工冒烟**：设置里把 `mock` 设为默认，新建会话 → 发消息 → 看到流式回复/工具卡片/权限卡片 → 取消 → 断开；再用真实 Agent（如 `opencode` / `claude-code`）验证登录与真实工具调用。
5. **打包验证**：`npm run pack:dmg && bash scripts/verify-package.sh`（确认新增依赖没有破坏 asar / spawn-helper 检查）。

---

## 13. 里程碑与任务拆分

| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| M1 协议层 | `agentProcess` / `connection` / `client` / handlers / Mock Agent + selftest | `node scripts/acp-selftest.mjs` 全绿 |
| M2 会话与 IPC | `sessionManager` / `history` / `config` / `registry` / `index.ts` / preload / `@shared` 类型 | 主进程可建会话、收发 prompt，事件能到渲染器 |
| M3 聊天 UI | `stores/acp.ts` + `AcpChatTab` + 子组件 | 流式消息、工具卡片、计划、权限、配置选择可用 |
| M4 面板与设置 | `AcpAgentsPanel` + 设置分区 + i18n + 图标 | 可配置/拉起/切换/断开 Agent，历史会话可恢复 |
| M5 收尾 | 认证流、错误降级、reload 恢复、文档、README | typecheck/build/pack 通过，文档齐全 |

---

## 14. 风险与后续

- **Agent 兼容性差异**：不同 Agent 对 `session/list`、`config_option_update`、`tool_call_update` 的字段填充不一致；渲染器 reducer 必须容忍缺字段，必要时按 `rawInput` 兜底展示。
- **npx 冷启动**：首次拉起 `npx xxx@latest` 可能下载数十秒，UI 需要「启动中」状态与 stderr 流；后续可加「预热」。
- **多窗口**：ACP 事件目前广播给所有窗口；MIR 单窗口暂不涉及，后续按 `sender` 定向。
- **消息持久化**：如需离线历史，可在 `ChatItem` 上做增量落盘（`acp:session:<id>`），注意体积与隐私。
- **终端镜像**：当前 ACP 终端内容在聊天卡片里展示；后续可扩展 `pty.ts` 支持「绑定既有 pty」，让终端出现在 MIR 终端 Tab 里。
- **MCP 注入**：后续可在设置里配置 MCP server，随 `newSession` 传入（协议已支持）。

---

## 15. 实施状态与验收记录（2026-11-09）

### 15.1 已落盘文件

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/shared/acp.ts` | ~300 | 协议类型 re-export、DTO、`AcpEvent` 事件联合、`DEFAULT_ACP_AGENTS` / `DEFAULT_ACP_CONFIG` |
| `src/main/store.ts` | 13 | 懒创建的 electron-store（`getStore()`），供 ipc 与 acp 共用 |
| `src/main/acp/index.ts` | 250 | 25 个 IPC handler、事件广播、`shutdownAcp()` |
| `src/main/acp/config.ts` | ~195 | 配置归一化与持久化、首次运行 seed 默认 Agent、`ACP_CONFIG_VERSION` 迁移 |
| `src/main/acp/history.ts` | 161 | 本地会话摘要（每 Agent 50 条）、`reconcile()` |
| `src/main/acp/agentProcess.ts` | 165 | 登录 shell 解析、参数转义、`{{APP_PATH}}` 展开、stderr 尾部、SIGTERM→SIGKILL |
| `src/main/acp/connection.ts` | 264 | `ndJsonStream`、双向报文 tap（200 条环形）、`initialize` 30s 超时、能力映射 |
| `src/main/acp/client.ts` | 106 | `Client` 实现（fs / terminal 可选方法委托给 handlers） |
| `src/main/acp/events.ts` | 24 | 事件 sink，打破 `index.ts` ↔ `sessionManager.ts` 循环依赖 |
| `src/main/acp/sessionPrefs.ts` | 120 | 按 Agent 记住上次选过的 model / mode / thought_level（electron-store `acp-last-session-config`；`mir-harness` 不记 thought_level，见 §15.7） |
| `src/main/acp/sessionManager.ts` | ~1105 | Agent/会话状态、prompt 生命周期、配置项、load/resume、崩溃处理、新建会话套用记忆 |
| `src/main/acp/handlers/fs.ts` | 35 | 读（支持 `line`/`limit`）、写（建父目录）+ `file-written` 事件 |
| `src/main/acp/handlers/permission.ts` | 111 | 挂起表、60s 超时、各关闭路径取消、`allowAll` 自动批准 |
| `src/main/acp/handlers/terminal.ts` | 173 | 输出上限/截断、kill 宽限 2s、`disposeAllTerminals()` |
| `src/main/acp/registry.ts` | 193 | CDN registry、5 分钟缓存、10s 超时、失败降级 |
| `src/preload/index.ts` | +63 | 25 个 `acp:*` invoke 方法 + `onAcpEvent()` 订阅 |
| `src/renderer/src/stores/acp.ts` | ~560 | 事件 reducer、会话/对话/权限/Tab 同步 |
| `src/renderer/src/components/center/AcpChatTab.vue` | 543 | 聊天 Tab（滚动锚定、空态、横幅、重连） |
| `src/renderer/src/components/center/acp/*` | 2028 | `ChatMessage` / `ToolCallCard` / `PlanCard` / `PermissionCard` / `ChatComposer` / `SessionHeader` |
| `src/renderer/src/components/right/AcpAgentsPanel.vue` | 1178 | Agent 卡片、运行中会话、按 Agent 分组的历史、registry 弹窗 |
| `src/renderer/src/components/AcpSettingsSection.vue` | 853 | 通用设置 + Agent 草稿 CRUD + registry 浏览 + 运行状态表 |
| `src/renderer/src/plugins/builtin.ts` | +14 | 注册 tab 类型 `acp-chat`、右栏 `acp-agents` |
| `src/renderer/src/stores/tabs.ts` | +2 | `BuiltinTabType` 增 `'acp-chat'`，`Tab` 增 `acpSessionId?` |
| `src/renderer/src/App.vue` | +2 | 启动后 `acpStore.init()` |
| `src/renderer/src/i18n/locales/{en,zh-CN}.json` | 各 ~111 键 | `acp` 命名空间（渲染器实际使用的键已 100% 补齐） |
| `scripts/acp-mock-agent.mjs` | 747 | 无依赖 mock Agent（流式、工具、计划、权限、取消、load/list/resume） |
| `scripts/acp-selftest.mjs` | 482 | 客户端协议自测；`npm run acp:selftest` |
| `package.json` | +1 | `"acp:selftest": "node scripts/acp-selftest.mjs"` |

### 15.2 与设计的差异（及原因）

1. **配置不做“内置合并”**：只在 store 键 `acp` 缺失（或 `agents` 不是数组）时 seed `DEFAULT_ACP_AGENTS`；此后 `set-config` 原样持久化（允许删空）。否则设置界面删除内置 Agent 后会被“复活”。
2. **新增 `events.ts`**：`index.ts` 需要广播事件、`sessionManager.ts` 需要发事件，直接互相 import 会成环。
3. **`session/update` 早到缓冲**：SDK 并发分发入站消息（不 `await` 处理），agent 可能在 `session/new` 响应到达前推送该会话的 update。主进程对未知 `sessionId` 缓存（每会话 64 条、TTL 15s），会话登记并广播 `session-created` 后按序补发。
4. **`forget-session` 只删历史摘要**：不关闭运行中的会话（渲染器侧同样只刷新历史列表）。
5. **`AcpAgentCapabilities.terminal` 恒为 `true`**：ACP 不暴露“客户端是否支持终端”，这是 MIR 自身能力。
6. **mock Agent 用 `{{APP_PATH}}` 占位符**：展开为 `app.getAppPath()`，因此默认配置里写 `node {{APP_PATH}}/scripts/acp-mock-agent.mjs` 即可在开发态直接跑。
7. **SDK 与 zod 放 devDependencies**：`externalizeDepsPlugin()` 只外部化 `dependencies`，devDeps 会被打进 `out/main/index.js`，打包产物不需要 node_modules 里的 SDK。
8. **权限按钮文案优先用 agent 的 `option.name`**（协议要求），缺失时才回退 i18n 文案。
9. **mock Agent 在 Electron 里跑 Node 脚本需要 `ELECTRON_RUN_AS_NODE=1`**；走登录 shell + `node` 时不受影响。
10. **默认 Agent 收窄为 pi + DeepSeek Harness（+ mock）**：详见 §15.5；旧配置通过 `acpSchemaVersion` 一次性迁移。
11. **记住上次的会话配置**（原设计未包含，按用户反馈新增）：新建会话时自动套用该 Agent 上一次选过的模型/模式/推理强度，详见 §15.7。

### 15.3 验证记录

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（`tsconfig.node.json` + `tsconfig.web.json`，0 error） |
| 构建 | `npm run build` | 通过；`out/main/index.js` ≈ 293 KB（SDK 已内联） |
| 协议自测 | `npm run acp:selftest` | `ALL PASS — 43 checks in 6.3s`（连跑 6 次稳定） |
| 主进程 e2e | 临时 harness（esbuild + electron 打桩 + 真实 IPC 通道） | 30/30：握手/能力、建/载/续/关会话、prompt 流、权限（选中/取消/挂起/allowAll）、并发 prompt 拒绝、cancel、mode/model/config-option、list+reconcile、forget、崩溃→interrupted→重连、fs/terminal handler、shutdown 幂等 |
| 真实 UI 冒烟 | `electron . --remote-debugging-port=9333` + CDP 驱动，mock Agent | 面板列出 Agent → 新建会话（pid/状态 ready）→ 流式思考/工具卡/计划/usage/代码块渲染 → 权限卡（Allow/Always allow/Reject）→ 取消提示“已取消本轮” → 断开 → 历史恢复回放 → 设置页 ACP 分区；控制台 0 异常 |
| IPC 一致性 | 脚本对比 preload 与主进程注册 | 25 个 `acp:*` invoke ↔ 25 个 handler，`acp:event` 单向推送 |

### 15.4 已知限制与后续

- **fs 写入不限制路径**：Agent 可请求写工作区外文件（与 VS Code 参考实现一致）。若要收紧，在 `handlers/fs.ts` 里按会话 cwd 做前缀校验即可。
- **终端输出**在聊天卡片内展示，尚未复用 MIR 终端 Tab；后续可扩展 `pty.ts` 支持“绑定既有 pty”。
- **聊天消息不落盘**（进程内）；重启后只能靠 agent 的 `session/load` 回放，需 Agent 支持该能力。
- **DSH 的回复不是逐字流式**：DeepSeek Harness 的 ACP profile 只投影已提交消息（见 15.6），文本整段到达；
  MIR 默认开启 `smoothStreaming`（设置 → ACP 智能体 → 整段回复渐进显示）做打字机式呈现，
  协议层仍无 token 增量。
- **mock Agent 依赖 `scripts/` 目录**：打包分发时需确认该路径在 asar 外可访问（或改为用户自定义命令）。
- **多窗口**：事件广播给所有窗口；单窗口场景无影响。
- **打包**：本次未跑 `npm run pack:dmg`（耗时且需要签名环境）；`npm run build` + 既有 `verify-package.sh` 逻辑不受影响，建议发版前补跑。

### 15.5 默认 Agent 收窄到 pi / DeepSeek Harness（2026-11-09 下午）

**背景**：用户反馈「启动失败」。定位到根因是 **Codex 自身配置不兼容**，不是 MIR 的问题：

```
Codex → npx @zed-industries/codex-acp@latest → agent 进程异常退出（code 1）
Error: error loading config: failed to parse model_catalog_json path
`/Users/lihaiyang12/.codex/magpie-models.json` as JSON: unknown variant `max`,
expected one of `none` `minimal` `low` `medium` `high` `xhigh`
```

即本机 `~/.codex` 里把 `reasoningEffort` 写成了 `max`，而 codex-acp 的 schema 只认到 `xhigh`。
这类「Agent 自身环境问题」不该出现在默认列表里，因此按用户要求：

1. `DEFAULT_ACP_AGENTS` 收窄为 **pi**、**deepseek-harness**、**mock（调试）** 三项；
2. `src/main/acp/config.ts` 增加 `ACP_CONFIG_VERSION = 2` 迁移：按 `command|args` 签名识别历史 12 个内置项并替换，
   用户自建/改过命令的条目保留；版本号落 `acpSchemaVersion` 键，只迁一次；
3. 两个真实 Agent 的握手已实测（见下表），无需登录即可 `initialize` 成功。

| Agent | 探测命令 | `initialize` 结果 |
| --- | --- | --- |
| pi | `npx -y pi-acp@latest` | `pi-acp` 0.0.34，`protocolVersion: 1`，`loadSession: true`，`sessionCapabilities.{list,delete}`，`promptCapabilities.image: true` |
| DeepSeek Harness | `dsh --profile acp` | `deepseek-harness-acp` 0.0.1，`protocolVersion: 1`，`sessionCapabilities.{close,list,resume}`，`authMethods: []` |

**验证**：

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run build` / `npm run acp:selftest` | 全部通过（构建后 `out/main/index.js` 仍 ≈294 KB） |
| 配置迁移 | 真实 userData（原 12 个 Agent）启动后自动变为 `pi` / `deepseek-harness` / `mock` 三项 |
| pi 真实会话 | 面板「新建会话」→ `agent-status: ready`（pid）、`session-created: active`、modes `off/low/high/max`、config `model=magpie/workbuddy/deepseek-v4.1-flash`；聊天里发消息 → 流式回复正常（`stopReason: end_turn`） |
| DeepSeek Harness 真实会话 | 面板「新建会话」→ `ready`（pid）、`session-created: active`、config `model=["deepseek-official","deepseek-v4-flash"]`、`reasoning_effort=high`；本机该 profile 的 API key 返回 401，发消息时以「本轮失败」notice 呈现（属 DSH 凭据问题，非客户端缺陷） |
| 旧 Codex 卡片 | 迁移后不再出现在默认列表；如仍需 Codex，可在设置里自行添加（需修正 `~/.codex` 的 `reasoningEffort` 取值为 `xhigh` 或更低） |


### 15.6 流式能力差异：DSH 不提供增量，MIR 增加「平滑呈现」（2026-11-09 晚）

**用户反馈**：`dsh harness 没有支持流式`。

**结论**：这是 DeepSeek Harness 的 ACP profile 的**协议设计选择**，不是 MIR 客户端缺陷。

证据 1：源码（`@deepseek-ai/dsh-acp` 0.2.2-rc.1，随 DeepSeek Harness.app 分发在
`Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-acp`）：

- `lib/index.js` 的 `onSessionEvent()` 只处理 `assistant/message`、`tool/call`、`tool/result` 三类
  **已提交（committed）的持久事件**，再把它们投影成 ACP 更新；
- `assistantUpdates()` 按 `event.data.message.content` 把**一整条** assistant 消息生成一个
  `agent_message_chunk`，而 `assistant/message` 只在模型完成该步后 append；
- `README.zh.md:98` 明确写出：「协议承载已提交消息与 thought、通用工具生命周期、配置与上下文用量；
  **原始提供方增量、重试尝试、DSH 呈现数据与不受支持内容不会进入协议**」。

证据 2：协议级实测（`dsh --profile acp`，模型切到本机 magpie 网关
`magpie-responses/mccodex-mc/deepseek-v4.1-flash`，t = prompt 发出后的毫秒数）：

```
PROMPT resolved in 2623 ms {"stopReason":"end_turn"}
  2618ms  agent_message_chunk  len=143   ← 全文一次性到达
  2623ms  usage_update
chunks = 1
```

带工具的回合是「工具实时、文本整段」：

```
  2850ms  usage_update
  2851ms  tool_call          ← 工具卡片实时出现
  2862ms  tool_call_update   ← 实时完成
  4453ms  agent_message_chunk  len=58   ← 文本整段到达
```

对比 pi（`pi-acp`）：逐块推送 `agent_message_chunk`，MIR 里逐字出现。同一渲染器、同一 IPC，
行为差异完全来自 Agent 侧。

**处理方式**（不改变协议，只补偿呈现）：

1. `AcpConfig` 新增 `smoothStreaming: boolean`，**默认开启**，随配置落 electron-store 的 `acp` 键；
   设置 → ACP 智能体 → 「整段回复渐进显示」可关闭。
2. 新增 `src/renderer/src/components/center/acp/useSmoothReveal.ts`：
   当一次文本追加跨度 **≥ 48 字符**（即「整段到达」）时，用 `requestAnimationFrame` 按约
   110 字符/秒 展开（单次动画 240 ms–1.4 s，ease-out）；小增量（真流式 Agent）原样透传、
   不引入延迟；关闭开关或文本被清空/重放时立即显示全文。
3. `ChatMessage.vue` 的 agent 消息接入该 composable；user / thought / notice 不受影响。
   只对「本次回合刚产生」的消息播放入场动画：`session/load` 回放产生的 item 在 store 里带
   `replay` 标记（`stores/acp.ts` 的 `replayingSessions`），回放与切换 Tab 重挂载都不重播。
4. `AcpChatTab.vue` 增加 `MutationObserver`（吸底时用 rAF 节流滚动）：因为动画只改 DOM、
   不改变 store 里的 `items`，原有的 `scrollSignal` 感知不到文本增长。

**踩坑记录**：第一版动画「不生效」——整段到达的 Agent 只发一个 chunk，消息 item 在创建时就
带着全文，`watch(fullText)` 永远不会再触发，`shown` 初始化为全文所以看不到展开。修复：给
composable 增加 `animateFirst` 选项，挂载时若「已开启 + 文本 ≥ 阈值 + 本回合刚产生」则从空串
开始补跑一次动画。

**验证**（真机 CDP，`dsh --profile acp` + `magpie-responses/mccodex-mc/deepseek-v4.1-flash`，
每 40 ms 采样可见 `.markdown` 的 `textContent.length`）：

| 场景 | 观测 |
| --- | --- |
| 开启 + 实时回复（149 字符） | 34 次长度变化：`t=2522 len=2` → `t=2881 len=70` → `t=3842 len=149`，约 1.3 s 展开完 |
| 开启 + 实时回复（183 字符） | 35 次长度变化，`t=2561 len=5` → `t=3881 len=183` |
| 开启 + 短回复（61 字符） | 15 次长度变化，`t=2001 len=3` → `t=2521 len=61` |
| 关闭 + 实时回复（175 字符） | 仅 2 个变化点：`len=0` → `t=2361 len=175`（一次性到位） |
| 开启 + 历史会话 `session/load` 回放 | 仅 1 个变化点（回放内容一次性出现，不重播动画） |
| 设置界面 | 「整段回复渐进显示」默认勾选，hint 说明「仅影响显示，协议本身仍没有 token 增量」 |

`npm run typecheck`、`npm run build`、`npm run acp:selftest` 均通过。

### 15.7 记住上次使用的模型 / 模式 / 推理强度（2026-11-09 晚）

**问题**：ACP 的 `session/new` 只会返回 Agent 自己的默认配置，用户每次新建会话都要重新选一次模型
（DeepSeek Harness 尤其明显：默认是 `deepseek-official/deepseek-v4-flash`，实际常用的是
`magpie-responses/mccodex-mc/deepseek-v4.1-flash`）。

**方案**：主进程按 `agentId` 记住用户最后一次显式设置过的会话级配置，创建新会话后自动套用。

1. 存储：新增 `src/main/acp/sessionPrefs.ts`，electron-store 键 `acp-last-session-config`，
   与用户配置（`acp`）分开，不污染设置界面；结构为
   `{ [agentId]: { values: Record<string, string|boolean>, modeId?, modelId? } }`。
2. 记什么：`REMEMBERED_CATEGORIES / REMEMBERED_IDS = { mode, model, thought_level }`；
   记录时机是 `sessionManager` 的 `setConfigOption()` / `setMode()` / `setModel()` **成功之后**，
   因此只有用户主动切换才会写，Agent 自己改配置不会覆盖记忆。
3. 什么时候套用：`createSession()` 内、`sessions.set()` 与 `session-created` 事件**之前**执行
   `applyRememberedConfig()`，所以渲染器第一次拿到的 `detail.configOptions` 就已经是记住的值，
   UI 不会先闪一下默认模型。`resumeSession()` / `loadSession()` **不套用**——恢复的是那个会话
   自身的配置，套用记忆反而会把它改掉。
4. 顺序与校验：
   - 先模型 → 再推理强度 → 其它（部分 Agent 切换模型会把 `thought_level` 重置为默认值）；
   - 每次 `setSessionConfigOption` 之后重新读 `response.configOptions` 再处理下一项，避免用过期的 option；
   - `optionAcceptsValue()` 会展开 select 的分组选项（DSH 的 model 是 `[{group,name,options}]` 结构），
     记住的值不在当前可选列表里（模型下线、Agent 升级）就静默跳过，保持 Agent 默认；
   - 布尔选项用 `{ type: 'boolean', value }` 判别参数，select 用 `{ value }`。
5. 例外：`mir-harness`（MIR Harness）不记 `thought_level`——它的推理强度是**每个模型**的配置项
   （默认 `max`），切换模型时 Agent 会重置成该模型的档位，记住用户上次的档位反而会覆盖模型配置。
   `sessionManager` 里用 `PER_MODEL_EFFORT_AGENTS = new Set(['mir-harness'])` +
   `skipsRememberedOption()` 同时跳过「套用」和「记录」。其它 Agent 行为不变。
6. 清理：删除 electron-store 里的 `acp-last-session-config` 键即可恢复“永远用 Agent 默认值”。

**验证**（`npm run typecheck` / `npm run build` 通过后的真机记录）：

| 场景 | 结果 |
| --- | --- |
| mock Agent：选 `mock-deep` + `thought_level=high` 后新建会话 | 新会话 `model=mock-deep, thought_level=high` ✅ |
| **重启 MIR** 后新建 mock 会话 | 仍然 `mock-deep` / `high`（electron-store 持久化生效）✅ |
| DeepSeek Harness：`acpSetModel` 切成 `magpie-responses/mccodex-mc/deepseek-v4.1-flash` 后新建会话 | 新会话 `model=["magpie-responses","mccodex-mc/deepseek-v4.1-flash"]` ✅ |
| DeepSeek Harness：再选 `reasoning_effort=high` 后新建会话 | 新会话 `model`（magpie）+ `reasoning_effort=high` 同时继承 ✅（该选项 `category` 为 `thought_level`，按分类记住）|
| UI 路径：右栏「智能体」→ DeepSeek Harness「新建会话」 | 聊天头部直接显示 `模型 = ["magpie-responses","mccodex-mc/deepseek-v4.1-flash"]`、`Reasoning effort = high`，无需手动重选 ✅ |
| 恢复历史会话（`session/load`） | 保持该会话原有配置，不被记忆覆盖 ✅ |

**注意**：DSH 在切换模型后会把 `reasoning_effort` 的当前值重置为空串（Agent 行为），
因此第一次只记模型时不会带推理强度；用户再显式选一次 `reasoning_effort` 之后就会一起记住。
