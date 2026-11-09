/**
 * ACP（Agent Client Protocol）主进程 ↔ 渲染进程共享契约。
 *
 * 只放 DTO 与常量：不引入任何运行时代码，协议类型用 `import type` 从 SDK 引入，
 * 编译期会被擦除，因此渲染器不会把 SDK 打进 bundle。
 */
import type {
  AvailableCommand,
  ContentBlock,
  PermissionOption,
  PlanEntry,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCall,
  ToolCallUpdate,
  UsageUpdate
} from '@agentclientprotocol/sdk'

export type {
  AvailableCommand,
  ContentBlock,
  PermissionOption,
  PlanEntry,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCall,
  ToolCallUpdate,
  UsageUpdate
}

/* -------------------------------------------------------------------------- */
/* 配置                                                                        */
/* -------------------------------------------------------------------------- */

export interface AcpAgentConfig {
  /** 稳定 id，用于会话归属与配置持久化 */
  id: string
  /** 展示名 */
  name: string
  /** 可执行文件或命令（经登录 shell 执行，支持 npx/uvx 等） */
  command: string
  args?: string[]
  env?: Record<string, string>
  description?: string
  /** 默认 true */
  enabled?: boolean
}

export type AcpAutoApprove = 'ask' | 'allowAll'

export interface AcpConfig {
  agents: AcpAgentConfig[]
  autoApprovePermissions: AcpAutoApprove
  logTraffic: boolean
  /**
   * 对「整段到达」的回复做打字机式渐进显示。
   *
   * 有些 Agent（如 DeepSeek Harness 的 ACP profile）按设计只在 assistant 消息
   * 提交后才下发一个 agent_message_chunk，协议层没有 token 增量；开启后渲染层
   * 会把这类整段文本匀速展开，纯粹是呈现效果，不改变协议流量。
   */
  smoothStreaming: boolean
  /** 新建会话时的默认工作目录（空则用当前项目路径） */
  defaultWorkingDirectory?: string
}

/* -------------------------------------------------------------------------- */
/* Agent 运行时                                                                 */
/* -------------------------------------------------------------------------- */

export type AcpAgentStatus = 'idle' | 'starting' | 'ready' | 'error' | 'closed'

export interface AcpAgentCapabilities {
  loadSession: boolean
  listSessions: boolean
  resumeSession: boolean
  promptImages: boolean
  promptAudio: boolean
  promptEmbeddedContext: boolean
  terminal: boolean
}

export interface AcpAgentRuntimeInfo {
  agentId: string
  status: AcpAgentStatus
  pid?: number
  error?: string
  /** stderr 尾部（诊断用） */
  stderrTail?: string
  capabilities?: AcpAgentCapabilities
  /** 该 Agent 上存活的会话数 */
  sessionCount?: number
}

export interface AcpAuthMethod {
  id: string
  name: string
  description?: string
}

/* -------------------------------------------------------------------------- */
/* 会话                                                                        */
/* -------------------------------------------------------------------------- */

export type AcpSessionStatus = 'active' | 'loading' | 'interrupted' | 'closed'

export interface AcpSessionSummary {
  sessionId: string
  agentId: string
  agentName: string
  cwd: string
  title?: string
  firstPrompt?: string
  createdAt: number
  updatedAt: number
  status: AcpSessionStatus
  supportsLoad: boolean
  supportsResume: boolean
}

export interface AcpSessionDetail extends AcpSessionSummary {
  modes?: SessionModeState
  configOptions?: SessionConfigOption[]
  availableCommands?: AvailableCommand[]
  usage?: UsageUpdate
}

/** Agent 端 session/list 返回的条目（用于历史会话列表） */
export interface AcpRemoteSession {
  sessionId: string
  cwd?: string
  title?: string
  updatedAt?: number
}

export interface AcpHistoryEntry {
  agentId: string
  sessionId: string
  cwd: string
  title?: string
  firstPrompt?: string
  createdAt: number
  lastActiveAt: number
}

