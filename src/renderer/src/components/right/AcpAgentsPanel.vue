<template>
  <div class="acp-panel">
    <!-- Header -->
    <div class="acp-header">
      <span class="acp-header-title">{{ t('acp.agents') }}</span>
      <div class="acp-header-actions">
        <button class="icon-btn" :title="t('acp.refresh')" :disabled="refreshing" @click="refreshAll">
          <Icon name="refresh" :size="13" />
        </button>
        <button class="icon-btn" :title="t('acp.browseRegistry')" @click="openRegistry">
          <Icon name="plus" :size="14" />
        </button>
        <button class="icon-btn" :title="t('acp.openSettings')" @click="openSettings">
          <Icon name="settings" :size="13" />
        </button>
      </div>
    </div>

    <div v-if="actionError" class="acp-error" :title="actionError">{{ actionError }}</div>

    <!-- Empty state -->
    <div v-if="rows.length === 0" class="acp-empty">
      <Icon name="robot" :size="24" />
      <div class="acp-empty-title">{{ t('acp.settings.noAgents') }}</div>
      <div class="acp-empty-hint">{{ t('acp.settings.description') }}</div>
      <button class="acp-btn acp-btn-primary" @click="openSettings">{{ t('acp.openSettings') }}</button>
    </div>

    <template v-else>
      <!-- Agents -->
      <div class="acp-agents">
        <div v-for="row in rows" :key="row.id" class="acp-agent" :class="{ 'is-disabled': !row.enabled }">
          <div class="acp-agent-head">
            <span class="acp-dot" :class="'dot-' + row.status" :title="statusLabel(row.status)" />
            <span class="acp-agent-name" :title="row.name">{{ row.name }}</span>
            <span v-if="row.pid" class="acp-pid">pid {{ row.pid }}</span>
          </div>
          <div class="acp-agent-cmd" :title="row.commandLine">{{ row.commandLine }}</div>

          <div v-if="row.error" class="acp-error acp-agent-error" :title="row.error">{{ row.error }}</div>

          <div v-if="row.stderrTail" class="acp-stderr-wrap">
            <button class="acp-link" @click="toggleStderr(row.id)">
              <Icon :name="stderrOpen[row.id] ? 'chevron-down' : 'chevron-right'" :size="11" />
              {{ stderrOpen[row.id] ? t('acp.tool.hideDetails') : t('acp.tool.showDetails') }}
            </button>
            <pre v-if="stderrOpen[row.id]" class="acp-stderr">{{ stderrTail(row.stderrTail) }}</pre>
          </div>

          <div v-if="row.capabilities.length > 0" class="acp-caps">
            <span v-for="cap in row.capabilities" :key="cap" class="acp-badge">{{ capLabel(cap) }}</span>
          </div>

          <div class="acp-actions">
            <button class="acp-btn acp-btn-primary" :disabled="busyAgent === row.id" @click="newSession(row.id)">
              {{ t('acp.newSession') }}
            </button>
            <button
              v-if="row.canAuthenticate"
              class="acp-btn"
              :disabled="busyAgent === row.id"
              @click="authenticate(row.id)"
            >{{ t('acp.authenticate') }}</button>
            <button v-if="row.spawned" class="acp-btn" :disabled="busyAgent === row.id" @click="disconnect(row.id)">
              {{ t('acp.disconnect') }}
            </button>
            <button class="acp-btn" :disabled="busyAgent === row.id" @click="restart(row.id)">
              {{ t('acp.restart') }}
            </button>
          </div>

          <!-- Live sessions -->
          <div v-if="row.sessions.length > 0" class="acp-sessions">
            <div
              v-for="session in row.sessions"
              :key="session.sessionId"
              class="acp-session"
              :title="session.title"
              @click="openSession(session.sessionId)"
            >
              <span class="acp-session-dot" :class="{ running: session.running }" />
              <span class="acp-session-title">{{ session.title }}</span>
              <span class="acp-session-time">{{ relativeTime(session.updatedAt) }}</span>
              <button class="acp-icon-btn" :title="t('acp.copy')" @click.stop="copySessionId(session.sessionId)">
                <Icon :name="copiedSessionId === session.sessionId ? 'check' : 'copy'" :size="11" />
              </button>
              <button class="acp-icon-btn" :title="t('acp.close')" @click.stop="closeSession(session.sessionId)">
                <Icon name="x" :size="12" />
              </button>
            </div>
          </div>
          <div v-else class="acp-hint">{{ t('acp.sessionsSection.empty') }}</div>
        </div>
      </div>

      <!-- History -->
      <div v-if="historyGroups.length > 0" class="acp-section">
        <div class="acp-section-title">{{ t('acp.history') }}</div>
        <div v-for="(group, index) in historyGroups" :key="group.agentId" class="acp-history-group">
          <div class="acp-history-head" @click="toggleHistory(group.agentId, index)">
            <Icon :name="isHistoryOpen(group.agentId, index) ? 'chevron-down' : 'chevron-right'" :size="11" />
            <span class="acp-history-agent" :title="group.name">{{ group.name }}</span>
            <span class="acp-history-count">{{ group.entries.length }}</span>
          </div>
          <template v-if="isHistoryOpen(group.agentId, index)">
            <div
              v-for="entry in group.entries"
              :key="entry.sessionId"
              class="acp-history-row"
              :title="t('acp.restore')"
              @click="restoreSession(entry)"
            >
              <span class="acp-history-title">{{ historyTitle(entry) }}</span>
              <span class="acp-history-cwd" :title="entry.cwd">{{ basename(entry.cwd) }}</span>
              <span class="acp-history-time">{{ relativeTime(entry.lastActiveAt) }}</span>
              <button class="acp-icon-btn" :title="t('acp.sessionsSection.forget')" @click.stop="forgetSession(entry)">
                <Icon name="trash" :size="11" />
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- Sessions reported by the agent itself -->
      <div v-if="remoteAgents.length > 0" class="acp-section">
        <div class="acp-section-title">{{ t('acp.sessionsSection.remote') }}</div>
        <div class="acp-remote-controls">
          <select v-if="remoteAgents.length > 1" v-model="remoteAgentId" class="acp-select">
            <option v-for="agent in remoteAgents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
          </select>
          <button class="acp-btn" :disabled="remoteLoading" @click="loadRemoteSessions">
            <Icon name="download" :size="11" />
            <span class="acp-btn-label">{{ t('acp.loadFromAgent') }}</span>
          </button>
        </div>
        <div v-if="remoteError" class="acp-error">{{ remoteError }}</div>
        <div v-if="remoteLoading" class="acp-hint">{{ t('acp.loadingSession') }}</div>
        <div v-else-if="remoteLoaded && remoteSessions.length === 0" class="acp-hint">
          {{ t('acp.sessionsSection.empty') }}
        </div>
        <div v-for="remote in remoteSessions" :key="remote.sessionId" class="acp-remote-row">
          <span class="acp-remote-title" :title="remote.title || remote.sessionId">
            {{ remote.title || remote.sessionId }}
          </span>
          <span v-if="remote.cwd" class="acp-remote-cwd" :title="remote.cwd">{{ basename(remote.cwd) }}</span>
          <button class="acp-btn acp-btn-sm" @click="loadRemoteSession(remote)">{{ t('acp.load') }}</button>
        </div>
      </div>
    </template>

    <!-- Registry modal -->
    <div v-if="showRegistry" class="acp-modal-overlay" @click.self="showRegistry = false">
      <div class="acp-modal">
        <div class="acp-modal-head">
          <span class="acp-modal-title">{{ t('acp.registry.title') }}</span>
          <button class="icon-btn" :title="t('common.close')" @click="showRegistry = false">
            <Icon name="x" :size="14" />
          </button>
        </div>
        <input v-model="registryQuery" class="acp-modal-search" :placeholder="t('acp.registry.search')" />

        <div v-if="registryLoading" class="acp-hint">{{ t('acp.registry.loading') }}</div>
        <div v-else-if="registryError" class="acp-registry-failed">
          <div class="acp-error">{{ registryError }}</div>
          <button class="acp-btn" @click="loadRegistry">{{ t('acp.retry') }}</button>
        </div>
        <div v-else-if="filteredRegistry.length === 0" class="acp-hint">{{ t('acp.registry.empty') }}</div>
        <div v-else class="acp-modal-list">
          <div v-for="agent in filteredRegistry" :key="agent.id" class="acp-registry-item">
            <div class="acp-registry-info">
              <div class="acp-registry-name">
                <span class="acp-registry-label" :title="agent.name">{{ agent.name }}</span>
                <span v-if="agent.version" class="acp-registry-version">v{{ agent.version }}</span>
              </div>
              <div v-if="agent.description" class="acp-registry-desc">{{ agent.description }}</div>
              <div v-if="agent.repository" class="acp-registry-repo" :title="agent.repository">
                {{ t('acp.registry.repository') }}: {{ agent.repository }}
              </div>
              <div v-if="agent.unavailableReason" class="acp-registry-unavailable">{{ agent.unavailableReason }}</div>
            </div>
            <button
              class="acp-btn acp-btn-primary acp-btn-sm"
              :disabled="!!agent.unavailableReason || isRegistryAgentAdded(agent)"
              @click="addFromRegistry(agent)"
            >{{ isRegistryAgentAdded(agent) ? t('acp.registry.added') : t('acp.registry.add') }}</button>
          </div>
        </div>

        <div v-if="registryAddError" class="acp-error">{{ registryAddError }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  AcpAgentConfig,
  AcpAgentRuntimeInfo,
  AcpAgentStatus,
  AcpHistoryEntry,
  AcpRegistryAgent,
  AcpRemoteSession
} from '@shared/acp'
import { useAcpStore } from '../../stores/acp'
import { openSettings } from '../../composables/useGlobalActions'
import Icon from '../ui/Icon.vue'

