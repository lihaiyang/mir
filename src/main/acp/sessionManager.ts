/**
 * ACP 会话管理：Agent 进程生命周期 + 会话状态 + 提示词轮次。
 *
 * 关键约定：
 * - 一个 agentId 只对应一个子进程，该进程可承载多个 ACP session
 * - 会话以 ACP sessionId 为 key，loadSession 必须在 await 之前登记占位会话，
 *   否则 agent 回放的历史 session/update 通知会因为找不到会话被丢弃
 * - 任何等待都不会悬空：Agent 退出 / 会话关闭时 pending 权限会以 cancelled 结束
 */
import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import type {
  ClientSideConnection,
  ContentBlock,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SessionModelState,
  SessionNotification,
  SessionUpdate,
  StopReason
} from '@agentclientprotocol/sdk'
import type {
  AcpAgentCapabilities,
  AcpAgentConfig,
  AcpAgentRuntimeInfo,
  AcpAgentStatus,
  AcpAuthMethod,
  AcpHistoryEntry,
  AcpPromptBlock,
  AcpRemoteSession,
  AcpSessionDetail,
  AcpSessionSummary,
  AcpStateSnapshot
} from '../../shared/acp'
import { getAcpConfig, getAgentConfig } from './config'
import { listHistory, patchHistory, reconcile, removeHistory, upsertHistory } from './history'
import {
  getRememberedSessionConfig,
  isRememberedOption,
  rememberConfigValue,
  rememberMode,
  rememberModel
} from './sessionPrefs'
import { openAcpConnection } from './connection'
import type { AgentExit, AgentProcess } from './agentProcess'
import { emitAcpEvent } from './events'
import {
  cancelAgentPermissions,
  cancelAllPermissions,
  cancelSessionPermissions,
  getPendingPermissions,
  requestPermission,
  respondPermission as respondToPermission
} from './handlers/permission'
import { disposeAllTerminals } from './handlers/terminal'

type SessionConfigSource = {
  modes?: SessionModeState | null
  models?: SessionModelState | null
  configOptions?: SessionConfigOption[] | null
}

interface AgentRuntime {
  agentId: string
  config: AcpAgentConfig
  proc: AgentProcess | null
  connection: ClientSideConnection | null
  capabilities: AcpAgentCapabilities
  authMethods: AcpAuthMethod[]
  status: AcpAgentStatus
  error?: string
  stderrTail?: string
  connecting: Promise<void> | null
  /** 主动 disconnect / shutdown 时置位，用于区分意外崩溃 */
  stopping: boolean
}

type AcpConnection = ClientSideConnection

interface SessionRuntime {
  detail: AcpSessionDetail
  agentId: string
  prompting: boolean
}

const agents = new Map<string, AgentRuntime>()
const sessions = new Map<string, SessionRuntime>()

/**
 * SDK 并发分发入站消息（不 await 处理），agent 有可能在 session/new 的响应到达
 * 之前就推送该会话的 session/update。先短时缓存，会话登记后按序补发，避免丢失。
 */
const pendingUpdates = new Map<string, { updates: SessionNotification[], timer: NodeJS.Timeout }>()
const PENDING_UPDATE_LIMIT = 64
const PENDING_UPDATE_TTL_MS = 15_000

function bufferSessionUpdate(notification: SessionNotification): void {
  const sessionId = notification.sessionId
  let entry = pendingUpdates.get(sessionId)
  if (!entry) {
    const timer = setTimeout(() => pendingUpdates.delete(sessionId), PENDING_UPDATE_TTL_MS)
    timer.unref?.()
    entry = { updates: [], timer }
    pendingUpdates.set(sessionId, entry)
  }
  if (entry.updates.length >= PENDING_UPDATE_LIMIT) entry.updates.shift()
  entry.updates.push(notification)
}

/** 会话登记后补发缓存的通知（调用方负责先广播 session-created） */
function drainPendingUpdates(sessionId: string): void {
  const entry = pendingUpdates.get(sessionId)
  if (!entry) return
  pendingUpdates.delete(sessionId)
  clearTimeout(entry.timer)
  for (const notification of entry.updates) applySessionUpdate(notification)
}

