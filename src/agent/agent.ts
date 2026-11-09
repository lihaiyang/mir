/**
 * MIR Harness —— ACP Agent 实现。
 *
 * 这一层只做协议与编排：把 ACP 的 session / prompt 请求翻译成
 * 「模型流式输出 → 工具调用 → 结果回灌 → 下一轮」的循环，再把过程实时转成
 * `sessionUpdate` 通知。模型客户端（llm.ts）、工具（tools.ts）、会话持久化
 * （sessions.ts）、配置（config.ts）都在各自模块里，本文件不碰网络与文件格式细节。
 *
 * 几个刻意为之的约束：
 * - **不 import electron**：进程由 Electron 以 `ELECTRON_RUN_AS_NODE=1` 启动，只能当 Node 用；
 * - stdout 归 ACP 流所有，日志一律走 stderr；
 * - 任何「工具 / 文件 / 配置」层面的失败都不应该炸掉 JSON-RPC 流：能降级成一轮错误就降级，
 *   只有鉴权失败（-32000）和内部错误（-32603）会以 JSON-RPC error 返回给客户端。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  AvailableCommand,
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  ToolCallContent
} from '@agentclientprotocol/sdk'
import type { HarnessConfig } from '../shared/harness'
import { loadHarnessConfig, modelChoices, resolveModelForSession } from './config'
import { createOpenAiLlmClient } from './llm'
import {
  deriveTitle,
  listPersistedSessions,
  newSessionId,
  readPersistedSession,
  writePersistedSession
} from './sessions'
import { findTool, getToolSpecs } from './tools'
import {
  REPLAY_MESSAGE_LIMIT,
  describeError,
  isLlmAuthError,
  workingDirectoryNote
} from './types'
import type {
  ChatMessage,
  ChatToolCall,
  HarnessMode,
  LlmRequest,
  PersistedSession,
  PersistedSessionSummary,
  SessionConfigValues,
  ThoughtLevel,
  ToolContext,
  ToolLocation,
  ToolPermissionOutcome,
  ToolPermissionRequest,
  ToolResult,
  TurnUsage
} from './types'

/* --------------------------------- 常量 --------------------------------- */

const AGENT_INFO = { name: 'mir-harness', title: 'MIR Harness', version: '0.1.0' }

/** MIR 客户端识别 -32000 会走「需要认证 → 打开设置」流程 */
const AUTH_REQUIRED_CODE = -32000
const INVALID_PARAMS_CODE = -32602
const INTERNAL_ERROR_CODE = -32603

const AUTH_METHODS = [
  {
    id: 'config',
    name: '配置模型接口',
    description: '在 MIR 设置 → ACP 智能体 → MIR Harness 配置中填写 API Base / API Key'
  }
]

const AVAILABLE_COMMANDS: AvailableCommand[] = [
  { name: 'clear', description: '清空当前会话上下文（保留会话 id 与标题）' },
  { name: 'status', description: '查看当前模型、推理强度、模式与历史条数' }
]

const THOUGHT_LEVELS: readonly ThoughtLevel[] = ['off', 'low', 'medium', 'high']
const THOUGHT_LEVEL_OPTIONS: { value: string; name: string }[] = [
  { value: 'off', name: 'Off' },
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' }
]
const THOUGHT_LEVEL_DEFAULT: ThoughtLevel = 'medium'

const MODE_DEFINITIONS = [
  { id: 'ask', name: 'Ask', description: '写文件 / 执行命令前先询问' },
  { id: 'code', name: 'Code', description: '工作区内自动批准写文件与命令' }
] as const

/** 单次权限请求超时兜底（MIR 自己也有 60s 超时，这里只是防御） */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

const DEBUG_ENABLED = process.env.MIR_HARNESS_DEBUG === '1' || process.env.MIR_HARNESS_DEBUG === 'true'

/* --------------------------------- 日志 --------------------------------- */

function log(line: string): void {
  try {
    process.stderr.write(`[mir-harness] ${line}\n`)
  } catch {
    // stderr 被父进程关掉时不能再抛，安静丢弃
  }
}

function debug(line: string): void {
  if (DEBUG_ENABLED) log(line)
}

/* ------------------------------- 内部类型 ------------------------------- */

/** 连接 / 会话状态变化导致 sessionUpdate 投递失败：整轮按「已取消」收尾 */
class TurnCancelled extends Error {
  constructor(message = '客户端连接已关闭') {
    super(message)
    this.name = 'TurnCancelled'
  }
}

/** 流式 tool_call 的累积槽：id / name 通常只在第一帧出现 */
interface PendingToolCall {
  id?: string
  name?: string
  arguments: string
}

/** 内存里的一个会话 */
interface HarnessSession {
  sessionId: string
  cwd: string
  title?: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  config: SessionConfigValues
  /** allow_always 之后的会话级授权缓存，键由工具自己定义 */
  allowances: Set<string>
  /** 进行中的一轮；null 表示空闲 */
  abort: AbortController | null
  /** 会话累计 tokens（usage_update 展示用） */
  usage: TurnUsage
  /** 已经发过 ACP tool_call 的 id，避免同一 id 的卡片互相覆盖 */
  usedToolCallIds: Set<string>
}

/** 客户端声明的 fs 能力（决定文件读写走 ACP 还是本地 node:fs） */
interface ClientFileCapabilities {
  readTextFile: boolean
  writeTextFile: boolean
}

type ParsedArguments = { ok: true; args: Record<string, unknown> } | { ok: false; error: string }