interface SessionRow {
  sessionId: string
  title: string
  updatedAt: number
  running: boolean
}

interface AgentRow {
  id: string
  name: string
  enabled: boolean
  commandLine: string
  status: AcpAgentStatus
  pid?: number
  error?: string
  stderrTail?: string
  capabilities: string[]
  canAuthenticate: boolean
  spawned: boolean
  sessions: SessionRow[]
}

interface HistoryGroup {
  agentId: string
  name: string
  entries: AcpHistoryEntry[]
}

interface RemoteAgentOption {
  id: string
  name: string
}

const { t, locale } = useI18n()
const acpStore = useAcpStore()

const refreshing = ref(false)
const actionError = ref('')
const busyAgent = ref('')
const stderrOpen = ref<Record<string, boolean>>({})
const historyOpen = ref<Record<string, boolean>>({})
const copiedSessionId = ref('')

const remoteAgentId = ref('')
const remoteSessions = ref<AcpRemoteSession[]>([])
const remoteLoading = ref(false)
const remoteLoaded = ref(false)
const remoteError = ref('')

const showRegistry = ref(false)
const registryQuery = ref('')
const registryLoading = ref(false)
const registryLoaded = ref(false)
const registryError = ref('')
const registryAddError = ref('')

let copyTimer: ReturnType<typeof setTimeout> | null = null

