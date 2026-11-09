import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import type {
  AcpAgentRuntimeInfo,
  AcpConfig,
  AcpEvent,
  AcpHistoryEntry,
  AcpPermissionRequest,
  AcpPromptBlock,
  AcpRegistryAgent,
  AcpRemoteSession,
  AcpSessionDetail,
  AcpSessionSummary,
  PlanEntry,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  UsageUpdate
} from '@shared/acp'
import { useTabStore } from './tabs'
import { useProjectStore } from './projects'

/* -------------------------------------------------------------------------- */
/* Chat items                                                                   */
/* -------------------------------------------------------------------------- */

export type ChatItemKind = 'user' | 'agent' | 'thought' | 'tool' | 'plan' | 'notice'

export interface UserChatItem {
  kind: 'user'
  id: string
  at: number
  text: string
}
export interface AgentChatItem {
  kind: 'agent'
  id: string
  at: number
  text: string
  messageId?: string
  streaming: boolean
  /** 来自 session/load 回放的消息：呈现层不要对它们播放入场动画 */
  replay?: boolean
}
export interface ThoughtChatItem {
  kind: 'thought'
  id: string
  at: number
  text: string
  streaming: boolean
}
export interface ToolChatItem {
  kind: 'tool'
  id: string
  at: number
  toolCall: ToolCall
}
export interface PlanChatItem {
  kind: 'plan'
  id: string
  at: number
  entries: PlanEntry[]
}
export interface NoticeChatItem {
  kind: 'notice'
  id: string
  at: number
  level: 'info' | 'warn' | 'error'
  text: string
}
export type ChatItem =
  | UserChatItem
  | AgentChatItem
  | ThoughtChatItem
  | ToolChatItem
  | PlanChatItem
  | NoticeChatItem

export interface AcpSessionState {
  session: AcpSessionDetail
  items: ChatItem[]
  pendingPermissions: AcpPermissionRequest[]
  promptInFlight: boolean
  /** 该会话是否正在被 session/load 回放 */
  loading: boolean
}

function now(): number {
  return Date.now()
}

function itemId(): string {
  return uuidv4()
}

function textOfUpdate(update: SessionUpdate): string {
  const block = (update as { content?: { type: string; text?: string } }).content
  if (!block) return ''
  if (block.type === 'text') return block.text ?? ''
  if (block.type === 'resource_link') {
    const link = block as unknown as { name?: string; uri?: string }
    return `\n[${link.name ?? link.uri ?? 'resource'}]\n`
  }
  return ''
}