const EMPTY_CAPABILITIES: AcpAgentCapabilities = {
  loadSession: false,
  listSessions: false,
  resumeSession: false,
  promptImages: false,
  promptAudio: false,
  promptEmbeddedContext: false,
  terminal: true
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isAuthRequired(error: unknown): boolean {
  if (error instanceof RequestError) {
    if (error.code === RequestError.authRequired().code) return true
    return /auth.?required/i.test(error.message)
  }
  return /auth.?required/i.test(errorMessage(error))
}

function requireConnection(runtime: AgentRuntime): AcpConnection {
  if (!runtime.connection) throw new Error(`Agent ${runtime.config.name} 尚未连接`)
  return runtime.connection
}

function resolveCwd(cwd?: string): string {
  const config = getAcpConfig()
  const candidate = cwd?.trim() || config.defaultWorkingDirectory?.trim()
  return candidate || process.cwd()
}

function countSessions(agentId: string): number {
  let count = 0
  for (const session of sessions.values()) {
    if (session.agentId === agentId) count += 1
  }
  return count
}

function toRuntimeInfo(runtime: AgentRuntime): AcpAgentRuntimeInfo {
  const info: AcpAgentRuntimeInfo = {
    agentId: runtime.agentId,
    status: runtime.status,
    sessionCount: countSessions(runtime.agentId)
  }
  if (runtime.proc?.pid) info.pid = runtime.proc.pid
  if (runtime.error) info.error = runtime.error
  if (runtime.stderrTail) info.stderrTail = runtime.stderrTail
  if (runtime.status === 'ready') info.capabilities = runtime.capabilities
  return info
}

function emitStatus(runtime: AgentRuntime): void {
  emitAcpEvent({ type: 'agent-status', info: toRuntimeInfo(runtime) })
}

function historyEntryFromDetail(detail: AcpSessionDetail): AcpHistoryEntry {
  const entry: AcpHistoryEntry = {
    agentId: detail.agentId,
    sessionId: detail.sessionId,
    cwd: detail.cwd,
    createdAt: detail.createdAt,
    lastActiveAt: detail.updatedAt
  }
  if (detail.title) entry.title = detail.title
  if (detail.firstPrompt) entry.firstPrompt = detail.firstPrompt
  return entry
}

function modelStateToConfigOption(models: SessionModelState | null | undefined): SessionConfigOption | undefined {
  if (!models || models.availableModels.length === 0) return undefined
  return {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    currentValue: models.currentModelId,
    options: models.availableModels.map((model) => {
      const option: { value: string, name: string, description?: string } = {
        value: model.modelId,
        name: model.name
      }
      if (model.description) option.description = model.description
      return option
    })
  }
}

/**
 * 会话的配置项：优先用 Agent 返回的 configOptions；
 * 只有 models 没有 configOptions 的 Agent，补一个 category=model 的选项，
 * 这样渲染进程只需按 configOptions 渲染，setModel 也能走统一路径。
 */
function collectConfigOptions(source: SessionConfigSource): SessionConfigOption[] | undefined {
  const options: SessionConfigOption[] = []
  if (Array.isArray(source.configOptions)) options.push(...source.configOptions)

  const modelOption = modelStateToConfigOption(source.models)
  if (modelOption && !options.some((option) => option.id === 'model')) options.push(modelOption)

  return options.length > 0 ? options : undefined
}

function buildDetail(
  runtime: AgentRuntime,
  sessionId: string,
  cwd: string,
  source: SessionConfigSource = {},
  previous?: AcpHistoryEntry
): AcpSessionDetail {
  const now = Date.now()
  const detail: AcpSessionDetail = {
    sessionId,
    agentId: runtime.agentId,
    agentName: runtime.config.name,
    cwd,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    status: 'active',
    supportsLoad: runtime.capabilities.loadSession,
    supportsResume: runtime.capabilities.resumeSession
  }
  if (previous?.title) detail.title = previous.title
  if (previous?.firstPrompt) detail.firstPrompt = previous.firstPrompt
  if (source.modes) detail.modes = source.modes
  const configOptions = collectConfigOptions(source)
  if (configOptions) detail.configOptions = configOptions
  return detail
}

function summaryPatch(detail: AcpSessionDetail): Partial<AcpSessionSummary> {
  const patch: Partial<AcpSessionSummary> = {
    cwd: detail.cwd,
    updatedAt: detail.updatedAt,
    status: detail.status
  }
  if (detail.title !== undefined) patch.title = detail.title
  if (detail.firstPrompt !== undefined) patch.firstPrompt = detail.firstPrompt
  return patch
}

function contentText(content: ContentBlock): string | undefined {
  if (content.type === 'text') return content.text
  if (content.type === 'resource_link') return content.name
  return undefined
}

function deriveTitle(update: SessionUpdate): string | undefined {
  if (update.sessionUpdate !== 'user_message_chunk') return undefined
  const text = contentText(update.content)
  if (!text) return undefined
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return undefined
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

function findSelectOption(
  options: SessionConfigOption[] | undefined,
  match: (option: SessionConfigOption & { type: 'select' }) => boolean
): (SessionConfigOption & { type: 'select' }) | undefined {
  return options?.find(
    (option): option is SessionConfigOption & { type: 'select' } =>
      option.type === 'select' && match(option)
  )
}

/** 展平 select 的选项值；ACP 允许把选项分组（group）返回 */
function selectValues(options: SessionConfigOption & { type: 'select' }): string[] {
  const values: string[] = []
  for (const entry of options.options) {
    if ('options' in entry) {
      for (const nested of entry.options) values.push(nested.value)
    } else {
      values.push(entry.value)
    }
  }
  return values
}

/** 上次记住的值在新会话里是否仍然可选（模型下架、Agent 改配置时跳过） */
function optionAcceptsValue(option: SessionConfigOption, value: string | boolean): boolean {
  if (option.type === 'boolean') return typeof value === 'boolean'
  if (typeof value !== 'string') return false
  return selectValues(option).includes(value)
}

/** 套用顺序：模型 → 推理强度 → 其它（模式通常与模型无关，放最后） */
function rankOf(option: SessionConfigOption): number {
  if (option.category === 'model' || option.id === 'model') return 0
  if (option.category === 'thought_level' || option.id === 'thought_level') return 1
  return 2
}

/**
 * 推理强度属于「模型配置」的 Agent：它的 effort 由每个模型的配置决定，
 * 切换模型时 Agent 自己会重置，所以不套用也不记录用户上次的选择。
 * （其它 Agent 没有模型级配置，仍按旧行为记住 thought_level。）
 */
const PER_MODEL_EFFORT_AGENTS = new Set(['mir-harness'])

function skipsRememberedOption(
  agentId: string,
  option: { id: string; category?: string | null }
): boolean {
  const isEffort = option.id === 'thought_level' || option.category === 'thought_level'
  return isEffort && PER_MODEL_EFFORT_AGENTS.has(agentId)
}

/**
 * 把上次会话里用户选过的 model / mode / thought_level 套用到新会话。
 * 只处理「Agent 仍然提供、且值仍然合法」的项，失败静默跳过。
 */
async function applyRememberedConfig(
  runtime: AgentRuntime,
  detail: AcpSessionDetail,
  connection: ClientSideConnection
): Promise<void> {
  const remembered = getRememberedSessionConfig(runtime.agentId)
  if (!remembered) return

  /**
   * 先套模型再套其它项：部分 Agent 切换模型会把推理强度重置为默认值，
   * 反过来先设推理强度就会被覆盖。每次循环都重新读取最新的 configOptions，
   * 因为上一次 setSessionConfigOption 的返回值可能已经改了其它项。
   */
  const order = (options: SessionConfigOption[]): string[] =>
    options
      .filter((option) => isRememberedOption(option) && !skipsRememberedOption(runtime.agentId, option))
      .sort((a, b) => rankOf(a) - rankOf(b))
      .map((option) => option.id)

  for (const configId of order(detail.configOptions ?? [])) {
    const option = detail.configOptions?.find((item) => item.id === configId)
    if (!option || !isRememberedOption(option)) continue
    if (!Object.prototype.hasOwnProperty.call(remembered.values, configId)) continue
    const wanted = remembered.values[configId]
    if (wanted === option.currentValue) continue
    if (!optionAcceptsValue(option, wanted)) continue
    try {
      const request =
        typeof wanted === 'boolean'
          ? { sessionId: detail.sessionId, configId, type: 'boolean' as const, value: wanted }
          : { sessionId: detail.sessionId, configId, value: wanted }
      const response = await connection.setSessionConfigOption(request)
      detail.configOptions = response.configOptions
    } catch {
      // 值已不可用（模型下线等）：保持 Agent 默认即可
    }
  }

  const options = detail.configOptions ?? []
  const hasModeOption = options.some((option) => option.category === 'mode' || option.id === 'mode')
  if (
    remembered.modeId &&
    !hasModeOption &&
    detail.modes &&
    detail.modes.currentModeId !== remembered.modeId &&
    detail.modes.availableModes.some((mode) => mode.id === remembered.modeId)
  ) {
    try {
      await connection.setSessionMode({ sessionId: detail.sessionId, modeId: remembered.modeId })
      detail.modes = { ...detail.modes, currentModeId: remembered.modeId }
    } catch {
      // 模式不可用：保持默认
    }
  }

  const hasModelOption = options.some((option) => option.category === 'model' || option.id === 'model')
  if (
    remembered.modelId &&
    !hasModelOption &&
    typeof connection.unstable_setSessionModel === 'function'
  ) {
    try {
      await connection.unstable_setSessionModel({ sessionId: detail.sessionId, modelId: remembered.modelId })
    } catch {
      // 模型不可用：保持默认
    }
  }
}

function toRemoteSession(info: SessionInfo): AcpRemoteSession {
  const session: AcpRemoteSession = { sessionId: info.sessionId }
  if (info.cwd) session.cwd = info.cwd
  if (info.title) session.title = info.title
  if (info.updatedAt) {
    const parsed = Date.parse(info.updatedAt)
    if (Number.isFinite(parsed)) session.updatedAt = parsed
  }
  return session
}

function createRuntime(config: AcpAgentConfig): AgentRuntime {
  return {
    agentId: config.id,
    config,
    proc: null,
    connection: null,
    capabilities: { ...EMPTY_CAPABILITIES },
    authMethods: [],
    status: 'idle',
    connecting: null,
    stopping: false
  }
}

/* -------------------------------------------------------------------------- */
/* Agent 连接                                                                  */
/* -------------------------------------------------------------------------- */

function handleAgentExit(runtime: AgentRuntime, exit: AgentExit): void {
  if (agents.get(runtime.agentId) !== runtime) return

  runtime.connection = null
  runtime.proc = null
  cancelAgentPermissions(runtime.agentId)

  for (const session of sessions.values()) {
    if (session.agentId !== runtime.agentId) continue
    const wasPrompting = session.prompting
    session.prompting = false
    session.detail.status = 'interrupted'
    session.detail.updatedAt = Date.now()
    emitAcpEvent({
      type: 'session-updated',
      sessionId: session.detail.sessionId,
      patch: { status: 'interrupted', updatedAt: session.detail.updatedAt }
    })
    patchHistory(runtime.agentId, session.detail.sessionId, { lastActiveAt: session.detail.updatedAt })
    if (wasPrompting) {
      emitAcpEvent({
        type: 'prompt-end',
        sessionId: session.detail.sessionId,
        error: 'agent process exited'
      })
    }
  }

  if (runtime.stopping) {
    runtime.status = 'closed'
  } else {
    runtime.status = 'error'
    const reason =
      exit.code === null
        ? `agent 进程被信号 ${exit.signal ?? 'unknown'} 终止`
        : `agent 进程异常退出（code ${exit.code}）`
    runtime.error = runtime.stderrTail ? `${reason}\n${runtime.stderrTail}` : reason
    emitAcpEvent({
      type: 'notice',
      level: 'error',
      message: `${runtime.config.name} 已断开，进行中的会话标记为中断`
    })
  }

  emitStatus(runtime)
}

async function connect(runtime: AgentRuntime): Promise<void> {
  const config = getAcpConfig()
  const latest = getAgentConfig(runtime.agentId)
  if (latest) runtime.config = latest
  runtime.stopping = false
  runtime.error = undefined

  const workingDirectory = config.defaultWorkingDirectory?.trim() || process.cwd()

  try {
    const handle = await openAcpConnection({
      agent: runtime.config,
      cwd: workingDirectory,
      logTraffic: config.logTraffic,
      onStderr: (chunk, stderrTail) => {
        runtime.stderrTail = stderrTail
        emitAcpEvent({ type: 'agent-stderr', agentId: runtime.agentId, chunk })
      },
      onExit: (exit) => handleAgentExit(runtime, exit),
      onSessionUpdate: (notification) => applySessionUpdate(notification),
      requestPermission: (params) => requestPermission(params, runtime.agentId)
    })

    runtime.proc = handle.proc
    runtime.connection = handle.connection
    runtime.capabilities = handle.capabilities
    runtime.authMethods = handle.authMethods
    runtime.status = 'ready'

    if (handle.protocolVersion !== PROTOCOL_VERSION) {
      emitAcpEvent({
        type: 'notice',
        level: 'warn',
        message: `${runtime.config.name} 使用协议版本 ${handle.protocolVersion}，MIR 期望 ${PROTOCOL_VERSION}，部分能力可能不可用`
      })
    }

    emitStatus(runtime)
  } catch (error) {
    runtime.status = 'error'
    const reason = errorMessage(error)
    runtime.error = runtime.stderrTail ? `${reason}\n${runtime.stderrTail}` : reason
    runtime.connection = null
    runtime.proc = null
    emitStatus(runtime)
    throw error instanceof Error ? error : new Error(reason)
  }
}

export async function ensureAgentConnected(agentId: string): Promise<AgentRuntime> {
  const existing = agents.get(agentId)
  if (existing?.status === 'ready' && existing.connection) return existing
  if (existing?.connecting) {
    await existing.connecting
    const ready = agents.get(agentId)
    if (ready?.status === 'ready' && ready.connection) return ready
    throw new Error(ready?.error ?? `Agent ${agentId} 连接失败`)
  }

  const agentConfig = getAgentConfig(agentId)
  if (!agentConfig) throw new Error(`未知的 Agent: ${agentId}`)

  const runtime = existing ?? createRuntime(agentConfig)
  agents.set(agentId, runtime)
  runtime.status = 'starting'
  runtime.error = undefined
  emitStatus(runtime)

  const task = connect(runtime)
  runtime.connecting = task
  try {
    await task
  } finally {
    runtime.connecting = null
  }

  // 注意：这里不能用 runtime.status 判断——TS 会把 'starting' 赋值收窄成字面量类型；
  // connect() 成功时才会挂上 connection，失败时两者一并清空。
  if (!runtime.connection) {
    throw new Error(runtime.error ?? `Agent ${agentConfig.name} 连接失败`)
  }
  return runtime
}

/* -------------------------------------------------------------------------- */
/* 会话生命周期                                                                  */
/* -------------------------------------------------------------------------- */

export async function createSession(agentId: string, cwd?: string): Promise<AcpSessionDetail> {
  const runtime = await ensureAgentConnected(agentId)
  const connection = requireConnection(runtime)
  const workingDirectory = resolveCwd(cwd)

  try {
    const response = await connection.newSession({ cwd: workingDirectory, mcpServers: [] })
    const detail = buildDetail(runtime, response.sessionId, workingDirectory, {
      models: response.models ?? undefined,
      configOptions: response.configOptions ?? undefined
    })
    if (response.modes) detail.modes = response.modes

    // 新会话沿用上一次选择的模型 / 模式 / 推理强度（Agent 仍然提供时）
    await applyRememberedConfig(runtime, detail, connection)

    sessions.set(detail.sessionId, { detail, agentId, prompting: false })
    emitAcpEvent({ type: 'session-created', session: { ...detail } })
    drainPendingUpdates(detail.sessionId)
    upsertHistory(historyEntryFromDetail(detail))
    emitStatus(runtime)
    return detail
  } catch (error) {
    if (isAuthRequired(error)) {
      emitAcpEvent({
        type: 'auth-required',
        agentId,
        methods: runtime.authMethods
      })
      throw new Error(
        `${runtime.config.name} 需要先完成认证（${runtime.authMethods.map((m) => m.name).join(' / ') || '未提供认证方式'}）`
      )
    }
    throw error
  }
}

export async function loadSession(
  agentId: string,
  sessionId: string,
  cwd?: string
): Promise<AcpSessionDetail> {
  const runtime = await ensureAgentConnected(agentId)
  if (!runtime.capabilities.loadSession) {
    throw new Error(`${runtime.config.name} 不支持恢复历史会话（session/load）`)
  }
  const connection = requireConnection(runtime)

  const previous = listHistory().find(
    (entry) => entry.agentId === agentId && entry.sessionId === sessionId
  )
  const workingDirectory = resolveCwd(previous?.cwd ?? cwd)
  const detail = buildDetail(runtime, sessionId, workingDirectory, {}, previous)
  detail.status = 'loading'

  // 先登记占位会话：loadSession 期间 agent 会回放历史 session/update
  sessions.set(sessionId, { detail, agentId, prompting: false })
  emitAcpEvent({ type: 'session-created', session: { ...detail } })
  drainPendingUpdates(sessionId)
  emitStatus(runtime)

  try {
    const response = await connection.loadSession({
      sessionId,
      cwd: workingDirectory,
      mcpServers: []
    })

    const current = sessions.get(sessionId)
    const target = current?.detail ?? detail
    target.status = 'active'
    target.updatedAt = Date.now()
    if (response.modes) target.modes = response.modes
    const configOptions = collectConfigOptions({
      models: response.models ?? undefined,
      configOptions: response.configOptions ?? undefined
    })
    if (configOptions) target.configOptions = configOptions

    emitAcpEvent({
      type: 'session-updated',
      sessionId,
      patch: { status: 'active', updatedAt: target.updatedAt }
    })
    upsertHistory(historyEntryFromDetail(target))
    return target
  } catch (error) {
    sessions.delete(sessionId)
    emitAcpEvent({ type: 'session-removed', sessionId })
    emitStatus(runtime)
    throw error
  }
}

export async function resumeSession(
  agentId: string,
  sessionId: string,
  cwd?: string
): Promise<AcpSessionDetail> {
  const runtime = await ensureAgentConnected(agentId)
  if (!runtime.capabilities.resumeSession) {
    throw new Error(`${runtime.config.name} 不支持恢复历史会话（session/resume）`)
  }
  const connection = requireConnection(runtime)

  const previous = listHistory().find(
    (entry) => entry.agentId === agentId && entry.sessionId === sessionId
  )
  const workingDirectory = resolveCwd(previous?.cwd ?? cwd)
  const detail = buildDetail(runtime, sessionId, workingDirectory, {}, previous)
  detail.status = 'loading'

  sessions.set(sessionId, { detail, agentId, prompting: false })
  emitAcpEvent({ type: 'session-created', session: { ...detail } })
  drainPendingUpdates(sessionId)

  try {
    const response = await connection.resumeSession({
      sessionId,
      cwd: workingDirectory,
      mcpServers: []
    })

    detail.status = 'active'
    detail.updatedAt = Date.now()
    if (response.modes) detail.modes = response.modes
    const configOptions = collectConfigOptions({
      models: response.models ?? undefined,
      configOptions: response.configOptions ?? undefined
    })
    if (configOptions) detail.configOptions = configOptions

    emitAcpEvent({
      type: 'session-updated',
      sessionId,
      patch: { status: 'active', updatedAt: detail.updatedAt }
    })
    upsertHistory(historyEntryFromDetail(detail))
    emitStatus(runtime)
    return detail
  } catch (error) {
    sessions.delete(sessionId)
    emitAcpEvent({ type: 'session-removed', sessionId })
    emitStatus(runtime)
    throw error
  }
}

export async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return

  const runtime = agents.get(session.agentId)
  cancelSessionPermissions(sessionId)

  if (session.prompting && runtime?.connection) {
    try {
      await runtime.connection.cancel({ sessionId })
    } catch {
      // Agent 可能已经结束本轮
    }
  }

  if (runtime?.connection && runtime.capabilities.loadSession !== undefined) {
    try {
      await runtime.connection.closeSession({ sessionId })
    } catch {
      // 不支持 session/close 的 Agent 会报错，本地丢弃即可
    }
  }

  session.prompting = false
  sessions.delete(sessionId)
  emitAcpEvent({ type: 'session-removed', sessionId })
  if (runtime) emitStatus(runtime)
}

export async function disconnectAgent(agentId: string): Promise<void> {
  const runtime = agents.get(agentId)
  if (!runtime) return

  runtime.stopping = true
  cancelAgentPermissions(agentId)

  for (const [sessionId, session] of [...sessions.entries()]) {
    if (session.agentId !== agentId) continue
    session.prompting = false
    sessions.delete(sessionId)
    emitAcpEvent({ type: 'session-removed', sessionId })
  }

  runtime.proc?.kill()
  runtime.connection = null
  runtime.proc = null
  runtime.status = 'closed'
  runtime.error = undefined
  emitStatus(runtime)
  agents.delete(agentId)
}

/* -------------------------------------------------------------------------- */
/* 提示词                                                                      */
/* -------------------------------------------------------------------------- */

function toContentBlock(block: AcpPromptBlock): ContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  const content: ContentBlock = {
    type: 'resource_link',
    uri: block.uri,
    name: block.name
  }
  if (block.mimeType) content.mimeType = block.mimeType
  return content
}