const STATUS_KEY: Record<AcpAgentStatus, string> = {
  idle: 'acp.status.idle',
  starting: 'acp.status.starting',
  ready: 'acp.status.ready',
  error: 'acp.status.error',
  closed: 'acp.status.closed'
}

const CAPABILITY_KEY: Record<string, string> = {
  load: 'acp.capability.load',
  list: 'acp.capability.list',
  resume: 'acp.capability.resume',
  terminal: 'acp.capability.terminal'
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  return typeof e === 'string' ? e : String(e)
}

function basename(path: string | undefined): string {
  if (!path) return ''
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function stderrTail(text: string): string {
  return text.length > 2000 ? text.slice(-2000) : text
}

/** Locale-aware "3 minutes ago" without extra i18n keys. */
function relativeTime(timestamp: number | undefined): string {
  if (!timestamp) return ''
  const diff = timestamp - Date.now()
  const abs = Math.abs(diff)
  const format = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' })
  if (abs < 60_000) return format.format(Math.round(diff / 1000), 'second')
  if (abs < 3_600_000) return format.format(Math.round(diff / 60_000), 'minute')
  if (abs < 86_400_000) return format.format(Math.round(diff / 3_600_000), 'hour')
  return format.format(Math.round(diff / 86_400_000), 'day')
}

function statusLabel(status: AcpAgentStatus): string {
  return t(STATUS_KEY[status])
}

function capLabel(cap: string): string {
  const key = CAPABILITY_KEY[cap]
  return key ? t(key) : cap
}

function capabilitiesOf(info: AcpAgentRuntimeInfo | undefined): string[] {
  const caps = info?.capabilities
  if (!caps) return []
  const list: string[] = []
  if (caps.loadSession) list.push('load')
  if (caps.listSessions) list.push('list')
  if (caps.resumeSession) list.push('resume')
  if (caps.terminal) list.push('terminal')
  return list
}

function isSpawned(info: AcpAgentRuntimeInfo | undefined): boolean {
  if (!info) return false
  if (info.pid !== undefined) return true
  return info.status === 'ready' || info.status === 'starting'
}

function needsAuth(info: AcpAgentRuntimeInfo | undefined): boolean {
  if (!info || info.status !== 'error') return false
  return /auth|login|登录|认证/i.test(info.error ?? '')
}

const rows = computed<AgentRow[]>(() => {
  return acpStore.config.agents.map((agent: AcpAgentConfig) => {
    const info = acpStore.runtimeFor(agent.id)
    const sessions: SessionRow[] = acpStore.sessionsForAgent(agent.id).map((session) => ({
      sessionId: session.sessionId,
      title: truncate(session.title || session.firstPrompt || t('acp.sessionsSection.unnamed'), 80),
      updatedAt: session.updatedAt,
      running: acpStore.getSession(session.sessionId)?.promptInFlight ?? false
    }))
    return {
      id: agent.id,
      name: agent.name || agent.id,
      enabled: agent.enabled !== false,
      commandLine: [agent.command, ...(agent.args ?? [])].join(' '),
      status: info?.status ?? 'idle',
      pid: info?.pid,
      error: info?.error,
      stderrTail: info?.stderrTail,
      capabilities: capabilitiesOf(info),
      canAuthenticate: needsAuth(info),
      spawned: isSpawned(info),
      sessions
    }
  })
})

const historyGroups = computed<HistoryGroup[]>(() => {
  const map = new Map<string, AcpHistoryEntry[]>()
  for (const entry of acpStore.history) {
    const list = map.get(entry.agentId)
    if (list) list.push(entry)
    else map.set(entry.agentId, [entry])
  }
  const groups: HistoryGroup[] = []
  for (const [agentId, entries] of map) {
    entries.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    groups.push({
      agentId,
      name: acpStore.configuredAgent(agentId)?.name ?? agentId,
      entries
    })
  }
  groups.sort((a, b) => (b.entries[0]?.lastActiveAt ?? 0) - (a.entries[0]?.lastActiveAt ?? 0))
  return groups
})

const remoteAgents = computed<RemoteAgentOption[]>(() => {
  const options: RemoteAgentOption[] = []
  for (const agent of acpStore.config.agents) {
    const info = acpStore.runtimeFor(agent.id)
    const live = info?.status === 'ready' || info?.status === 'starting'
    if (live && info?.capabilities?.listSessions) {
      options.push({ id: agent.id, name: agent.name || agent.id })
    }
  }
  return options
})

watch(
  remoteAgents,
  (list) => {
    if (!list.some((agent) => agent.id === remoteAgentId.value)) {
      remoteAgentId.value = list[0]?.id ?? ''
    }
  },
  { immediate: true }
)

const filteredRegistry = computed<AcpRegistryAgent[]>(() => {
  const query = registryQuery.value.trim().toLowerCase()
  const all = [...acpStore.registry].sort((a, b) => a.name.localeCompare(b.name))
  if (!query) return all
  return all.filter((agent) => {
    const haystack = `${agent.name} ${agent.id} ${agent.description ?? ''}`.toLowerCase()
    return haystack.includes(query)
  })
})

/* ------------------------------- actions -------------------------------- */

async function refreshAll(): Promise<void> {
  refreshing.value = true
  actionError.value = ''
  try {
    await Promise.all([acpStore.refreshAgents(), acpStore.refreshHistory()])
  } catch (e) {
    actionError.value = errorText(e)
  } finally {
    refreshing.value = false
  }
}

async function withAgent(agentId: string, action: () => Promise<unknown>): Promise<void> {
  busyAgent.value = agentId
  actionError.value = ''
  try {
    await action()
  } catch (e) {
    actionError.value = errorText(e)
  } finally {
    busyAgent.value = ''
  }
}

function newSession(agentId: string): void {
  void withAgent(agentId, () => acpStore.createSession(agentId))
}

function disconnect(agentId: string): void {
  void withAgent(agentId, () => acpStore.disconnectAgent(agentId))
}

function restart(agentId: string): void {
  void withAgent(agentId, async () => {
    await acpStore.disconnectAgent(agentId)
    await acpStore.createSession(agentId)
  })
}

function authenticate(agentId: string): void {
  void withAgent(agentId, async () => {
    await acpStore.authenticate(agentId, 'login')
    await acpStore.refreshAgents()
  })
}

async function openSession(sessionId: string): Promise<void> {
  actionError.value = ''
  try {
    await acpStore.openChatTab(sessionId)
  } catch (e) {
    actionError.value = errorText(e)
  }
}

async function closeSession(sessionId: string): Promise<void> {
  actionError.value = ''
  try {
    await acpStore.closeSession(sessionId)
  } catch (e) {
    actionError.value = errorText(e)
  }
}

async function copySessionId(sessionId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(sessionId)
    copiedSessionId.value = sessionId
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copiedSessionId.value = ''
    }, 1500)
  } catch (e) {
    actionError.value = errorText(e)
  }
}

