# MIR Harness：MIR 内置 Agent

> 状态：已实现（v1 内核），随 `0.2.12-dev.0` 发布。本文记录设计、契约与验证方式；验证记录见 §8。
>
> 只想上手使用？看 [MIR Harness 上手](mir-harness-guide.md)。
>
> 相关文档：[ACP 客户端](acp-client.md)。MIR Harness 是一个 **ACP agent**，由 MIR 的 ACP 客户端驱动，
> 与 pi / DeepSeek Harness 等外部 Agent 走完全相同的协议路径——区别只是它的进程和内核由 MIR 自己提供。

## 1. 为什么要有它

MIR 的 ACP 客户端（见 `docs/acp-client.md`）目前接的都是外部 Agent（`pi`、`dsh --profile acp`）。这些 Agent
需要用户自己安装、登录、配置模型，任一环节出问题都表现为「启动失败」。MIR Harness 的目标是：

- **开箱可用**：不依赖用户机器上的 `node` / `npx` / 第三方 CLI，进程由 MIR 自己拉起；
- **配置显式**：模型接口（Base URL / API Key / 模型列表）由 MIR 设置界面管理，写在一个可读的 JSON 里；
- **协议对齐**：完整实现 ACP 的会话、配置项、模式、权限、会话列表/加载/恢复，让 MIR 的既有 UI 直接复用；
- **可扩展**：内核刻意保持小（流式对话 + 5 个工具 + 会话持久化），后续加工具 / 子 Agent / MCP 不必动协议层。

## 2. 架构

```
MIR 主进程 (ACP client)
  │  spawn: {{EXEC_PATH}} out/main/agent/index.js
  │  env:   ELECTRON_RUN_AS_NODE=1
  ▼
MIR Harness 进程（Electron 二进制以 Node 模式运行）
  ├─ index.ts      stdio ⇄ NDJSON 流，AgentSideConnection 装配
  ├─ agent.ts      ACP Agent 实现：initialize / session/* / prompt 循环
  ├─ llm.ts        OpenAI 兼容 /chat/completions 的 SSE 流式客户端
  ├─ tools.ts      read_file / write_file / list_dir / search_files / run_command
  ├─ sessions.ts   ~/.mir-harness/sessions/<id>.json 会话持久化
  └─ config.ts     ~/.mir-harness/config.json 加载（+ 环境变量覆盖）
```

### 2.1 为什么用 Electron 当 Node

`release` 版 MIR 的用户机器上不保证有 `node`。Electron 自带 Node 运行时，用
`ELECTRON_RUN_AS_NODE=1` 启动 `process.execPath` 即可把它当 Node 用：

