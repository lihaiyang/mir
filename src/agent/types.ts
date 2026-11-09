/**
 * MIR Harness agent 进程的内部契约。
 *
 * 这一层只描述「模型客户端 / 工具 / 会话持久化」之间怎么互相调用，
 * 具体的 ACP 协议实现放在 agent.ts，进程入口放 index.ts。
 */
import { harnessModelLabel } from '../shared/harness'
import type { HarnessConfig, HarnessReasoningEffort } from '../shared/harness'

export type HarnessMode = 'ask' | 'code'

/** 推理强度（high / max），由模型配置决定，会话内可以覆盖 */
export type ThoughtLevel = HarnessReasoningEffort

/** 会话级可变配置：可通过 ACP session/set_config_option、session/set_mode 修改 */
export interface SessionConfigValues {
  model: string
  thoughtLevel: ThoughtLevel
  mode: HarnessMode
}

/* --------------------------------- 模型 --------------------------------- */

export interface ChatToolCall {
  id: string
  name: string
  arguments: string
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** 用户消息里附带的图片（base64，不含 data: 前缀） */
export interface ChatImage {
  mimeType: string
  data: string
}

export interface ChatMessage {
  role: ChatRole
  content: string
  /** user 消息附带的图片（仅当模型支持图片时写入） */
  images?: ChatImage[]
  /** assistant 消息附带的工具调用 */
  toolCalls?: ChatToolCall[]
  /** role === 'tool' 时对应 assistant 调用的 id */
  toolCallId?: string
  /** role === 'tool' 时的工具名 */
  toolName?: string
  /** 推理内容（多数接口不回传给模型，仅用于回放 / 展示） */
  reasoning?: string
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
}

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: LlmUsage }
  | { type: 'finish'; reason: string }

export interface LlmRequest {
  messages: ChatMessage[]
  tools: ToolSpec[]
  model: string
  apiBase: string
  apiKey: string
  maxTokens: number
  reasoningEffort: ThoughtLevel
  signal: AbortSignal
}

/** OpenAI 兼容的 chat/completions 流式客户端 */
export interface LlmClient {
  stream(request: LlmRequest): AsyncGenerator<LlmEvent, void, void>
}

export class LlmError extends Error {
  readonly status?: number
  readonly body?: string

  constructor(message: string, options: { status?: number; body?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'LlmError'
    this.status = options.status
    this.body = options.body
  }
}

/** 401/403 视为「密钥需要配置」，用于把错误转成 auth_required */
export function isLlmAuthError(error: unknown): boolean {
  return error instanceof LlmError && (error.status === 401 || error.status === 403)
}

/* --------------------------------- 工具 --------------------------------- */

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema（object），直接塞进 tools[].function.parameters */
  parameters: Record<string, unknown>
}

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other'

export interface ToolLocation {
  path: string
  line?: number
}

export interface ToolCallRequest {
  id: string
  name: string
  /** 模型返回的原始 JSON 字符串 */
  arguments: string
}

export interface ToolPermissionRequest {
  title: string
  kind: ToolKind
  /** 展示在权限卡片里的说明 */
  content?: string
  locations?: ToolLocation[]
  rawInput?: unknown
}

export type ToolPermissionOutcome = 'allow_once' | 'allow_always' | 'reject'

/** 文件读写桥：优先走 ACP client 的 fs 能力（MIR 会显示文件变更），否则用本地 fs */
export interface FileBridge {
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
}

export interface ToolContext {
  cwd: string
  mode: HarnessMode
  signal: AbortSignal
  fs: FileBridge
  requestPermission(request: ToolPermissionRequest): Promise<ToolPermissionOutcome>
  /** allow_always 之后的会话级授权缓存 */
  hasAllowance(key: string): boolean
  rememberAllowance(key: string): void
}

export interface ToolResult {
  title: string
  kind: ToolKind
  /** 回传给模型的文本（已截断） */
  text: string
  /** 展示在聊天卡片里的文本；缺省用 text */
  display?: string
  locations?: ToolLocation[]
  rawInput?: unknown
  isError?: boolean
}

export interface ToolDefinition {
  spec: ToolSpec
  run(call: ToolCallRequest, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

/* -------------------------------- 会话存储 ------------------------------- */

/** 落盘的一条会话（agent 自己的会话历史，用于 list / load 回放） */
export interface PersistedSession {
  sessionId: string
  cwd: string
  title?: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  config: SessionConfigValues
}

export interface PersistedSessionSummary {
  sessionId: string
  cwd: string
  title?: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

/** 一轮 agent 运行的统计，用于 usage_update */
export interface TurnUsage {
  inputTokens: number
  outputTokens: number
}

/* ------------------------------ 共用常量 / 工具 ------------------------------ */

/** 工具结果回传给模型时的最大字符数 */
export const TOOL_OUTPUT_LIMIT = 20_000

/** 单条消息展示前的截断长度（历史回放用） */
export const REPLAY_MESSAGE_LIMIT = 800

/** 系统提示词里注入的工作目录说明 */
export function workingDirectoryNote(cwd: string): string {
  return `Current working directory: ${cwd}\n所有相对路径都相对这个目录解析；不要访问该目录之外的文件，除非用户明确要求。`
}

/** 把任意错误转成给用户看的短文本 */
export function describeError(error: unknown): string {
  // 状态码只补一次：LlmError 的 message 里通常已经带了 HTTP 状态（如「模型接口返回 HTTP 401」）
  if (error instanceof LlmError) {
    if (!error.status) return error.message
    const suffix = `HTTP ${error.status}`
    return error.message.includes(suffix) ? error.message : `${error.message}（${suffix}）`
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/** 从工具参数 JSON 里安全取字符串 */
export function readStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

export function readNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 会话配置 → 展示用文案（mocks / 日志） */
export function describeSessionConfig(config: SessionConfigValues, harness: HarnessConfig): string {
  const model = harness.models.find((item) => item.id === config.model)
  return `${model ? harnessModelLabel(model) : config.model} · thinking:${config.thoughtLevel} · mode:${config.mode}`
}