type SlashCommand = 'clear' | 'status'

/* --------------------------------- 工具函数 ------------------------------- */

function textContent(text: string): ToolCallContent {
  return { type: 'content', content: { type: 'text', text } }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 新会话的默认模式：`approvalMode: 'auto'` 对应 code（工作区内自动批准） */
function defaultMode(config: HarnessConfig): HarnessMode {
  return config.approvalMode === 'auto' ? 'code' : 'ask'
}

/**
 * ACP 的 fs 请求不做 cwd 解析（客户端直接用 params.path），所以相对路径必须在这里
 * 按会话 cwd 补全，否则会落到 agent 进程自己的 cwd 上。
 */
function resolveSessionPath(cwd: string, path: string): string {
  const text = typeof path === 'string' ? path.trim() : ''
  if (!text) throw new Error('文件路径为空')
  return isAbsolute(text) ? text : resolve(cwd, text)
}

function normalizeCwd(cwd: string | null | undefined): string | undefined {
  if (typeof cwd !== 'string') return undefined
  const text = cwd.trim()
  return text ? resolve(text) : undefined
}

/** 会话 cwd 优先用持久化的那个；磁盘上的目录被删了就退回落 cwd / 进程 cwd */
function pickSessionCwd(preferred: string | undefined, requested: string | null | undefined): string {
  const candidates = [normalizeCwd(preferred), normalizeCwd(requested)].filter(
    (value): value is string => value !== undefined
  )
  for (const candidate of candidates) {
    if (isDirectory(candidate)) return candidate
  }
  if (candidates.length > 0) {
    log(`会话工作目录不存在：${candidates[0]}，仍按该路径打开（工具调用会失败）`)
    return candidates[0]
  }
  return resolve(process.cwd())
}

function requireWorkingDirectory(cwd: string): string {
  const text = typeof cwd === 'string' ? cwd.trim() : ''
  if (!text) throw new RequestError(INVALID_PARAMS_CODE, '工作目录不存在')
  const absolute = resolve(text)
  if (!isDirectory(absolute)) throw new RequestError(INVALID_PARAMS_CODE, '工作目录不存在')
  return absolute
}

function promptToText(blocks: ContentBlock[] | null | undefined): string {
  const parts: string[] = []
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      if (block.text) parts.push(block.text)
    } else if (block.type === 'resource_link') {
      // 不把资源内容读进来（不一定是文本），只给模型一个可引用的位置
      parts.push(`[资源] ${block.uri}`)
    }
  }
  return parts.join('\n').trim()
}

function slashCommandOf(text: string): SlashCommand | undefined {
  const match = /^\s*\/([a-z][\w-]*)/i.exec(text)
  const name = match?.[1]?.toLowerCase()
  if (name === 'clear' || name === 'status') return name
  return undefined
}

function parseToolArguments(raw: string): ParsedArguments {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return { ok: true, args: {} }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '参数必须是一个 JSON 对象' }
    }
    return { ok: true, args: parsed as Record<string, unknown> }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

function collectToolCalls(pending: Map<number, PendingToolCall>): ChatToolCall[] {
  return [...pending.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      id: (call.id ?? '').trim() || `call_${index}`,
      name: (call.name ?? '').trim(),
      arguments: call.arguments
    }))
}

function firstString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'target', 'directory', 'dir'] as const
const PATH_LIST_KEYS = ['paths', 'files'] as const

/** tool_call 卡片上的路径提示：从参数里猜，猜不到就不给 */
function extractLocations(args: Record<string, unknown>, cwd: string): ToolLocation[] | undefined {
  const raw: string[] = []
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) raw.push(value.trim())
  }
  for (const key of PATH_LIST_KEYS) {
    const value = args[key]
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) raw.push(item.trim())
    }
  }
  const unique = [...new Set(raw)].slice(0, 5)
  if (unique.length === 0) return undefined
  return unique.map((path) => ({
    path: isAbsolute(path) ? path : resolve(cwd, path)
  }))
}

const KIND_RULES: readonly { pattern: RegExp; kind: ToolResult['kind'] }[] = [
  { pattern: /delete|remove|unlink|\brm\b/i, kind: 'delete' },
  { pattern: /move|rename/i, kind: 'move' },
  { pattern: /write|create|edit|patch|replace|insert|apply/i, kind: 'edit' },
  { pattern: /read|view|cat|open|show|list|glob/i, kind: 'read' },
  { pattern: /search|grep|find|query/i, kind: 'search' },
  { pattern: /run|exec|command|shell|bash|terminal|test|build/i, kind: 'execute' },
  { pattern: /fetch|http|web|download|curl/i, kind: 'fetch' },
  { pattern: /think|plan|todo|reason/i, kind: 'think' }
]

/** 工具名 → ACP kind（执行结束后会用工具返回的 result.kind 修正） */
function kindForTool(name: string): ToolResult['kind'] {
  const text = (name ?? '').trim()
  if (!text) return 'other'
  for (const rule of KIND_RULES) {
    if (rule.pattern.test(text)) return rule.kind
  }
  return 'other'
}

/** 工具执行前的兜底标题：工具名 + 关键参数，比光秃秃的 read_file 好读 */
function describeToolCall(name: string, args: Record<string, unknown>): string {
  const label = (name ?? '').trim() || '工具调用'
  const target = firstString(args, ['path', 'file_path', 'filePath', 'file', 'target', 'directory', 'dir', 'command', 'pattern'])
  if (!target) return label
  const single = target.replace(/\s+/g, ' ').trim()
  return single.length > 120 ? `${label} · ${single.slice(0, 120)}…` : `${label} · ${single}`
}