function ensureTitleFromPrompt(session: SessionRuntime, blocks: AcpPromptBlock[]): void {
  const firstText = blocks.find((block) => block.type === 'text' && block.text.trim())
  if (!firstText || firstText.type !== 'text') return

  const line = firstText.text.replace(/\s+/g, ' ').trim()
  if (!line) return

  if (!session.detail.firstPrompt) session.detail.firstPrompt = line
  if (!session.detail.title) {
    session.detail.title = line.length > 80 ? `${line.slice(0, 80)}…` : line
  }
  session.detail.updatedAt = Date.now()
  emitAcpEvent({
    type: 'session-updated',
    sessionId: session.detail.sessionId,
    patch: {
      title: session.detail.title,
      firstPrompt: session.detail.firstPrompt,
      updatedAt: session.detail.updatedAt
    }
  })
  patchHistory(session.agentId, session.detail.sessionId, {
    title: session.detail.title,
    firstPrompt: session.detail.firstPrompt,
    lastActiveAt: session.detail.updatedAt
  })
}

export async function sendPrompt(
  sessionId: string,
  blocks: AcpPromptBlock[]
): Promise<{ stopReason: StopReason }> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`会话不存在: ${sessionId}`)
  const runtime = agents.get(session.agentId)
  const connection = runtime ? requireConnection(runtime) : null
  if (!connection) throw new Error('Agent 未连接')

  if (session.prompting) {
    throw new Error('该会话正在生成回复，请先等待完成或取消')
  }
  if (blocks.length === 0) throw new Error('提示词内容为空')

  ensureTitleFromPrompt(session, blocks)
  session.prompting = true
  emitAcpEvent({ type: 'prompt-start', sessionId })

  try {
    const response = await connection.prompt({
      sessionId,
      prompt: blocks.map(toContentBlock)
    })

    session.detail.updatedAt = Date.now()
    patchHistory(session.agentId, sessionId, { lastActiveAt: session.detail.updatedAt })
    emitAcpEvent({ type: 'prompt-end', sessionId, stopReason: response.stopReason })
    return { stopReason: response.stopReason }
  } catch (error) {
    emitAcpEvent({ type: 'prompt-end', sessionId, error: errorMessage(error) })
    throw error
  } finally {
    session.prompting = false
  }
}