function toggleStderr(agentId: string): void {
  stderrOpen.value[agentId] = !stderrOpen.value[agentId]
}

function isHistoryOpen(agentId: string, index: number): boolean {
  return historyOpen.value[agentId] ?? index === 0
}

function toggleHistory(agentId: string, index: number): void {
  historyOpen.value[agentId] = !isHistoryOpen(agentId, index)
}

function historyTitle(entry: AcpHistoryEntry): string {
  return truncate(entry.title || entry.firstPrompt || t('acp.sessionsSection.unnamed'), 120)
}

async function restoreSession(entry: AcpHistoryEntry): Promise<void> {
  actionError.value = ''
  try {
    await acpStore.loadSession(entry.agentId, entry.sessionId, entry.cwd)
  } catch (e) {
    actionError.value = errorText(e)
  }
}

async function forgetSession(entry: AcpHistoryEntry): Promise<void> {
  actionError.value = ''
  try {
    await acpStore.forgetSession(entry.agentId, entry.sessionId)
  } catch (e) {
    actionError.value = errorText(e)
  }
}

async function loadRemoteSessions(): Promise<void> {
  const agentId = remoteAgentId.value
  if (!agentId) return
  remoteLoading.value = true
  remoteError.value = ''
  try {
    remoteSessions.value = await acpStore.listRemoteSessions(agentId)
    remoteLoaded.value = true
  } catch (e) {
    remoteError.value = errorText(e)
  } finally {
    remoteLoading.value = false
  }
}