```jsonc
// src/shared/acp.ts 的默认 Agent 配置
{
  "id": "mir-harness",
  "name": "MIR Harness",
  "command": "{{EXEC_PATH}}",                    // = process.execPath（MIR 自己的可执行文件）
  "args": ["{{APP_PATH}}/out/main/agent/index.js"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

实测 `ELECTRON_RUN_AS_NODE=1 "MIR Dev.app/Contents/MacOS/MIR Dev" -e "...readFileSync(app.asar/...)"`
可正常读取 asar 内文件，因此 agent 代码可以被打进 asar（`out/main/agent/index.js`），不额外落地脚本。

### 2.2 构建

`electron.vite.config.ts` 的 main 构建加第二个入口：

```ts
build: {
  rollupOptions: {
    input: {
      index: resolve('src/main/index.ts'),
      'agent/index': resolve('src/agent/index.ts')
    }
  }
}
```

`@agentclientprotocol/sdk` 与 `zod` 在 devDependencies，`externalizeDepsPlugin()` 只外部化 dependencies，
所以 SDK 会被内联进 `out/main/agent/index.js`；打包配置无需改动（`files: ['out/**/*', 'package.json']`）。

## 3. 配置

### 3.1 配置文件

路径：`~/.mir-harness/config.json`（`MIR_HARNESS_CONFIG` 可覆盖）。
字段级环境覆盖：`MIR_HARNESS_API_BASE` / `MIR_HARNESS_API_KEY` / `MIR_HARNESS_MODEL`。

```jsonc
{
  "apiBase": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-chat",
  "models": [
    { "id": "deepseek-chat", "name": "DeepSeek Chat" },
    { "id": "deepseek-reasoner", "name": "DeepSeek Reasoner" },
    // 单个模型可以覆盖接口地址 / 密钥（用于聚合网关）
    { "id": "workbuddy/deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash", "apiBase": "http://127.0.0.1:3425/v1", "apiKey": "magpie" }
  ],
  "temperature": 0.2,
  "maxTokens": 8192,
  "maxTurns": 24,              // 单轮最多「模型 → 工具」循环次数
  "contextWindow": 128000,     // 仅用于 usage_update 的 size 展示
  "systemPrompt": "...",
  "approvalMode": "ask",       // ask | auto（工作区内自动批准写文件与命令）
  "sendReasoningEffort": false // 是否把 thought_level 作为 reasoning_effort 传给接口
}
```

读写规则：

- 主进程 `src/main/acp/harnessConfig.ts` 负责读 / 原子写（临时文件 + rename），供设置界面使用；
- agent 进程 `src/agent/config.ts` **每次新建会话都重新读取**，所以设置里改完配置，新建会话即生效，无需重启 agent；
- 文件缺失 / JSON 损坏 → 回落到默认值，不阻塞启动（设置界面会显示解析错误）。

### 3.2 设置界面

`设置 → ACP 智能体 → MIR Harness`（`src/renderer/src/components/HarnessSettingsSection.vue`）：
接口地址、密钥（密码框）、模型列表（每项可覆盖 Base/Key）、温度、max tokens、轮数上限、上下文窗口、
系统提示词、审批模式、`sendReasoningEffort`；显示配置文件路径、环境变量覆盖提示、解析错误。

### 3.3 自动拉取模型

设置界面里的「从接口拉取模型」按钮会按接口地址请求模型列表，不必手抄模型 id：

| 接口类型 | 请求 | 认证方式 |
| --- | --- | --- |
| OpenAI 兼容（默认） | `{apiBase}/models` | `Authorization: Bearer <key>` |
| Anthropic | `{apiBase}/models` | `x-api-key` + `anthropic-version: 2023-06-01` |
| Google Gemini | `{apiBase}/models?key=<key>`（`models/` 前缀自动去掉） | query 参数 |
| Ollama | `{origin}/api/tags` | 无（本地） |
| 通用 JSON | `{apiBase}/models` 或 `{origin}/api/tags` | 可选 Bearer |

- 端点按地址启发式判断（`generativelanguage.googleapis.com` / `googleapis.com` / anthropic / ollama / `:11434`），
  最多依次尝试 4 个候选，第一个返回可用模型的候选生效；全部失败时给出汇总原因（401/403、非 JSON、超时、空列表）；
- 地址没写版本段时自动补 `/v1`，已带 `/v1`（或 `/v1beta`）则不重复拼接；
- 地址或密钥失焦时会**自动拉取一次**（仅当模型列表还是默认值、或与上次拉取结果一致时，避免覆盖手改内容）；
- 合并策略：列表仍是默认值 / 与上次拉取一致 / 为空 → 整表替换；用户手工加过条目 → 只追加新模型，保留自定义
  `name`、`apiBase`、`apiKey` 覆盖项。

实现位置：`src/shared/harnessModels.ts`（纯函数，便于单测）、`src/main/acp/index.ts` 的
`acp:discover-harness-models` IPC、`HarnessSettingsSection.vue` 的 `fetchModels()` / `mergeFetchedModels()`。

## 4. ACP 能力

### 4.1 initialize

```jsonc
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
    "sessionCapabilities": { "list": {}, "resume": {}, "close": {} }
  },
  "authMethods": [{
    "id": "config",
    "name": "配置模型接口",
    "description": "在 MIR 设置 → ACP 智能体 → MIR Harness 配置中填写 API Base / API Key"
  }],
  "agentInfo": { "name": "mir-harness", "title": "MIR Harness", "version": "0.1.0" }
}
```

未配置 `apiKey` 时 `session/new` 返回 `RequestError(-32000, ...)`，MIR 会走「需要认证」提示与
`authenticate({ methodId: 'config' })` 重试流程；用户填好密钥后重试即可。

### 4.2 会话配置项（configOptions）

| id | category | type | 值 |
| --- | --- | --- | --- |
| `model` | `model` | select | `config.models` 里的模型 id |
| `thought_level` | `thought_level` | select | `off` / `low` / `medium` / `high` |

变更通过 `session/set_config_option` 落库到会话内存并回 `config_option_update` 通知；
`session/set_mode` 切换 `ask` / `code` 并回 `current_mode_update`。

> MIR 侧已有「记住上次选择」逻辑（`src/main/acp/sessionPrefs.ts`），按 `category` 记录，
> 所以 MIR Harness 的模型 / 推理强度也会被记住并在新会话创建时自动套用。

### 4.3 斜杠命令

`session/new` 后通过 `available_commands_update` 通告：

- `/clear` — 清空当前会话上下文（保留会话 id 与标题）；
- `/status` — 回复当前模型 / 推理强度 / 模式 / 历史条数。

### 4.4 会话持久化与回放

- 每个会话落盘到 `~/.mir-harness/sessions/<sessionId>.json`：`{ sessionId, cwd, title, createdAt, updatedAt, messages, config }`；
- `session/list` 从磁盘读摘要（可按 cwd 过滤），支持 MIR 的「从 agent 加载会话」；
- `session/load` 先登记会话再回放历史（user / assistant / thought 分块 + 工具调用卡片），返回 `{ modes, configOptions }`；
- `session/resume` 只恢复会话状态不回放；`session/close` 只从内存移除，磁盘历史保留。

## 5. 内核

### 5.1 一轮 prompt

1. 解析 `ContentBlock[]`（`text` / `resource_link`），空提示词报错；
2. 处理斜杠命令；
3. 用户消息入库（首条消息生成会话标题）；
4. 最多 `maxTurns` 轮：
   - 调 `llm.stream()`：`agent_message_chunk` 实时转发文本、`agent_thought_chunk` 转发 `reasoning_content`；
   - 无工具调用 → 入库、`usage_update`、`end_turn`；
   - 有工具调用 → 发 `tool_call`（in_progress）→ 执行（写文件/执行命令前 `requestPermission`）→
     发 `tool_call_update`（completed/failed）→ 工具结果作为 `role: 'tool'` 消息进入下一轮；
5. 取消 → `AbortController` 中止流与工具，返回 `stopReason: 'cancelled'`；
6. 达到轮数上限 → `stopReason: 'max_turn_requests'`。

鉴权失败（HTTP 401/403）转成 `RequestError(-32000)`，其它模型错误转 `RequestError(-32603)`，
由 MIR 呈现为「本轮失败」提示。

### 5.2 工具

| 工具 | 参数 | 权限 |
| --- | --- | --- |
| `read_file` | `path`, `line?`, `limit?`（默认 400，最大 2000） | 无 |
| `write_file` | `path`, `content`（限制在工作目录内） | ask：询问；code：自动；`allow_always` 记入会话 |
| `list_dir` | `path?`（默认 `.`） | 无 |
| `search_files` | `pattern`（正则）, `path?`, `ext?` | 无 |
| `run_command` | `command`, `timeoutMs?`（默认 60s，最大 600s） | 同 `write_file` |

- 文件读写优先走 ACP client 的 `fs` 能力（MIR 会显示文件变更并广播 `file-written` 事件），
  不可用时回落本地 `node:fs`；
- 工具输出统一截断到 20k 字符（保留尾部并标注）；
- 写文件越出工作目录直接返回错误文本，不弹权限。

## 6. 验证

自动化（`npm run harness:selftest` → `scripts/mir-harness-selftest.mjs`，需先 `npm run build`）：

- 假 OpenAI SSE 服务 + 真实 ACP 客户端，覆盖 initialize 能力、newSession 的 modes/configOptions、
  流式文本与推理分块、工具调用与权限、取消、`set_config_option` / `set_mode`、`session/list` + `session/load` 回放、
  未配置密钥时的 `-32000`；
- 真实模型联调：本机 magpie 网关（`http://127.0.0.1:3425/v1`，OpenAI 兼容、真流式）验证流式输出与工具调用；
- MIR 真机：设置界面保存配置 → 右栏新建 MIR Harness 会话 → 对话 / 权限卡片 / 取消 / 恢复历史。
- 模型发现：`npm run harness:models-test` 用本地假接口覆盖五种接口格式与失败路径，另对真实 magpie 网关验证一次。