export async function cancelPrompt(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return
  const connection = agents.get(session.agentId)?.connection
  if (!connection) return
  try {
    await connection.cancel({ sessionId })
  } catch {
    // 连接已断开时忽略
  }
}

/* -------------------------------------------------------------------------- */
/* 会话配置                                                                    */
/* -------------------------------------------------------------------------- */

function emitConfigUpdate(sessionId: string, configOptions: SessionConfigOption[]): void {
  emitAcpEvent({
    type: 'session-update',
    sessionId,
    update: { sessionUpdate: 'config_option_update', configOptions }
  })
}

function emitModeUpdate(sessionId: string, currentModeId: string): void {
  emitAcpEvent({
    type: 'session-update',
    sessionId,
    update: { sessionUpdate: 'current_mode_update', currentModeId }
  })
}

function requireSession(sessionId: string): SessionRuntime {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`会话不存在: ${sessionId}`)
  return session
}

export async function setConfigOption(
  sessionId: string,
  configId: string,
  value: string | boolean
): Promise<SessionConfigOption[]> {
  const session = requireSession(sessionId)
  const runtime = agents.get(session.agentId)
  if (!runtime) throw new Error('Agent 未连接')
  const connection = requireConnection(runtime)

  // 布尔型配置项在协议里是带 type 判别的联合，不能直接塞 { value: boolean }
  const request =
    typeof value === 'boolean'
      ? { sessionId, configId, type: 'boolean' as const, value }
      : { sessionId, configId, value }
  const response = await connection.setSessionConfigOption(request)
  const option = session.detail.configOptions?.find((item) => item.id === configId)
  session.detail.configOptions = response.configOptions
  emitConfigUpdate(sessionId, response.configOptions)
  if (option && isRememberedOption(option) && !skipsRememberedOption(session.agentId, option)) {
    rememberConfigValue(session.agentId, configId, value)
  }
  return response.configOptions
}