async function loadRemoteSession(remote: AcpRemoteSession): Promise<void> {
  actionError.value = ''
  try {
    await acpStore.loadSession(remoteAgentId.value, remote.sessionId, remote.cwd)
  } catch (e) {
    actionError.value = errorText(e)
  }
}

/* ------------------------------- registry ------------------------------- */

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'agent'
}

function uniqueAgentId(base: string): string {
  const used = new Set(acpStore.config.agents.map((agent) => agent.id))
  let id = base
  let suffix = 2
  while (used.has(id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  return id
}

function registryCommand(agent: AcpRegistryAgent): { command: string; args: string[] } {
  return { command: agent.command ?? 'npx', args: agent.args ?? [] }
}

function isRegistryAgentAdded(agent: AcpRegistryAgent): boolean {
  const { command, args } = registryCommand(agent)
  return acpStore.config.agents.some((configured) => {
    if (configured.name === agent.name) return true
    return configured.command === command && JSON.stringify(configured.args ?? []) === JSON.stringify(args)
  })
}

async function openRegistry(): Promise<void> {
  showRegistry.value = true
  registryAddError.value = ''
  if (registryLoaded.value) return
  await loadRegistry()
}

async function loadRegistry(): Promise<void> {
  registryLoading.value = true
  registryError.value = ''
  try {
    await acpStore.fetchRegistry()
    registryLoaded.value = true
  } catch (e) {
    registryError.value = errorText(e)
  } finally {
    registryLoading.value = false
  }
}

async function addFromRegistry(agent: AcpRegistryAgent): Promise<void> {
  if (agent.unavailableReason || isRegistryAgentAdded(agent)) return
  registryAddError.value = ''
  const { command, args } = registryCommand(agent)
  const config: AcpAgentConfig = {
    id: uniqueAgentId(slugify(agent.id || agent.name)),
    name: agent.name,
    command,
    args,
    description: agent.description
  }
  try {
    await acpStore.saveConfig({ agents: [...acpStore.config.agents, config] })
  } catch (e) {
    registryAddError.value = errorText(e)
  }
}

/* ------------------------------- lifecycle ------------------------------ */

onMounted(() => {
  void refreshAll()
})

onBeforeUnmount(() => {
  if (copyTimer) {
    clearTimeout(copyTimer)
    copyTimer = null
  }
})
</script>

<style scoped>
.acp-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--bg-secondary);
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.acp-header {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 4px 4px 4px 10px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  position: sticky;
  top: 0;
  background: var(--bg-secondary);
  z-index: 2;
}
.acp-header-title {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acp-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.acp-error {
  margin: 4px 8px;
  padding: 4px 6px;
  font-size: var(--text-xs);
  color: var(--text-danger);
  background: rgba(244, 112, 112, 0.1);
  border-radius: var(--radius-sm);
  word-break: break-word;
  white-space: pre-wrap;
  max-height: 120px;
  overflow: auto;
}

.acp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-5) var(--space-3);
  text-align: center;
  color: var(--text-secondary);
}
.acp-empty-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text-primary);
}
.acp-empty-hint {
  font-size: var(--text-xs);
  line-height: 1.5;
}