function promptUsage(usage: TurnUsage): PromptResponse['usage'] {
  const inputTokens = Math.max(0, Math.round(usage.inputTokens))
  const outputTokens = Math.max(0, Math.round(usage.outputTokens))
  if (inputTokens === 0 && outputTokens === 0) return undefined
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  if (error instanceof TurnCancelled) return true
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError' || name === 'TurnCancelled'
}

/** 与 AbortSignal 竞速用：abort 时返回 null，让权限请求按「拒绝」处理 */
function abortOutcome(signal: AbortSignal): Promise<null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise<null>((resolveAbort) => {
    signal.addEventListener('abort', () => resolveAbort(null), { once: true })
  })
}

function replayText(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  if (!value.trim()) return ''
  return value.length > REPLAY_MESSAGE_LIMIT ? `${value.slice(0, REPLAY_MESSAGE_LIMIT)}…` : value
}

/* ------------------------------ HarnessAgent ---------------------------- */

export class HarnessAgent implements Agent {
  private readonly connection: AgentSideConnection
  private readonly sessions = new Map<string, HarnessSession>()
  private clientFs: ClientFileCapabilities = { readTextFile: false, writeTextFile: false }

  constructor(connection: AgentSideConnection) {
    this.connection = connection
  }

  /* ---------------------------- 生命周期 / 能力 ---------------------------- */

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const capabilities = params.clientCapabilities
    this.clientFs = {
      readTextFile: capabilities?.fs?.readTextFile === true,
      writeTextFile: capabilities?.fs?.writeTextFile === true
    }
    debug(
      `initialize: protocolVersion=${params.protocolVersion} ` +
        `client=${params.clientInfo?.title ?? params.clientInfo?.name ?? 'unknown'} ` +
        `fs=${this.clientFs.readTextFile ? 'read' : '-'}/${this.clientFs.writeTextFile ? 'write' : '-'}`
    )
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} }
      },
      authMethods: AUTH_METHODS,
      agentInfo: AGENT_INFO
    }
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    // 配置由 MIR 设置界面写文件，认证就是「重新读一遍配置，看看密钥有了没」
    const config = this.loadConfig('authenticate')
    const resolved = resolveModelForSession(config, config.model)
    if (!resolved.apiKey || !resolved.apiKey.trim()) {
      throw new RequestError(AUTH_REQUIRED_CODE, '配置里仍然没有 API Key')
    }
    log('authenticate: API Key 已就绪')
    return {}
  }

  /* -------------------------------- 会话 -------------------------------- */

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const cwd = requireWorkingDirectory(params.cwd)
    const config = this.loadConfig('session/new')
    // 每次新建会话都重新读配置：MIR 设置里改完，下一次新建就生效
    this.requireApiKey(config)

    const now = Date.now()
    const session: HarnessSession = {
      sessionId: newSessionId(),
      cwd,
      createdAt: now,
      updatedAt: now,
      messages: [],
      config: {
        model: config.model,
        thoughtLevel: THOUGHT_LEVEL_DEFAULT,
        mode: defaultMode(config)
      },
      allowances: new Set<string>(),
      abort: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      usedToolCallIds: new Set<string>()
    }
    this.sessions.set(session.sessionId, session)
    log(`session/new ${session.sessionId} cwd=${cwd} model=${session.config.model} mode=${session.config.mode}`)
    this.announceCommands(session)

    return {
      sessionId: session.sessionId,
      modes: this.modesFor(session),
      configOptions: this.configOptionsFor(session, config)
    }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const persisted = readPersistedSession(params.sessionId)
    if (!persisted) throw new RequestError(INVALID_PARAMS_CODE, '会话不存在')

    const config = this.loadConfig('session/load')
    const session = this.restoreSession(persisted, config, params.cwd)
    log(`session/load ${session.sessionId} cwd=${session.cwd} messages=${session.messages.length}`)

    // 先登记再回放：MIR 收到回放 chunk 时就能按 sessionId 归位
    this.register(session)
    await this.replayHistory(session)
    this.announceCommands(session)

    return { modes: this.modesFor(session), configOptions: this.configOptionsFor(session, config) }
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const persisted = readPersistedSession(params.sessionId)
    if (!persisted) throw new RequestError(INVALID_PARAMS_CODE, '会话不存在')

    const config = this.loadConfig('session/resume')
    const session = this.restoreSession(persisted, config, params.cwd)
    log(`session/resume ${session.sessionId} cwd=${session.cwd} messages=${session.messages.length}`)
    this.register(session)
    this.announceCommands(session)

    return { modes: this.modesFor(session), configOptions: this.configOptionsFor(session, config) }
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    let summaries: PersistedSessionSummary[]
    try {
      summaries = listPersistedSessions(normalizeCwd(params.cwd))
    } catch (error) {
      log(`session/list failed: ${describeError(error)}`)
      throw new RequestError(INTERNAL_ERROR_CODE, `读取会话列表失败：${describeError(error)}`)
    }
    const sessions = summaries.map((summary) => this.toSessionInfo(summary))
    debug(`session/list cwd=${params.cwd ?? '(all)'} -> ${sessions.length}`)
    return { sessions, nextCursor: null }
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    // 只释放内存：磁盘历史保留，之后还能 session/load 回来
    const session = this.sessions.get(params.sessionId)
    if (!session) return {}
    session.abort?.abort()
    this.sessions.delete(params.sessionId)
    log(`session/close ${params.sessionId}`)
    return {}
  }

  /* ------------------------------ 会话配置项 ----------------------------- */

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId)
    const modeId = params.modeId
    if (modeId !== 'ask' && modeId !== 'code') {
      throw new RequestError(INVALID_PARAMS_CODE, `不支持的模式：${String(modeId)}`)
    }

    if (modeId !== session.config.mode) {
      session.config = { ...session.config, mode: modeId }
      session.updatedAt = Date.now()
      await this.persist(session)
    }
    await this.emitQuiet(session, { sessionUpdate: 'current_mode_update', currentModeId: modeId })
    debug(`session/set_mode ${session.sessionId} -> ${modeId}`)
    return {}
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId)
    // 配置项改完可能影响模型地址 / 密钥，重新读一遍配置文件
    const config = this.loadConfig('session/set_config_option')
    const value = typeof params.value === 'string' ? params.value : undefined

    if (params.configId === 'model') {
      const choices = modelChoices(config)
      const known = choices.some((choice) => choice.value === value)
      if (!value || !known) {
        throw new RequestError(INVALID_PARAMS_CODE, `未知的模型：${String(params.value)}`)
      }
      if (value !== session.config.model) {
        session.config = { ...session.config, model: value }
        session.updatedAt = Date.now()
        await this.persist(session)
        log(`session/set_config_option ${session.sessionId} model=${value}`)
      }
    } else if (params.configId === 'thought_level') {
      if (!value || !THOUGHT_LEVELS.includes(value as ThoughtLevel)) {
        throw new RequestError(INVALID_PARAMS_CODE, '推理强度只能是 off / low / medium / high')
      }
      if (value !== session.config.thoughtLevel) {
        session.config = { ...session.config, thoughtLevel: value as ThoughtLevel }
        session.updatedAt = Date.now()
        await this.persist(session)
        log(`session/set_config_option ${session.sessionId} thought_level=${value}`)
      }
    } else {
      throw new RequestError(INVALID_PARAMS_CODE, `未知的配置项：${params.configId}`)
    }

    const configOptions = this.configOptionsFor(session, config)
    await this.emitQuiet(session, { sessionUpdate: 'config_option_update', configOptions })
    return { configOptions }
  }

  /* -------------------------------- 取消 -------------------------------- */

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      debug(`session/cancel for unknown session ${params.sessionId}`)
      return
    }
    if (!session.abort) {
      debug(`session/cancel ${params.sessionId} (idle)`)
      return
    }
    log(`session/cancel ${params.sessionId}`)
    session.abort.abort()
  }

  /* -------------------------------- 提示词 ------------------------------- */

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId)
    if (session.abort) throw new RequestError(INVALID_PARAMS_CODE, '当前会话正在处理上一轮对话')

    const promptText = promptToText(params.prompt)
    if (!promptText) throw new RequestError(INVALID_PARAMS_CODE, '提示词为空')

    const command = slashCommandOf(promptText)
    if (command === 'clear') return this.clearContext(session)
    if (command === 'status') return this.reportStatus(session)

    session.messages.push({ role: 'user', content: promptText })
    if (!session.title) {
      const title = deriveTitle(session.messages)
      if (title) session.title = title
    }
    session.updatedAt = Date.now()
    await this.persist(session)
    debug(`session/prompt ${session.sessionId} messages=${session.messages.length}`)

    // 每轮都重新读配置：设置里刚改的 API Key / 模型地址立刻生效
    const config = this.loadConfig('session/prompt')
    this.requireApiKey(config)
    const resolved = resolveModelForSession(config, session.config.model)

    const controller = new AbortController()
    session.abort = controller
    const signal = controller.signal
    const turnUsage: TurnUsage = { inputTokens: 0, outputTokens: 0 }
    const maxTurns = Math.max(1, Math.floor(config.maxTurns) || 1)

    try {
      for (let round = 0; round < maxTurns; round += 1) {
        if (signal.aborted) return await this.finishCancelled(session)

        const messageId = randomUUID()
        const textParts: string[] = []
        const reasoningParts: string[] = []
        const pendingCalls = new Map<number, PendingToolCall>()

        const request: LlmRequest = {
          messages: [this.systemMessage(session, config), ...session.messages],
          tools: getToolSpecs(),
          model: resolved.id,
          apiBase: resolved.apiBase,
          apiKey: resolved.apiKey,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          thoughtLevel: session.config.thoughtLevel,
          sendReasoningEffort: config.sendReasoningEffort,
          signal
        }

        let streamError: unknown = null
        try {
          const client = createOpenAiLlmClient()
          for await (const event of client.stream(request)) {
            if (event.type === 'text') {
              if (!event.text) continue
              textParts.push(event.text)
              await this.emit(session, {
                sessionUpdate: 'agent_message_chunk',
                messageId,
                content: { type: 'text', text: event.text }
              })
            } else if (event.type === 'reasoning') {
              if (!event.text) continue
              reasoningParts.push(event.text)
              await this.emit(session, {
                sessionUpdate: 'agent_thought_chunk',
                messageId,
                content: { type: 'text', text: event.text }
              })
            } else if (event.type === 'toolCall') {
              const pending = pendingCalls.get(event.index) ?? { arguments: '' }
              if (event.id) pending.id = event.id
              if (event.name) pending.name = event.name
              if (event.argumentsDelta) pending.arguments += event.argumentsDelta
              pendingCalls.set(event.index, pending)
            } else if (event.type === 'usage') {
              const input = Math.max(0, Math.round(event.usage.inputTokens))
              const output = Math.max(0, Math.round(event.usage.outputTokens))
              turnUsage.inputTokens += input
              turnUsage.outputTokens += output
              session.usage.inputTokens += input
              session.usage.outputTokens += output
            } else {
              debug(`round ${round + 1} finish=${event.reason}`)
            }
          }
        } catch (error) {
          streamError = error
        }

        const assistantText = textParts.join('')
        const assistantReasoning = reasoningParts.join('')

        if (streamError) {
          if (isCancellation(streamError, signal)) {
            this.recordAssistant(session, assistantText, assistantReasoning)
            return await this.finishCancelled(session)
          }
          throw streamError
        }
        if (signal.aborted) {
          this.recordAssistant(session, assistantText, assistantReasoning)
          return await this.finishCancelled(session)
        }

        const toolCalls = collectToolCalls(pendingCalls)

        // 没有工具调用：本轮就是最终回答
        if (toolCalls.length === 0) {
          this.recordAssistant(session, assistantText, assistantReasoning)
          session.updatedAt = Date.now()
          await this.persist(session)
          await this.emitUsage(session, config)
          return { stopReason: 'end_turn', usage: promptUsage(turnUsage) }
        }

        // 有工具调用：先把 assistant 消息（含全部 tool_calls）入库，保证历史里
        // 每个 tool_call 后面一定能跟到一条 tool 消息
        const assistant: ChatMessage = { role: 'assistant', content: assistantText, toolCalls }
        if (assistantReasoning) assistant.reasoning = assistantReasoning
        session.messages.push(assistant)
        session.updatedAt = Date.now()
        await this.persist(session)

        let executed = 0
        let cancelledDuringTools = false
        for (let index = 0; index < toolCalls.length; index += 1) {
          if (signal.aborted) {
            cancelledDuringTools = true
            break
          }
          try {
            await this.runToolCall(session, toolCalls[index], signal)
            executed = index + 1
          } catch (error) {
            if (error instanceof TurnCancelled) {
              cancelledDuringTools = true
              break
            }
            throw error
          }
        }

        // 取消 / 投递失败时补齐「未执行」的 tool 消息，否则下一轮的历史不合法
        for (let index = executed; index < toolCalls.length; index += 1) {
          const call = toolCalls[index]
          session.messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: '（本轮已取消，工具未执行）'
          })
        }
        session.updatedAt = Date.now()
        await this.persist(session)

        if (cancelledDuringTools || signal.aborted) return { stopReason: 'cancelled' }
      }

      // 轮数用尽：不再继续「模型 → 工具」循环
      session.updatedAt = Date.now()
      await this.persist(session)
      await this.emitUsage(session, config)
      log(`session ${session.sessionId} 达到轮数上限 maxTurns=${maxTurns}`)
      return { stopReason: 'max_turn_requests', usage: promptUsage(turnUsage) }
    } catch (error) {
      if (error instanceof RequestError) throw error
      if (isCancellation(error, signal)) return await this.finishCancelled(session)
      if (isLlmAuthError(error)) {
        log(`session ${session.sessionId} 模型鉴权失败: ${describeError(error)}`)
        throw new RequestError(
          AUTH_REQUIRED_CODE,
          `模型接口鉴权失败，请检查 API Key：${describeError(error)}`,
          { authMethods: AUTH_METHODS }
        )
      }
      log(`session ${session.sessionId} 本轮失败: ${describeError(error)}`)
      throw new RequestError(INTERNAL_ERROR_CODE, `模型调用失败：${describeError(error)}`)
    } finally {
      if (session.abort === controller) session.abort = null
    }
  }

  /* ------------------------------ prompt 子流程 --------------------------- */

  /** 斜杠命令 /clear：只清上下文，会话 id、标题、磁盘文件都保留 */
  private async clearContext(session: HarnessSession): Promise<PromptResponse> {
    session.messages = []
    session.usage = { inputTokens: 0, outputTokens: 0 }
    session.updatedAt = Date.now()
    log(`session ${session.sessionId} 上下文已清空`)
    await this.emitQuiet(session, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '上下文已清空' }
    })
    await this.persist(session)
    return { stopReason: 'end_turn' }
  }

  /** 斜杠命令 /status：直接回复一段状态文本，不写进历史 */
  private async reportStatus(session: HarnessSession): Promise<PromptResponse> {
    let config: HarnessConfig | null = null
    let configPath = ''
    try {
      const loaded = loadHarnessConfig()
      config = loaded.config
      configPath = loaded.path
      if (loaded.error) log(`配置解析失败（${loaded.path}）：${loaded.error}`)
    } catch (error) {
      log(`读取配置失败: ${describeError(error)}`)
    }

    const resolved = config ? resolveModelForSession(config, session.config.model) : null
    const used = Math.max(0, Math.round(session.usage.inputTokens + session.usage.outputTokens))
    const lines = [
      '当前会话状态：',
      `- 模型：${resolved?.label ?? session.config.model}（${resolved?.id ?? session.config.model}）`,
      resolved?.apiKey ? '- API Key：已配置' : '- API Key：未配置（在 MIR 设置 → ACP 智能体 → MIR Harness 里填写）',
      `- 推理强度：${session.config.thoughtLevel}`,
      `- 模式：${session.config.mode}`,
      `- 历史消息：${session.messages.length} 条`,
      `- 上下文占用：${used} / ${config?.contextWindow ?? 0} tokens`,
      `- 工作目录：${session.cwd}`,
      `- 配置文件：${configPath || '(未知)'}`
    ]

    await this.emitQuiet(session, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: lines.join('\n') }
    })
    return { stopReason: 'end_turn' }
  }

  /** 执行一次工具调用，并保证「一定有一条 tool 消息」回到历史里 */
  private async runToolCall(session: HarnessSession, call: ChatToolCall, signal: AbortSignal): Promise<void> {
    const toolCallId = this.claimToolCallId(session, call.id)
    const definition = findTool(call.name)
    const parsed = parseToolArguments(call.arguments)
    const locations = parsed.ok ? extractLocations(parsed.args, session.cwd) : undefined
    const fallbackTitle = parsed.ok ? describeToolCall(call.name, parsed.args) : call.name || '工具调用'
    const kind = kindForTool(call.name)

    if (!definition) {
      const message = `未知工具：${call.name || '(未命名)'}。只可以使用系统提示里列出的工具。`
      log(`未知工具 ${call.name} (${toolCallId})`)
      await this.emitQuiet(session, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: message,
        kind: 'other',
        status: 'failed',
        content: [textContent(message)]
      })
      session.messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: message })
      return
    }

    if (!parsed.ok) {
      const message = `工具参数解析失败：${parsed.error}`
      log(`工具参数解析失败 ${call.name} (${toolCallId}): ${parsed.error}`)
      await this.emitQuiet(session, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: fallbackTitle,
        kind,
        status: 'failed',
        content: [textContent(message)]
      })
      session.messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: message })
      return
    }

    log(`tool ${call.name} -> in_progress (${toolCallId})`)
    // in_progress 卡片先给用户看：标题 / kind / 路径都是猜的，执行完再用结果修正
    await this.emit(session, {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: fallbackTitle,
      kind,
      status: 'in_progress',
      locations,
      rawInput: parsed.args
    })

    const context = this.toolContext(session, toolCallId, signal)
    let result: ToolResult
    try {
      result = await definition.run(
        { id: call.id, name: call.name, arguments: call.arguments },
        parsed.args,
        context
      )
    } catch (error) {
      // 工具因为取消而抛的 AbortError 不算工具失败，交给 prompt 循环收尾
      if (isCancellation(error, signal)) throw error
      log(`tool ${call.name} failed: ${describeError(error)}`)
      result = {
        title: fallbackTitle,
        kind,
        text: `工具执行失败：${describeError(error)}`,
        isError: true
      }
    }

    const title = result.title?.trim() ? result.title : fallbackTitle
    const finalKind = result.kind ?? kind
    const finalLocations = result.locations ?? locations
    const display = (result.display ?? result.text ?? '').trim() || '(没有输出)'
    const ok = result.isError !== true
    log(`tool ${call.name} -> ${ok ? 'completed' : 'failed'} (${toolCallId})`)

    await this.emitQuiet(session, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      title,
      kind: finalKind,
      status: ok ? 'completed' : 'failed',
      content: [textContent(display)],
      ...(finalLocations && finalLocations.length > 0 ? { locations: finalLocations } : {})
    })

    session.messages.push({
      role: 'tool',
      toolCallId: call.id,
      toolName: call.name,
      content: result.text?.trim() ? result.text : display
    })
  }

  private toolContext(session: HarnessSession, toolCallId: string, signal: AbortSignal): ToolContext {
    return {
      cwd: session.cwd,
      mode: session.config.mode,
      signal,
      fs: {
        readText: (path: string) => this.readWorkspaceFile(session, path),
        writeText: (path: string, content: string) => this.writeWorkspaceFile(session, path, content)
      },
      requestPermission: (request: ToolPermissionRequest) =>
        this.requestPermission(session, toolCallId, request, signal),
      hasAllowance: (key: string) => session.allowances.has(key),
      rememberAllowance: (key: string) => {
        session.allowances.add(key)
      }
    }
  }

  /** ACP toolCallId：同一会话里不能重复，重复就加序号后缀 */
  private claimToolCallId(session: HarnessSession, rawId: string): string {
    const base = (rawId ?? '').trim() || `call_${session.usedToolCallIds.size + 1}`
    let candidate = base
    let suffix = 1
    while (session.usedToolCallIds.has(candidate)) {
      suffix += 1
      candidate = `${base}#${suffix}`
    }
    session.usedToolCallIds.add(candidate)
    return candidate
  }

  /* ------------------------------- 文件读写桥 ----------------------------- */

  private async readWorkspaceFile(session: HarnessSession, path: string): Promise<string> {
    const absolute = resolveSessionPath(session.cwd, path)
    if (this.clientFs.readTextFile) {
      const response = await this.connection.readTextFile({ sessionId: session.sessionId, path: absolute })
      return response.content
    }
    return readFile(absolute, 'utf8')
  }

  private async writeWorkspaceFile(session: HarnessSession, path: string, content: string): Promise<void> {
    const absolute = resolveSessionPath(session.cwd, path)
    if (this.clientFs.writeTextFile) {
      // 走客户端：MIR 会弹文件变更、广播 file-written 事件
      await this.connection.writeTextFile({ sessionId: session.sessionId, path: absolute, content })
      return
    }
    const parent = dirname(absolute)
    if (parent && parent !== absolute) {
      await mkdir(parent, { recursive: true })
    }
    await writeFile(absolute, content, 'utf8')
  }

  /* -------------------------------- 权限桥 -------------------------------- */

  private async requestPermission(
    session: HarnessSession,
    toolCallId: string,
    request: ToolPermissionRequest,
    signal: AbortSignal
  ): Promise<ToolPermissionOutcome> {
    const text = (request.content ?? request.title ?? '').trim() || '需要你的确认'
    const payload: RequestPermissionRequest = {
      sessionId: session.sessionId,
      toolCall: {
        toolCallId,
        title: request.title,
        kind: request.kind,
        content: [textContent(text)],
        ...(request.locations && request.locations.length > 0 ? { locations: request.locations } : {}),
        ...(request.rawInput === undefined ? {} : { rawInput: request.rawInput })
      },
      options: [
        { optionId: 'allow_once', name: '允许一次', kind: 'allow_once' },
        { optionId: 'allow_always', name: '本会话总是允许', kind: 'allow_always' },
        { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' }
      ]
    }

    let outcome: RequestPermissionResponse['outcome'] | null = null
    try {
      outcome = await Promise.race([
        this.connection.requestPermission(payload).then((response) => response.outcome),
        abortOutcome(signal),
        timeoutOutcome(PERMISSION_TIMEOUT_MS)
      ])
    } catch (error) {
      log(`权限请求失败: ${describeError(error)}`)
      return 'reject'
    }

    if (!outcome || outcome.outcome === 'cancelled') {
      log(`权限请求未获响应，按拒绝处理 (${toolCallId})`)
      return 'reject'
    }
    if (outcome.optionId === 'allow_once') return 'allow_once'
    if (outcome.optionId === 'allow_always') return 'allow_always'
    return 'reject'
  }

  /* ------------------------------- 通知 / 落盘 ----------------------------- */

  private async emit(session: HarnessSession, update: SessionUpdate): Promise<void> {
    try {
      await this.connection.sessionUpdate({ sessionId: session.sessionId, update })
    } catch (error) {
      // 连接没了：继续跑循环没有意义，按取消收尾，别把 JSON-RPC 流炸掉
      log(`sessionUpdate(${update.sessionUpdate}) 投递失败: ${describeError(error)}`)
      throw new TurnCancelled()
    }
  }

  /** 连接已断开时也允许静默失败（用于收尾类通知：命令列表 / 用量 / 工具结果） */
  private async emitQuiet(session: HarnessSession, update: SessionUpdate): Promise<void> {
    try {
      await this.emit(session, update)
    } catch {
      // 忽略
    }
  }

  /** available_commands_update 延后一个 tick：先让 session/new 的响应写出去 */
  private announceCommands(session: HarnessSession): void {
    const timer = setTimeout(() => {
      void this.emitQuiet(session, {
        sessionUpdate: 'available_commands_update',
        availableCommands: AVAILABLE_COMMANDS
      })
    }, 0)
    if (typeof timer.unref === 'function') timer.unref()
  }

  private async emitUsage(session: HarnessSession, config: HarnessConfig): Promise<void> {
    const used = Math.max(0, Math.round(session.usage.inputTokens + session.usage.outputTokens))
    const size = Math.max(1, Math.round(config.contextWindow || 1))
    await this.emitQuiet(session, { sessionUpdate: 'usage_update', used, size })
  }

  private async persist(session: HarnessSession): Promise<void> {
    const record: PersistedSession = {
      sessionId: session.sessionId,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages,
      config: session.config
    }
    if (session.title) record.title = session.title
    try {
      writePersistedSession(record)
    } catch (error) {
      // 落盘失败不该打断对话；磁盘问题会在 session/list 时暴露
      log(`会话落盘失败 ${session.sessionId}: ${describeError(error)}`)
    }
  }

  /* -------------------------------- 配置 -------------------------------- */

  private loadConfig(context: string): HarnessConfig {
    try {
      const loaded = loadHarnessConfig()
      if (loaded.error) log(`配置解析失败（${loaded.path}）：${loaded.error}，已回落到默认值`)
      debug(
        `config(${context}) path=${loaded.path} exists=${loaded.exists} ` +
          `model=${loaded.config.model} approval=${loaded.config.approvalMode} maxTurns=${loaded.config.maxTurns}`
      )
      return loaded.config
    } catch (error) {
      log(`读取配置失败 (${context}): ${describeError(error)}`)
      throw new RequestError(INTERNAL_ERROR_CODE, `读取 MIR Harness 配置失败：${describeError(error)}`)
    }
  }

  /** 没配密钥时回 -32000：MIR 会走「需要认证」提示并打开设置 */
  private requireApiKey(config: HarnessConfig): void {
    const resolved = resolveModelForSession(config, config.model)
    if (!resolved.apiKey || !resolved.apiKey.trim()) {
      throw new RequestError(AUTH_REQUIRED_CODE, '需要先配置 MIR Harness 的 API Key', {
        authMethods: AUTH_METHODS
      })
    }
  }

  private requireSession(sessionId: string): HarnessSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new RequestError(INVALID_PARAMS_CODE, '会话不存在，请新建或加载会话')
    return session
  }

  /* ------------------------------ 会话重建 / 回放 -------------------------- */

  private restoreSession(
    persisted: PersistedSession,
    config: HarnessConfig,
    requestedCwd: string | null | undefined
  ): HarnessSession {
    const cwd = pickSessionCwd(persisted.cwd, requestedCwd)
    const persistedConfig: Partial<SessionConfigValues> = persisted.config ?? {}
    const model =
      typeof persistedConfig.model === 'string' && persistedConfig.model.trim()
        ? persistedConfig.model
        : config.model
    const thoughtLevel = THOUGHT_LEVELS.includes(persistedConfig.thoughtLevel as ThoughtLevel)
      ? (persistedConfig.thoughtLevel as ThoughtLevel)
      : THOUGHT_LEVEL_DEFAULT
    const mode: HarnessMode =
      persistedConfig.mode === 'code' || persistedConfig.mode === 'ask'
        ? persistedConfig.mode
        : defaultMode(config)

    return {
      sessionId: persisted.sessionId,
      cwd,
      title: persisted.title,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      messages: persisted.messages,
      config: { model, thoughtLevel, mode },
      allowances: new Set<string>(),
      abort: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      usedToolCallIds: new Set<string>()
    }
  }

  private register(session: HarnessSession): void {
    const existing = this.sessions.get(session.sessionId)
    existing?.abort?.abort()
    this.sessions.set(session.sessionId, session)
  }

  /**
   * 回放历史：user / assistant 文本 / 推理 / 工具卡片各发一条 chunk。
   * 单条截断到 REPLAY_MESSAGE_LIMIT，避免一次 load 灌出几 MB 的 JSON 行。
   */
  private async replayHistory(session: HarnessSession): Promise<void> {
    const messages = Array.isArray(session.messages) ? session.messages : []
    let toolIndex = 0
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      try {
        if (message.role === 'user') {
          const text = replayText(message.content)
          if (text) {
            await this.emit(session, {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text }
            })
          }
        } else if (message.role === 'assistant') {
          const reasoning = replayText(message.reasoning)
          if (reasoning) {
            await this.emit(session, {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: reasoning }
            })
          }
          const text = replayText(message.content)
          if (text) {
            await this.emit(session, {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text }
            })
          }
        } else if (message.role === 'tool') {
          toolIndex += 1
          const text = replayText(message.content)
          const toolName = (message.toolName ?? '').trim()
          await this.emit(session, {
            sessionUpdate: 'tool_call',
            toolCallId: `history-tool-${toolIndex}`,
            title: toolName || '工具结果',
            kind: kindForTool(toolName),
            status: 'completed',
            ...(text ? { content: [textContent(text)] } : {})
          })
        }
      } catch (error) {
        // 回放中途连接断了：别让 session/load 挂在一个必然失败的请求上
        log(`历史回放中断（已回放 ${toolIndex} 个工具结果）: ${describeError(error)}`)
        return
      }
    }
  }

  /* ------------------------------- 响应构造 ------------------------------- */

  private modesFor(session: HarnessSession): SessionModeState {
    return {
      currentModeId: session.config.mode,
      availableModes: MODE_DEFINITIONS.map((mode) => ({
        id: mode.id,
        name: mode.name,
        description: mode.description
      }))
    }
  }

  private configOptionsFor(session: HarnessSession, config: HarnessConfig): SessionConfigOption[] {
    return [
      {
        id: 'model',
        name: 'Model',
        description: '选择 MIR Harness 使用的模型',
        category: 'model',
        type: 'select',
        currentValue: session.config.model,
        options: modelChoices(config)
      },
      {
        id: 'thought_level',
        name: 'Reasoning effort',
        description: '推理强度',
        category: 'thought_level',
        type: 'select',
        currentValue: session.config.thoughtLevel,
        options: THOUGHT_LEVEL_OPTIONS
      }
    ]
  }

  private toSessionInfo(summary: PersistedSessionSummary): SessionInfo {
    const info: SessionInfo = { sessionId: summary.sessionId, cwd: summary.cwd }
    if (summary.title) info.title = summary.title
    if (Number.isFinite(summary.updatedAt)) info.updatedAt = new Date(summary.updatedAt).toISOString()
    return info
  }

  private systemMessage(session: HarnessSession, config: HarnessConfig): ChatMessage {
    const parts: string[] = []
    const prompt = (config.systemPrompt ?? '').trim()
    if (prompt) parts.push(prompt)
    parts.push(workingDirectoryNote(session.cwd))
    parts.push(
      session.config.mode === 'code'
        ? '当前模式：Code。工作区内的写文件与命令可以直接执行，工作区之外的文件不要碰。'
        : '当前模式：Ask。写文件或执行命令之前，必须先通过权限请求征得用户同意。'
    )
    return { role: 'system', content: parts.join('\n\n') }
  }

  /** 把一轮里已经产生的文本 / 推理写进历史（取消时保留用户已经看到的内容） */
  private recordAssistant(session: HarnessSession, text: string, reasoning: string): void {
    const hasText = text.trim().length > 0
    const hasReasoning = reasoning.trim().length > 0
    if (!hasText && !hasReasoning) return
    const message: ChatMessage = { role: 'assistant', content: text }
    if (hasReasoning) message.reasoning = reasoning
    session.messages.push(message)
  }

  private async finishCancelled(session: HarnessSession): Promise<PromptResponse> {
    session.updatedAt = Date.now()
    await this.persist(session)
    debug(`session ${session.sessionId} 本轮已取消`)
    return { stopReason: 'cancelled' }
  }
}

/** 权限请求的兜底超时：MIR 侧 60s 会回 cancelled，这里只防客户端彻底失联 */
function timeoutOutcome(ms: number): Promise<null> {
  return new Promise<null>((resolveTimeout) => {
    const timer = setTimeout(() => resolveTimeout(null), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}