export async function setMode(sessionId: string, modeId: string): Promise<void> {
  const session = requireSession(sessionId)
  const runtime = agents.get(session.agentId)
  if (!runtime) throw new Error('Agent 未连接')
  const connection = requireConnection(runtime)

  const modeOption = findSelectOption(
    session.detail.configOptions,
    (option) => option.category === 'mode' || option.id === 'mode'
  )

  if (modeOption) {
    const response = await connection.setSessionConfigOption({
      sessionId,
      configId: modeOption.id,
      value: modeId
    })
    session.detail.configOptions = response.configOptions
    emitConfigUpdate(sessionId, response.configOptions)
    rememberConfigValue(session.agentId, modeOption.id, modeId)
  } else {
    await connection.setSessionMode({ sessionId, modeId })
  }
  rememberMode(session.agentId, modeId)

  if (session.detail.modes) {
    session.detail.modes = { ...session.detail.modes, currentModeId: modeId }
  }
  session.detail.updatedAt = Date.now()
  emitModeUpdate(sessionId, modeId)
}

export async function setModel(sessionId: string, modelId: string): Promise<void> {
  const session = requireSession(sessionId)
  const runtime = agents.get(session.agentId)
  if (!runtime) throw new Error('Agent 未连接')
  const connection = requireConnection(runtime)

  const modelOption = findSelectOption(
    session.detail.configOptions,
    (option) => option.category === 'model' || option.id === 'model'
  )

  if (modelOption) {
    const response = await connection.setSessionConfigOption({
      sessionId,
      configId: modelOption.id,
      value: modelId
    })
    session.detail.configOptions = response.configOptions
    emitConfigUpdate(sessionId, response.configOptions)
    rememberConfigValue(session.agentId, modelOption.id, modelId)
    rememberModel(session.agentId, modelId)
    return
  }

  if (typeof connection.unstable_setSessionModel === 'function') {
    await connection.unstable_setSessionModel({ sessionId, modelId })
    rememberModel(session.agentId, modelId)
    return
  }

  throw new Error(`${runtime.config.name} 不支持切换模型`)
}