/** ACP 的 tool_call_update 语义：undefined 保留旧值，null 清空。 */
function mergeToolCall(prev: ToolCall, patch: ToolCallUpdate): ToolCall {
  const out: Record<string, unknown> = { ...prev }
  for (const key of ['title', 'kind', 'status', 'content', 'locations', 'rawInput', 'rawOutput']) {
    const value = (patch as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (value === null) delete out[key]
    else out[key] = value
  }
  return out as unknown as ToolCall
}

function summaryOf(detail: AcpSessionDetail): AcpSessionSummary {
  return {
    sessionId: detail.sessionId,
    agentId: detail.agentId,
    agentName: detail.agentName,
    cwd: detail.cwd,
    title: detail.title,
    firstPrompt: detail.firstPrompt,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    status: detail.status,
    supportsLoad: detail.supportsLoad,
    supportsResume: detail.supportsResume
  }
}

/* -------------------------------------------------------------------------- */

export const useAcpStore = defineStore('acp', () => {
  const config = ref<AcpConfig>({
    agents: [],
    autoApprovePermissions: 'ask',
    logTraffic: false,
    smoothStreaming: false
  })
  const agents = ref<AcpAgentRuntimeInfo[]>([])
  const sessions = ref<Record<string, AcpSessionState>>({})
  const history = ref<AcpHistoryEntry[]>([])
  const registry = ref<AcpRegistryAgent[]>([])
  const initialized = ref(false)
  const initializing = ref<Promise<void> | null>(null)

  let unsubscribe: (() => void) | null = null

  /* ----------------------------- getters ----------------------------- */

  const agentList = computed(() => agents.value)

  const allSessions = computed(() =>
    Object.values(sessions.value)
      .map((s) => s.session)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )

  function sessionsForAgent(agentId: string): AcpSessionDetail[] {
    return allSessions.value.filter((s) => s.agentId === agentId)
  }

  function runtimeFor(agentId: string): AcpAgentRuntimeInfo | undefined {
    return agents.value.find((a) => a.agentId === agentId)
  }

  function configuredAgent(agentId: string) {
    return config.value.agents.find((a) => a.id === agentId)
  }

  function getSession(sessionId: string): AcpSessionState | null {
    return sessions.value[sessionId] ?? null
  }

  function pendingPermissionFor(sessionId: string): AcpPermissionRequest | null {
    return sessions.value[sessionId]?.pendingPermissions[0] ?? null
  }

  /* --------------------------- session state -------------------------- */

  function ensureSessionState(detail: AcpSessionDetail): AcpSessionState {
    const existing = sessions.value[detail.sessionId]
    if (existing) {
      existing.session = { ...existing.session, ...detail }
      return existing
    }
    const state: AcpSessionState = {
      session: detail,
      items: [],
      pendingPermissions: [],
      promptInFlight: false,
      loading: false
    }
    sessions.value[detail.sessionId] = state
    return state
  }

  function placeholderSession(sessionId: string): AcpSessionState {
    const existing = sessions.value[sessionId]
    if (existing) return existing
    const state: AcpSessionState = {
      session: {
        sessionId,
        agentId: '',
        agentName: '',
        cwd: '',
        createdAt: now(),
        updatedAt: now(),
        status: 'loading',
        supportsLoad: false,
        supportsResume: false
      },
      items: [],
      pendingPermissions: [],
      promptInFlight: false,
      loading: true
    }
    sessions.value[sessionId] = state
    return state
  }

  function dropSession(sessionId: string): void {
    delete sessions.value[sessionId]
  }

  /** 关闭与该会话绑定的所有 Tab（会话被删除 / 关闭时） */
  function closeSessionTabs(sessionId: string): void {
    const tabStore = useTabStore()
    const projectStore = useProjectStore()
    for (const project of projectStore.projects) {
      for (const tab of tabStore.getAllTabs(project.id)) {
        if (tab.type === 'acp-chat' && tab.acpSessionId === sessionId) {
          void tabStore.closeTab(project.id, tab.id)
        }
      }
    }
  }

  function syncTabTitle(sessionId: string, title: string | undefined): void {
    if (!title) return
    const tabStore = useTabStore()
    const projectStore = useProjectStore()
    for (const project of projectStore.projects) {
      for (const tab of tabStore.getAllTabs(project.id)) {
        if (tab.type === 'acp-chat' && tab.acpSessionId === sessionId && tab.title !== title) {
          void tabStore.renameTab(project.id, tab.id, title)
        }
      }
    }
  }

  /* ------------------------------ 初始化 ------------------------------ */

  async function init(): Promise<void> {
    if (initialized.value) return
    if (initializing.value) return initializing.value
    initializing.value = (async () => {
      unsubscribe = window.electronAPI.onAcpEvent(handleEvent)
      try {
        const [cfg, snapshot, hist] = await Promise.all([
          window.electronAPI.acpGetConfig(),
          window.electronAPI.acpGetState(),
          window.electronAPI.acpListHistory()
        ])
        config.value = cfg
        agents.value = snapshot.agents
        history.value = hist
        for (const detail of snapshot.sessions) ensureSessionState(detail)
        for (const perm of snapshot.permissions) attachPermission(perm)
      } catch (e) {
        console.error('[acp] init failed', e)
      } finally {
        initialized.value = true
        initializing.value = null
      }
    })()
    return initializing.value
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    initialized.value = false
  }

  /* ------------------------------ 事件归约 ---------------------------- */

  function handleEvent(event: AcpEvent): void {
    switch (event.type) {
      case 'agent-status': {
        const idx = agents.value.findIndex((a) => a.agentId === event.info.agentId)
        if (idx >= 0) agents.value[idx] = event.info
        else agents.value.push(event.info)
        break
      }
      case 'session-created': {
        ensureSessionState(event.session)
        break
      }
      case 'session-updated': {
        const state = sessions.value[event.sessionId]
        if (!state) break
        Object.assign(state.session, event.patch)
        if (event.patch.updatedAt) state.session.updatedAt = event.patch.updatedAt
        if (event.patch.title) syncTabTitle(event.sessionId, event.patch.title)
        break
      }
      case 'session-removed': {
        dropSession(event.sessionId)
        closeSessionTabs(event.sessionId)
        break
      }
      case 'session-update': {
        applyUpdate(event.sessionId, event.update)
        break
      }
      case 'permission-request': {
        attachPermission(event.request)
        break
      }
      case 'permission-resolved': {
        for (const state of Object.values(sessions.value)) {
          state.pendingPermissions = state.pendingPermissions.filter((p) => p.requestId !== event.requestId)
        }
        break
      }
      case 'prompt-start': {
        const state = sessions.value[event.sessionId]
        if (state) state.promptInFlight = true
        break
      }
      case 'prompt-end': {
        const state = sessions.value[event.sessionId]
        if (state) {
          state.promptInFlight = false
          finishStreaming(state)
          if (event.error) pushNotice(state, 'error', event.error)
          else if (event.stopReason && event.stopReason !== 'end_turn') {
            pushNotice(state, 'info', event.stopReason === 'cancelled' ? '已取消本轮' : `本轮结束：${event.stopReason}`)
          }
        }
        break
      }
      case 'auth-required': {
        pushNoticeForAgent(event.agentId, event.methods)
        break
      }
      case 'file-written': {
        window.dispatchEvent(new CustomEvent('mir-file-written', { detail: { path: event.path } }))
        break
      }
      case 'agent-stderr': {
        const idx = agents.value.findIndex((a) => a.agentId === event.agentId)
        if (idx >= 0) {
          agents.value[idx] = {
            ...agents.value[idx],
            stderrTail: ((agents.value[idx].stderrTail ?? '') + event.chunk).slice(-8000)
          }
        }
        break
      }
      case 'notice': {
        const state = event.sessionId ? sessions.value[event.sessionId] : null
        if (state) pushNotice(state, event.level, event.message)
        break
      }
    }
  }

  function attachPermission(request: AcpPermissionRequest): void {
    const state = sessions.value[request.sessionId]
    if (!state) {
      placeholderSession(request.sessionId)
    }
    const target = sessions.value[request.sessionId]
    if (!target.pendingPermissions.some((p) => p.requestId === request.requestId)) {
      target.pendingPermissions.push(request)
    }
  }

  function pushNoticeForAgent(agentId: string, methods: { id: string; name: string }[]): void {
    const agentName = configuredAgent(agentId)?.name ?? agentId
    const text = methods.length
      ? `${agentName} 需要登录：${methods.map((m) => m.name).join(' / ')}（在右侧 Agents 面板完成认证）`
      : `${agentName} 需要登录`
    for (const state of Object.values(sessions.value)) {
      if (state.session.agentId === agentId) pushNotice(state, 'warn', text)
    }
  }

  function pushNotice(state: AcpSessionState, level: 'info' | 'warn' | 'error', text: string): void {
    state.items.push({ kind: 'notice', id: itemId(), at: now(), level, text })
  }

  function finishStreaming(state: AcpSessionState): void {
    for (const item of state.items) {
      if ((item.kind === 'agent' || item.kind === 'thought') && item.streaming) item.streaming = false
    }
  }

  /** 正在做 session/load 回放的会话；回放产生的消息会打上 replay 标记 */
  const replayingSessions = new Set<string>()

  function applyUpdate(sessionId: string, update: SessionUpdate): void {
    const state = sessions.value[sessionId] ?? placeholderSession(sessionId)

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOfUpdate(update)
        if (!text) return
        const last = state.items[state.items.length - 1]
        const messageId = (update as { messageId?: string | null }).messageId ?? undefined
        if (last && last.kind === 'agent' && last.streaming && (last.messageId ?? undefined) === messageId) {
          last.text += text
        } else {
          if (last && last.kind === 'agent') last.streaming = false
          state.items.push({
            kind: 'agent',
            id: itemId(),
            at: now(),
            text,
            messageId,
            streaming: true,
            replay: replayingSessions.has(sessionId) || undefined
          })
        }
        break
      }
      case 'agent_thought_chunk': {
        const text = textOfUpdate(update)
        if (!text) return
        const last = state.items[state.items.length - 1]
        if (last && last.kind === 'thought' && last.streaming) {
          last.text += text
        } else {
          state.items.push({ kind: 'thought', id: itemId(), at: now(), text, streaming: true })
        }
        break
      }
      case 'user_message_chunk': {
        // 只出现在 session/load 回放里
        const text = textOfUpdate(update)
        if (!text) return
        const last = state.items[state.items.length - 1]
        if (last && last.kind === 'user') last.text += text
        else state.items.push({ kind: 'user', id: itemId(), at: now(), text })
        break
      }
      case 'tool_call': {
        const existing = state.items.find(
          (i): i is ToolChatItem => i.kind === 'tool' && i.toolCall.toolCallId === update.toolCallId
        )
        if (existing) existing.toolCall = mergeToolCall(existing.toolCall, update)
        else {
          const toolCall = { ...update } as ToolCall & { sessionUpdate?: string }
          delete (toolCall as { sessionUpdate?: string }).sessionUpdate
          state.items.push({ kind: 'tool', id: itemId(), at: now(), toolCall })
        }
        break
      }
      case 'tool_call_update': {
        const existing = state.items.find(
          (i): i is ToolChatItem => i.kind === 'tool' && i.toolCall.toolCallId === update.toolCallId
        )
        if (existing) existing.toolCall = mergeToolCall(existing.toolCall, update)
        else {
          const toolCall = { ...update } as ToolCall & { sessionUpdate?: string }
          delete (toolCall as { sessionUpdate?: string }).sessionUpdate
          state.items.push({ kind: 'tool', id: itemId(), at: now(), toolCall })
        }
        break
      }
      case 'plan': {
        state.items.push({ kind: 'plan', id: itemId(), at: now(), entries: update.entries })
        break
      }
      case 'available_commands_update': {
        state.session.availableCommands = update.availableCommands
        break
      }
      case 'current_mode_update': {
        const modes = state.session.modes
        if (modes) state.session.modes = { ...modes, currentModeId: update.currentModeId }
        break
      }
      case 'config_option_update': {
        state.session.configOptions = update.configOptions
        break
      }
      case 'session_info_update': {
        const info = update as { title?: string | null; updatedAt?: string | null }
        if (info.title !== undefined) state.session.title = info.title ?? undefined
        state.session.updatedAt = now()
        if (info.title) syncTabTitle(sessionId, info.title)
        break
      }
      case 'usage_update': {
        state.session.usage = { used: update.used, size: update.size, cost: update.cost } as UsageUpdate
        break
      }
    }
  }

  /* ------------------------------ 数据加载 ---------------------------- */

  async function refreshConfig(): Promise<void> {
    config.value = await window.electronAPI.acpGetConfig()
  }

  async function saveConfig(patch: Partial<AcpConfig>): Promise<void> {
    config.value = await window.electronAPI.acpSetConfig(patch)
    await refreshAgents()
  }

  async function refreshAgents(): Promise<void> {
    agents.value = await window.electronAPI.acpGetAgents()
  }

  async function refreshHistory(): Promise<void> {
    history.value = await window.electronAPI.acpListHistory()
  }

  async function fetchRegistry(): Promise<AcpRegistryAgent[]> {
    registry.value = await window.electronAPI.acpGetRegistry()
    return registry.value
  }

  async function listRemoteSessions(agentId: string, cwd?: string): Promise<AcpRemoteSession[]> {
    try {
      return await window.electronAPI.acpListSessions(agentId, cwd)
    } catch {
      return []
    }
  }

  /* ------------------------------ 会话操作 ---------------------------- */

  function defaultCwd(): string | undefined {
    if (config.value.defaultWorkingDirectory) return config.value.defaultWorkingDirectory
    return useProjectStore().activeProject?.path
  }

  async function createSession(agentId: string, cwd?: string): Promise<AcpSessionDetail> {
    const detail = await window.electronAPI.acpCreateSession(agentId, cwd ?? defaultCwd())
    ensureSessionState(detail)
    await refreshAgents()
    void refreshHistory()
    await openChatTab(detail.sessionId)
    return detail
  }

  async function loadSession(agentId: string, sessionId: string, cwd?: string): Promise<AcpSessionDetail> {
    const placeholder = placeholderSession(sessionId)
    placeholder.loading = true
    replayingSessions.add(sessionId)
    const tab = await openChatTab(sessionId)
    try {
      const detail = await window.electronAPI.acpLoadSession(agentId, sessionId, cwd ?? defaultCwd())
      ensureSessionState(detail)
      placeholder.loading = false
      // 回放出来的消息不会收到 prompt-end，这里补一次收尾，避免最后一个气泡一直停在「输出中」
      finishStreaming(placeholder)
      if (tab) void useTabStore().renameTab(tab.projectId, tab.id, detail.title || detail.agentName || 'ACP')
      void refreshHistory()
      return detail
    } catch (e) {
      placeholder.loading = false
      pushNotice(placeholder, 'error', `恢复会话失败：${(e as Error).message}`)
      throw e
    } finally {
      replayingSessions.delete(sessionId)
    }
  }

  async function resumeSession(agentId: string, sessionId: string, cwd?: string): Promise<AcpSessionDetail> {
    const detail = await window.electronAPI.acpResumeSession(agentId, sessionId, cwd ?? defaultCwd())
    ensureSessionState(detail)
    await openChatTab(detail.sessionId)
    return detail
  }

  async function closeSession(sessionId: string): Promise<void> {
    await window.electronAPI.acpCloseSession(sessionId)
    dropSession(sessionId)
    closeSessionTabs(sessionId)
  }

  async function disconnectAgent(agentId: string): Promise<void> {
    await window.electronAPI.acpDisconnectAgent(agentId)
    for (const [id, state] of Object.entries(sessions.value)) {
      if (state.session.agentId === agentId) {
        dropSession(id)
        closeSessionTabs(id)
      }
    }
    await refreshAgents()
  }

  async function forgetSession(agentId: string, sessionId: string): Promise<void> {
    await window.electronAPI.acpForgetSession(agentId, sessionId)
    await refreshHistory()
  }

  async function authenticate(agentId: string, methodId: string): Promise<void> {
    await window.electronAPI.acpAuthenticate(agentId, methodId)
  }

  /* ------------------------------ 对话操作 ---------------------------- */

  async function sendPrompt(sessionId: string, text: string, attachments: { uri: string; name: string; mimeType?: string }[] = []): Promise<void> {
    const state = sessions.value[sessionId]
    const trimmed = text.trim()
    if (!state || state.promptInFlight) return
    if (!trimmed && attachments.length === 0) return

    const blocks: AcpPromptBlock[] = []
    if (trimmed) blocks.push({ type: 'text', text: trimmed })
    for (const a of attachments) {
      blocks.push({ type: 'resource_link', uri: a.uri, name: a.name, mimeType: a.mimeType })
    }

    state.items.push({ kind: 'user', id: itemId(), at: now(), text: trimmed })
    state.promptInFlight = true
    if (state.items.filter((i) => i.kind === 'user').length === 1) {
      state.session.firstPrompt = trimmed
    }
    try {
      await window.electronAPI.acpSendPrompt(sessionId, blocks)
    } catch (e) {
      state.promptInFlight = false
      pushNotice(state, 'error', `发送失败：${(e as Error).message}`)
    }
  }

  async function cancelPrompt(sessionId: string): Promise<void> {
    await window.electronAPI.acpCancelPrompt(sessionId)
  }

  async function respondPermission(requestId: string, optionId: string | null): Promise<void> {
    await window.electronAPI.acpRespondPermission(requestId, optionId)
    for (const state of Object.values(sessions.value)) {
      state.pendingPermissions = state.pendingPermissions.filter((p) => p.requestId !== requestId)
    }
  }

  async function setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void> {
    const options = await window.electronAPI.acpSetConfigOption(sessionId, configId, value)
    const state = sessions.value[sessionId]
    if (state) state.session.configOptions = options
  }

  async function setMode(sessionId: string, modeId: string): Promise<void> {
    await window.electronAPI.acpSetMode(sessionId, modeId)
    const state = sessions.value[sessionId]
    if (state?.session.modes) {
      state.session.modes = { currentModeId: modeId, availableModes: state.session.modes.availableModes }
    }
  }

  async function setModel(sessionId: string, modelId: string): Promise<void> {
    await window.electronAPI.acpSetModel(sessionId, modelId)
  }

  /* ------------------------------ Tab 关联 ---------------------------- */

  /** 打开（或激活）某会话对应的聊天 Tab。返回被打开的 Tab。 */
  async function openChatTab(sessionId: string) {
    const tabStore = useTabStore()
    const projectStore = useProjectStore()
    const project = projectStore.activeProject ?? projectStore.projects[0]
    if (!project) return null

    for (const tab of tabStore.getAllTabs(project.id)) {
      if (tab.type === 'acp-chat' && tab.acpSessionId === sessionId) {
        void tabStore.setActiveTab(project.id, tab.id)
        return tab
      }
    }

    const state = sessions.value[sessionId]
    const agentId = state?.session.agentId
    const agent = agentId ? config.value.agents.find((a) => a.id === agentId) : undefined
    const tab = await tabStore.addTab(project.id, 'acp-chat', {
      acpSessionId: sessionId,
      title: state?.session.title || agent?.name || 'ACP'
    })
    return tab
  }

  /** 会话对应的 Tab 是否已存在 */
  function hasChatTab(sessionId: string): boolean {
    const tabStore = useTabStore()
    const projectStore = useProjectStore()
    for (const project of projectStore.projects) {
      for (const tab of tabStore.getAllTabs(project.id)) {
        if (tab.type === 'acp-chat' && tab.acpSessionId === sessionId) return true
      }
    }
    return false
  }

  return {
    // state
    config,
    agents,
    sessions,
    history,
    registry,
    initialized,
    // getters
    agentList,
    allSessions,
    sessionsForAgent,
    runtimeFor,
    configuredAgent,
    getSession,
    pendingPermissionFor,
    // lifecycle
    init,
    dispose,
    handleEvent,
    // data
    refreshConfig,
    saveConfig,
    refreshAgents,
    refreshHistory,
    fetchRegistry,
    listRemoteSessions,
    // sessions
    createSession,
    loadSession,
    resumeSession,
    closeSession,
    disconnectAgent,
    forgetSession,
    authenticate,
    // chat
    sendPrompt,
    cancelPrompt,
    respondPermission,
    setConfigOption,
    setMode,
    setModel,
    // tabs
    openChatTab,
    hasChatTab,
    // helpers re-exported for components
    summaryOf
  }
})