.acp-agents {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
}

.acp-agent {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: var(--space-2);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}
.acp-agent.is-disabled {
  opacity: 0.55;
}
.acp-agent-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.acp-agent-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: var(--text-md);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acp-pid {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.acp-agent-cmd {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acp-agent-error {
  margin: 0;
}

.acp-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-pill);
  flex-shrink: 0;
  background: var(--text-faint);
}
.dot-idle { background: var(--text-faint); }
.dot-closed { background: var(--text-faint); opacity: 0.6; }
.dot-ready { background: var(--text-success); }
.dot-error { background: var(--text-danger); }
.dot-starting {
  background: var(--text-accent);
  animation: acp-pulse 1s ease-in-out infinite;
}
@keyframes acp-pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}

.acp-stderr-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.acp-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  align-self: flex-start;
  padding: 1px 2px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--text-accent);
  background: none;
}
.acp-link:hover {
  background: var(--bg-hover);
}
.acp-stderr {
  max-height: 140px;
  overflow: auto;
  padding: 4px 6px;
  margin: 0;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.45;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

.acp-caps {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.acp-badge {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1.6;
  white-space: nowrap;
}

.acp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

.acp-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: var(--text-xs);
  white-space: nowrap;
  overflow: hidden;
}
.acp-btn:not(:disabled):hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}
.acp-btn-primary {
  background: var(--bg-active);
  border-color: transparent;
  color: var(--text-primary);
}
.acp-btn-primary:not(:disabled):hover {
  background: var(--bg-selected);
}
.acp-btn-sm {
  padding: 1px 6px;
}
.acp-btn-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.acp-sessions {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  border-top: 1px solid var(--border-color);
  padding-top: 3px;
  margin-top: 1px;
}
.acp-session {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.acp-session:hover {
  background: var(--bg-hover);
}
.acp-session-dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-pill);
  background: var(--text-faint);
  flex-shrink: 0;
}
.acp-session-dot.running {
  background: var(--text-accent);
  animation: acp-pulse 1.2s ease-in-out infinite;
}
.acp-session-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
}
.acp-session-time {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
}
.acp-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
}
.acp-icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.acp-hint {
  padding: 2px 4px;
  font-size: var(--text-xs);
  color: var(--text-faint);
  line-height: 1.45;
}