/* -------------------------------------------------------------------------- */
/* session/update 归约                                                          */
/* -------------------------------------------------------------------------- */

export function applySessionUpdate(notification: SessionNotification): void {
  const session = sessions.get(notification.sessionId)
  if (!session) {
    bufferSessionUpdate(notification)
    return
  }

  const update = notification.update
  let patch: Partial<AcpSessionSummary> | undefined

  switch (update.sessionUpdate) {
    case 'available_commands_update':
      session.detail.availableCommands = update.availableCommands
      break
    case 'config_option_update':
      session.detail.configOptions = update.configOptions
      break
    case 'current_mode_update':
      if (session.detail.modes) {
        session.detail.modes = { ...session.detail.modes, currentModeId: update.currentModeId }
      }
      break
    case 'session_info_update': {
      if (update.title !== undefined) {
        if (update.title === null || update.title === '') delete session.detail.title
        else session.detail.title = update.title
      }
      if (update.updatedAt) {
        const parsed = Date.parse(update.updatedAt)
        session.detail.updatedAt = Number.isFinite(parsed) ? parsed : Date.now()
      } else {
        session.detail.updatedAt = Date.now()
      }
      patch = { title: session.detail.title, updatedAt: session.detail.updatedAt }
      break
    }
    case 'usage_update':
      session.detail.usage = update
      break
    default: {
      const derived = deriveTitle(update)
      if (derived && !session.detail.title) {
        session.detail.title = derived
        session.detail.firstPrompt = session.detail.firstPrompt ?? derived
        session.detail.updatedAt = Date.now()
        patch = {
          title: session.detail.title,
          firstPrompt: session.detail.firstPrompt,
          updatedAt: session.detail.updatedAt
        }
      }
      break
    }
  }

  if (patch) {
    emitAcpEvent({ type: 'session-updated', sessionId: notification.sessionId, patch })
    patchHistory(session.agentId, notification.sessionId, {
      ...(patch.title ? { title: patch.title } : {}),
      lastActiveAt: session.detail.updatedAt
    })
  }

  emitAcpEvent({ type: 'session-update', sessionId: notification.sessionId, update })
}