/* -------------------------------------------------------------------------- */
/* Agent Registry                                                              */
/* -------------------------------------------------------------------------- */

export interface AcpRegistryAgent {
  id: string
  name: string
  version?: string
  description?: string
  repository?: string
  website?: string
  authors?: string[]
  license?: string
  icon?: string
  /** 可直接落库的启动配置（npx / 本机二进制） */
  command?: string
  args?: string[]
  /** 无法在当前平台运行时给出说明 */
  unavailableReason?: string
}

/* -------------------------------------------------------------------------- */
/* 请求 / 事件                                                                  */
/* -------------------------------------------------------------------------- */

export type AcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string }

export interface AcpPermissionRequest {
  requestId: string
  sessionId: string
  agentId: string
  toolCall: ToolCallUpdate
  options: PermissionOption[]
  createdAt: number
}

export interface AcpTrafficEntry {
  id: number
  at: number
  direction: 'send' | 'receive'
  agentId: string
  /** JSON-RPC method 或响应 id */
  label: string
  payload: unknown
}

export type AcpEvent =
  | { type: 'agent-status'; info: AcpAgentRuntimeInfo }
  | { type: 'session-created'; session: AcpSessionDetail }
  | { type: 'session-updated'; sessionId: string; patch: Partial<AcpSessionSummary> }
  | { type: 'session-removed'; sessionId: string }
  | { type: 'session-update'; sessionId: string; update: SessionUpdate }
  | { type: 'permission-request'; request: AcpPermissionRequest }
  | { type: 'permission-resolved'; requestId: string; optionId: string | null }
  | { type: 'prompt-start'; sessionId: string }
  | { type: 'prompt-end'; sessionId: string; stopReason?: StopReason; error?: string }
  | { type: 'auth-required'; agentId: string; sessionId?: string; methods: AcpAuthMethod[] }
  | { type: 'file-written'; sessionId?: string; path: string }
  | { type: 'agent-stderr'; agentId: string; chunk: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string; sessionId?: string }

export interface AcpStateSnapshot {
  agents: AcpAgentRuntimeInfo[]
  sessions: AcpSessionDetail[]
  permissions: AcpPermissionRequest[]
}

/* -------------------------------------------------------------------------- */
/* 默认 Agent 列表（与参考实现对齐）                                             */
/* -------------------------------------------------------------------------- */

/**
 * 默认可用的 ACP Agent。
 *
 * 当前只内置「Pi Coding Agent」「DeepSeek Harness」两个真实 Agent，外加一个
 * 本地 mock agent 用于离线自测；其它 Agent 可在设置里自行添加（或从注册表浏览）。
 */
export const DEFAULT_ACP_AGENTS: AcpAgentConfig[] = [
  {
    id: 'pi',
    name: 'Pi Coding Agent',
    command: 'npx',
    args: ['-y', 'pi-acp@latest'],
    description: 'pi 编码智能体，经 pi-acp 适配为 ACP'
  },
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    command: 'dsh',
    args: ['--profile', 'acp'],
    description: 'DeepSeek Harness 的 ACP 服务（dsh --profile acp）'
  },
  {
    id: 'mock',
    name: 'Mock Agent (调试)',
    command: 'node',
    args: ['{{APP_PATH}}/scripts/acp-mock-agent.mjs'],
    description: '本地假 Agent，用于 UI/协议自测，无需登录与联网'
  }
]

export const DEFAULT_ACP_CONFIG: AcpConfig = {
  agents: DEFAULT_ACP_AGENTS,
  autoApprovePermissions: 'ask',
  logTraffic: false,
  // 默认开启：DeepSeek Harness 等 Agent 按设计整段下发文本，开启后观感更接近流式；
  // 真正流式的 Agent（pi 等）增量很小，会原样透传，不受影响。
  smoothStreaming: true
}