验证记录见文末。

## 7. 已知限制（v1）

- 不支持图片 / 音频输入（`promptCapabilities` 声明为 false）；
- 不支持 MCP server（`session/new` 的 `mcpServers` 参数被忽略）；
- 工具集刻意保持小：没有编辑 diff、多文件批量写、后台任务；
- 单会话单轮串行：一轮未结束时再次 `prompt` 会被 MIR 侧禁用（composer 在处理中禁用发送）；
- 上下文不做自动裁剪（超过 `contextWindow` 由模型接口自己报错），后续可加摘要 / 裁剪；
- 不内置凭据管理：密钥以明文存在 `~/.mir-harness/config.json`（与多数 CLI Agent 一致）。


## 8. 实施与验证记录

### 8.1 落盘文件

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/shared/harness.ts` | 268 | 配置 DTO、默认值、`normalizeHarnessConfig()`、模型标签与解析（主进程 / 渲染器 / agent 共用） |
| `src/agent/types.ts` | 260 | 内核类型（`LlmEvent`、`ToolDefinition`、`PersistedSession`…）与 `describeError()` |
| `src/agent/config.ts` | 127 | 读取 `~/.mir-harness/config.json` + 环境变量覆盖 |
| `src/agent/llm.ts` | 381 | OpenAI 兼容流式客户端（手写 SSE 解析） |
| `src/agent/sessions.ts` | 278 | 会话落盘（原子写、UUID 白名单、损坏文件跳过） |
| `src/agent/tools.ts` | 872 | 5 个工具 + 权限 / 超时 / 输出截断 |
| `src/agent/agent.ts` | 1295 | `HarnessAgent implements Agent`，prompt 循环、权限桥、文件桥、回放 |
| `src/agent/index.ts` | 99 | 进程入口：`ndJsonStream` + `AgentSideConnection`，日志全走 stderr |
| `src/main/acp/harnessConfig.ts` | 92 | 主进程读写配置文件（供设置界面） |
| `src/renderer/src/components/HarnessSettingsSection.vue` | 874 | 设置界面（表单、模型列表、从接口拉取、保存 / 重新加载） |
| `scripts/mir-harness-selftest.mjs` | 747 | 假 OpenAI SSE 服务 + 真 ACP 客户端，49 条断言 |
| `src/shared/harnessModels.ts` | 363 | 模型列表发现：端点推断、五种格式解析、错误汇总 |
| `scripts/harness-models-test.mjs` | 371 | 本地假接口覆盖五种格式与 401 / 非 JSON / 超时 / 非法地址，12 条断言 |

构建接线：`electron.vite.config.ts` 的 `main.build.rollupOptions.input` 增加 `agent/index`，产物 `out/main/agent/index.js`（约 83 KB，SDK 已内联，可 `node` 直接运行）。

### 8.2 默认 Agent 与迁移

`DEFAULT_ACP_AGENTS` 现在是 `mir-harness` / `pi` / `deepseek-harness`（mock 从默认列表移除，脚本保留给自测）。
`ACP_CONFIG_VERSION` 升到 3：旧配置里命中旧默认签名（包括 mock）的项会被替换为新默认项，用户自建项保留；`{{EXEC_PATH}}` 在启动 agent 时展开为 `process.execPath`，配合 `ELECTRON_RUN_AS_NODE=1` 让内置 Agent 不依赖系统 `node`。

### 8.3 验证结果

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0（node + web） |
| `npm run build` | exit 0，`out/main/agent/index.js` 生成 |
| `npm run acp:selftest` | ALL PASS — 43 checks |
| `npm run harness:selftest` | ALL PASS — 49 checks（9 组：initialize / newSession / 流式 / 工具两轮 / 取消 / 配置与模式 / list+load / 无密钥 / 401） |
| 真实网关端到端（`/tmp/mir-harness-e2e`，magpie `workbuddy/deepseek-v4.1-flash`） | ALL PASS — 29/29，含真实流式（26 个 chunk / 3.5s）、`read_file` 工具往返、取消 2ms 返回 `cancelled`、`session/list` + `session/load` 回放 |
| MIR 真机（CDP 驱动） | 新建会话 → 流式渲染（33→278 字符渐进）、权限卡片 → 允许一次 → 文件写入成功、取消 → 「已取消本轮」、模型 / 推理强度记忆跨会话生效、历史恢复 10 条消息且无残留「输出中」状态 |
| `npm run harness:models-test` | ALL PASS — 12 checks（OpenAI / 已带 `/v1` / Gemini / Anthropic / Ollama / 通用数组 / 解析直测 / 候选直测 / 401 / 非 JSON / 超时 / 非法地址） |
| 真实网关模型发现 | magpie `GET http://127.0.0.1:3425/v1/models` → `format=openai`、12 个模型，端点推断与打码正常 |
| MIR 真机「从接口拉取模型」 | 列表从 2 条变 12 条 + 绿色状态「已从OpenAI 兼容接口拉取 12 个模型」；手改的自定义行在再次拉取后被保留（13 行）；重载页面后自动拉取生效；保存写回 12 条；新建会话的 `model` configOptions 为 12 项 |