.acp-section {
  border-top: 1px solid var(--border-color);
  padding: var(--space-2);
  min-width: 0;
}
.acp-section-title {
  margin-bottom: 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
}

.acp-history-group {
  min-width: 0;
  margin-bottom: 2px;
}
.acp-history-head {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.acp-history-head:hover {
  background: var(--bg-hover);
}
.acp-history-agent {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.acp-history-count {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-faint);
}
.acp-history-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 2px 4px 2px 16px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.acp-history-row:hover {
  background: var(--bg-hover);
}
.acp-history-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
}
.acp-history-cwd,
.acp-remote-cwd {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-faint);
}
.acp-history-time {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
}

.acp-remote-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
  min-width: 0;
}
.acp-select {
  flex: 1;
  min-width: 0;
  max-width: 100%;
  font-size: var(--text-xs);
  padding: 2px 4px;
}
.acp-remote-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
}
.acp-remote-row:hover {
  background: var(--bg-hover);
}
.acp-remote-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
}

.acp-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  background: var(--overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
}
.acp-modal {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: min(480px, 92vw);
  max-height: min(560px, 86vh);
  padding: var(--space-3);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-3);
}
.acp-modal-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.acp-modal-title {
  flex: 1;
  min-width: 0;
  font-size: var(--text-md);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acp-modal-search {
  width: 100%;
  font-size: var(--text-sm);
  padding: 4px 8px;
}
.acp-modal-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
  overflow-y: auto;
}
.acp-registry-failed {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: flex-start;
}
.acp-registry-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}
.acp-registry-info {
  flex: 1;
  min-width: 0;
}
.acp-registry-name {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.acp-registry-label {
  font-weight: 600;
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acp-registry-version {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-faint);
}
.acp-registry-desc {
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.45;
  word-break: break-word;
}
.acp-registry-repo {
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acp-registry-unavailable {
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--text-warning);
}
</style>