/* -------------------------------------------------------------------------- */
/* 列表 / 认证 / 快照                                                            */
/* -------------------------------------------------------------------------- */

export async function listSessions(agentId: string, cwd?: string): Promise<AcpRemoteSession[]> {
  const runtime = await ensureAgentConnected(agentId)
  if (!runtime.capabilities.listSessions) return []
  const connection = requireConnection(runtime)

  const response = await connection.listSessions(cwd ? { cwd } : {})
  const remote = response.sessions.map(toRemoteSession)
  reconcile(agentId, remote)
  return remote
}

export async function authenticate(agentId: string, methodId: string): Promise<AcpAuthMethod[]> {
  const runtime = await ensureAgentConnected(agentId)
  const connection = requireConnection(runtime)
  await connection.authenticate({ methodId })
  return runtime.authMethods
}

export function getState(): AcpStateSnapshot {
  const config = getAcpConfig()
  const infos = config.agents.map((agent) => {
    const runtime = agents.get(agent.id)
    return runtime ? toRuntimeInfo(runtime) : { agentId: agent.id, status: 'idle' as const, sessionCount: 0 }
  })

  return {
    agents: infos,
    sessions: [...sessions.values()].map((session) => ({ ...session.detail })),
    permissions: getPendingPermissions()
  }
}

export function getAgents(): AcpAgentRuntimeInfo[] {
  return getState().agents
}

export function getHistory(): AcpHistoryEntry[] {
  return listHistory()
}

/** 只删除本地摘要；正在运行的会话保持不动（renderer 的 forget 也仅刷新历史列表） */
export async function forgetSession(agentId: string, sessionId: string): Promise<void> {
  removeHistory(agentId, sessionId)
}

export function respondPermission(requestId: string, optionId: string | null): void {
  respondToPermission(requestId, optionId)
}

/* -------------------------------------------------------------------------- */
/* 关闭                                                                        */
/* -------------------------------------------------------------------------- */

export function shutdownAcpState(): void {
  cancelAllPermissions()
  disposeAllTerminals()

  for (const runtime of agents.values()) {
    runtime.stopping = true
    runtime.proc?.kill()
    runtime.connection = null
    runtime.proc = null
    runtime.status = 'closed'
  }

  agents.clear()
  sessions.clear()
}