### 8.4 实现中发现的问题（已修）

- **`session/load` 回放后气泡残留 streaming**：回放没有 `prompt-end` 事件，渲染器最后一个 agent 气泡一直显示输出中。修复：`src/renderer/src/stores/acp.ts` 的 `loadSession()` 在 IPC 返回后补一次 `finishStreaming(placeholder)`。
- **401 文案重复**：`LlmError.message` 已是「模型接口返回 HTTP 401」，`describeError()` 又拼了一次状态码。修复：`src/agent/types.ts` 里状态码只补一次。
- **magpie 网关在有 `tools` 时不返回 `reasoning_content`**：同一模型不带工具时有推理增量，带工具时为 0。属网关行为，`agent_thought_chunk` 逻辑本身正确；文档如实记录，不当作缺陷。

### 8.5 真机验证注意

- MIR 用 `MIR_HARNESS_CONFIG` 可指向临时配置做联调（agent 进程继承主进程环境），验证完删除 dev store 的 `acp*` 键即可恢复干净状态；
- 会话历史在 `~/.mir-harness/sessions`，联调时用临时 `HOME` 或事后清理；
- 设置界面保存后提示「新建会话后生效」：已存在的会话仍可用模型 / 推理强度下拉切换（agent 每次读取配置文件），但默认模式等只在新建时读取。
