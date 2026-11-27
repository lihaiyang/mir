<template>
  <div class="acp-settings">
    <header class="acp-settings-head">
      <h2 class="acp-settings-title">{{ t('acp.settings.title') }}</h2>
      <p class="acp-settings-desc">{{ t('acp.settings.description') }}</p>
    </header>

    <div class="acp-tabs" role="tablist">
      <button
        v-for="tab in subTabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="acp-tab-btn"
        :class="{ active: activeSubTab === tab.id }"
        @click="activeSubTab = tab.id"
      >
        <span>{{ tab.label }}</span>
        <span v-if="tab.badge !== undefined" class="acp-tab-badge">{{ tab.badge }}</span>
      </button>
    </div>

    <div v-if="errorMsg" class="acp-error">{{ errorMsg }}</div>

    <!-- MIR Harness (built-in agent) ---------------------------------- -->
    <div v-show="activeSubTab === 'harness'" class="acp-harness">
      <HarnessSettingsSection />
    </div>

    <!-- General ------------------------------------------------------- -->
    <div v-show="activeSubTab === 'general'" class="acp-card-stack">
      <div class="settings-card">
        <div class="settings-row">
          <div class="row-info">
            <div class="row-label">{{ t('acp.settings.permissionMode') }}</div>
          </div>
          <select v-model="draft.autoApprovePermissions" class="settings-select" @change="saveGeneral">
            <option value="ask">{{ t('acp.settings.permissionAsk') }}</option>
            <option value="safe">{{ t('acp.settings.permissionSafe', 'Auto-approve read-only & safe commands') }}</option>
            <option value="allowAll">{{ t('acp.settings.permissionAllowAll') }}</option>
          </select>
        </div>

        <div class="settings-row">
          <div class="row-info">
            <div class="row-label">{{ t('acp.settings.restrictFs', 'Restrict file writes to workspace') }}</div>
            <div class="acp-hint">{{ t('acp.settings.restrictFsHint', 'Block agents from writing files outside the session working directory.') }}</div>
          </div>
          <label class="toggle">
            <input role="switch" type="checkbox" v-model="draft.restrictFsToWorkspace" @change="saveGeneral" />
            <span class="toggle-track" />
          </label>
        </div>

        <div class="settings-row">
          <div class="row-info">
            <div class="row-label">{{ t('acp.settings.autoOpenModifiedFiles', 'Auto-open files written by Agent') }}</div>
            <div class="acp-hint">{{ t('acp.settings.autoOpenModifiedFilesHint', 'Automatically open modified files in the editor and mark them in the file tree.') }}</div>
          </div>
          <label class="toggle">
            <input role="switch" type="checkbox" v-model="draft.autoOpenModifiedFiles" @change="saveGeneral" />
            <span class="toggle-track" />
          </label>
        </div>

        <div class="settings-row">
          <div class="row-info">
            <div class="row-label">{{ t('acp.settings.smoothStreaming') }}</div>
            <div class="acp-hint">{{ t('acp.settings.smoothStreamingHint') }}</div>
          </div>
          <label class="toggle">
            <input role="switch" type="checkbox" v-model="draft.smoothStreaming" @change="saveGeneral" />
            <span class="toggle-track" />
          </label>
        </div>

        <div class="settings-row">
          <div class="row-info">
            <div class="row-label">{{ t('acp.settings.logTraffic') }}</div>
          </div>
          <label class="toggle">
            <input role="switch" type="checkbox" v-model="draft.logTraffic" @change="saveGeneral" />
            <span class="toggle-track" />
          </label>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-row settings-row-col">
          <div class="row-label">{{ t('acp.settings.defaultCwd') }}</div>
          <div class="acp-row">
            <input
              v-model="draft.defaultWorkingDirectory"
              class="settings-input"
              :placeholder="t('acp.settings.defaultCwdHint')"
              @keydown.enter="saveGeneral"
              @blur="saveGeneral"
            />
            <button class="acp-btn" type="button" @click="browseWorkingDirectory">
              {{ t('acp.settings.browse') }}
            </button>
          </div>
          <div class="acp-hint">{{ t('acp.settings.defaultCwdHint') }}</div>
        </div>
      </div>
    </div>

    <!-- Agents -------------------------------------------------------- -->
    <div v-show="activeSubTab === 'agents'" class="acp-block acp-block--plain">
      <div class="acp-block-head">
        <span class="acp-block-title">{{ t('acp.settings.agents') }}</span>
        <span v-if="saved" class="acp-saved">{{ t('acp.settings.saved') }}</span>
        <div class="acp-block-actions">
          <button class="acp-btn" type="button" @click="toggleRegistry">{{ t('acp.browseRegistry') }}</button>
          <button class="acp-btn" type="button" @click="addAgent">{{ t('acp.settings.addAgent') }}</button>
          <button class="acp-btn acp-btn-primary" type="button" :disabled="saving" @click="saveAgents">
            {{ t('acp.settings.saveAgents') }}
          </button>
        </div>
      </div>

      <div v-if="draft.agents.length === 0" class="acp-hint">{{ t('acp.settings.noAgents') }}</div>

      <div
        v-for="agent in draft.agents"
        :key="agent.id"
        class="acp-agent-card"
        :class="{ 'is-disabled': agent.enabled === false }"
      >
        <div class="acp-agent-summary">
          <button
            class="acp-expand"
            type="button"
            :title="isExpanded(agent.id) ? t('common.collapse') : t('common.expand')"
            @click="toggleExpanded(agent.id)"
           :aria-label="isExpanded(agent.id) ? t('common.collapse') : t('common.expand')">
            <Icon :name="isExpanded(agent.id) ? 'chevron-down' : 'chevron-right'" :size="12" />
          </button>
          <input
            type="checkbox"
            v-model="agent.enabled"
            :title="t('acp.settings.enabled')"
            @change="saveAgents"
          />
          <span class="acp-agent-name" :title="agent.name || agent.id">{{ agent.name || agent.id }}</span>
          <span class="acp-agent-cmd" :title="agent.command">{{ agent.command }}</span>
          <button
            class="acp-btn acp-btn-sm acp-btn-danger"
            type="button"
            @click="removeAgent(agent.id)"
          >{{ pendingRemoveId === agent.id ? t('acp.settings.removeConfirm') : t('common.remove') }}</button>
        </div>

        <div v-if="isExpanded(agent.id)" class="acp-agent-fields">
          <label class="acp-field">
            <span class="settings-label">{{ t('acp.settings.agentName') }}</span>
            <input v-model="agent.name" class="settings-input" />
          </label>
          <label class="acp-field">
            <span class="settings-label">{{ t('acp.settings.command') }}</span>
            <input v-model="agent.command" class="settings-input" placeholder="npx" />
          </label>
          <label class="acp-field">
            <span class="settings-label">{{ t('acp.settings.args') }}</span>
            <textarea v-model="agent.argsText" class="settings-input acp-textarea" rows="3" />
          </label>
          <label class="acp-field">
            <span class="settings-label">{{ t('acp.settings.env') }}</span>
            <textarea v-model="agent.envText" class="settings-input acp-textarea" rows="3" placeholder="KEY=VALUE" />
          </label>
          <label class="acp-field">
            <span class="settings-label">{{ t('acp.settings.descriptionLabel') }}</span>
            <input v-model="agent.description" class="settings-input" />
          </label>
        </div>
      </div>

      <!-- Inline registry -->
      <div v-if="showRegistry" class="acp-registry">
        <div class="acp-registry-head">
          <input v-model="registryQuery" class="settings-input" :placeholder="t('acp.registry.search')" />
          <button class="icon-btn" type="button" :title="t('common.close')" @click="showRegistry = false" :aria-label="t('common.close')">
            <Icon name="x" :size="13" />
          </button>
        </div>
        <div v-if="registryLoading" class="acp-hint">{{ t('acp.registry.loading') }}</div>
        <div v-else-if="registryError" class="acp-error">{{ registryError }}</div>
        <div v-else-if="filteredRegistry.length === 0" class="acp-hint">{{ t('acp.registry.empty') }}</div>
        <div v-else class="acp-registry-list">
          <div v-for="item in filteredRegistry" :key="item.id" class="acp-registry-row">
            <span class="acp-registry-name" :title="item.description || item.name">{{ item.name }}</span>
            <span v-if="item.installed" class="acp-registry-installed">{{ t('acp.registry.installed') }}</span>
            <span v-if="item.unavailableReason" class="acp-registry-unavailable">{{ item.unavailableReason }}</span>
            <button
              class="acp-btn acp-btn-sm"
              type="button"
              :disabled="!!item.unavailableReason || isRegistryAgentAdded(item)"
              @click="addFromRegistry(item)"
            >{{ isRegistryAgentAdded(item) ? t('acp.registry.added') : t('acp.registry.add') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- MCP Servers --------------------------------------------------- -->
    <div v-show="activeSubTab === 'mcp'" class="acp-block acp-block--plain">
      <div class="acp-block-head">
        <span class="acp-block-title">{{ t('acp.settings.mcpServers', 'MCP Servers') }}</span>
        <div class="acp-block-actions">
          <button class="acp-btn" type="button" @click="addMcpServer">{{ t('acp.settings.addMcp', 'Add MCP') }}</button>
          <button class="acp-btn acp-btn-primary" type="button" :disabled="saving" @click="saveMcpServers">
            {{ t('acp.settings.saveMcp', 'Save MCP') }}
          </button>
        </div>
      </div>

      <div v-if="draft.mcpServers.length === 0" class="acp-hint">
        {{ t('acp.settings.noMcpServers', 'No MCP servers configured. Enabled stdio servers are injected into new ACP sessions.') }}
      </div>

      <div
        v-for="server in draft.mcpServers"
        :key="server.id"
        class="acp-agent-card"
        :class="{ 'is-disabled': server.enabled === false }"
      >
        <div class="acp-agent-summary">
          <button
            class="acp-expand"
            type="button"
            @click="toggleExpanded('mcp:' + server.id)"
           :aria-label="isExpanded('mcp:' + server.id) ? t('common.collapse') : t('common.expand')">
            <Icon :name="isExpanded('mcp:' + server.id) ? 'chevron-down' : 'chevron-right'" :size="12" />
          </button>
          <input
            type="checkbox"
            v-model="server.enabled"
            @change="saveMcpServers"
          />
          <span class="acp-agent-name">{{ server.name || server.id }}</span>
          <span class="acp-agent-cmd">{{ server.command }}</span>
          <button
            class="acp-btn acp-btn-sm acp-btn-danger"
            type="button"
            @click="removeMcpServer(server.id)"
          >{{ t('common.remove') }}</button>
        </div>

        <div v-if="isExpanded('mcp:' + server.id)" class="acp-agent-fields">
          <label class="acp-field">
            <span class="settings-label">{{ t('acp.settings.mcpName', 'Name') }}</span>
            <input v-model="server.name" class="settings-input" placeholder="filesystem" />
          </label>
          <label class="acp-field">
            <span class="settings-label">{{ t('acp.settings.command') }}</span>
            <input v-model="server.command" class="settings-input" placeholder="npx" />
          </label>
          <label class="acp-field">
            <span class="settings-label">{{ t('acp.settings.args') }}</span>
            <textarea v-model="server.argsText" class="settings-input acp-textarea" rows="2" placeholder="-y&#10;@modelcontextprotocol/server-filesystem" />
          </label>
          <label class="acp-field">
            <span class="settings-label">{{ t('acp.settings.env') }}</span>
            <textarea v-model="server.envText" class="settings-input acp-textarea" rows="2" placeholder="KEY=VALUE" />
          </label>
        </div>
      </div>
    </div>

    <!-- Runtime (read-only) ------------------------------------------- -->
    <div v-show="activeSubTab === 'runtime'" class="acp-block acp-block--plain">
      <div class="acp-block-head">
        <span class="acp-block-title">{{ t('acp.settings.runtime') }}</span>
        <div class="acp-block-actions">
          <button class="acp-btn" type="button" :disabled="refreshing" @click="refreshRuntime">
            {{ t('acp.refresh') }}
          </button>
        </div>
      </div>
      <div v-if="acpStore.config.agents.length === 0" class="acp-hint">{{ t('acp.settings.noAgents') }}</div>
      <div v-for="agent in acpStore.config.agents" :key="'runtime-' + agent.id" class="acp-runtime-row">
        <span class="acp-dot" :class="'dot-' + runtimeStatus(agent.id)" />
        <span class="acp-runtime-name" :title="agent.name">{{ agent.name || agent.id }}</span>
        <span class="acp-runtime-status">{{ statusLabel(runtimeStatus(agent.id)) }}</span>
        <span v-if="runtimePid(agent.id)" class="acp-runtime-meta">pid {{ runtimePid(agent.id) }}</span>
        <span class="acp-runtime-meta">
          {{ t('acp.settings.sessionCount', { count: acpStore.sessionsForAgent(agent.id).length }) }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  AcpAgentConfig,
  AcpAgentStatus,
  AcpAutoApprove,
  AcpConfig,
  AcpMcpServerConfig,
  AcpRegistryAgent
} from '@shared/acp'
import { useAcpStore } from '../stores/acp'
import Icon from './ui/Icon.vue'
import HarnessSettingsSection from './HarnessSettingsSection.vue'

/** Draft row: the persisted config plus textarea-friendly text forms. */
interface AgentDraft extends AcpAgentConfig {
  argsText: string
  envText: string
}

interface McpServerDraft extends AcpMcpServerConfig {
  argsText: string
  envText: string
}

interface ConfigDraft {
  agents: AgentDraft[]
  mcpServers: McpServerDraft[]
  autoApprovePermissions: AcpAutoApprove
  logTraffic: boolean
  smoothStreaming: boolean
  autoOpenModifiedFiles: boolean
  restrictFsToWorkspace: boolean
  defaultWorkingDirectory: string
}

const { t } = useI18n()
const acpStore = useAcpStore()

type SubTabId = 'general' | 'harness' | 'agents' | 'mcp' | 'runtime'
const activeSubTab = ref<SubTabId>('general')
const subTabs = computed<Array<{ id: SubTabId; label: string; badge?: number }>>(() => [
  { id: 'general', label: t('acp.settings.tabGeneral', 'General') },
  { id: 'harness', label: 'MIR Harness' },
  { id: 'agents', label: t('acp.settings.agents'), badge: draft.value.agents.length },
  { id: 'mcp', label: t('acp.settings.mcpServers', 'MCP Servers'), badge: draft.value.mcpServers.length },
  { id: 'runtime', label: t('acp.settings.runtime') }
])

const saving = ref(false)
const saved = ref(false)
const errorMsg = ref('')
const refreshing = ref(false)
const expanded = ref<Record<string, boolean>>({})
const pendingRemoveId = ref<string | null>(null)

const showRegistry = ref(false)
const registryQuery = ref('')
const registryLoading = ref(false)
const registryLoaded = ref(false)
const registryError = ref('')

let savedTimer: ReturnType<typeof setTimeout> | null = null
let removeTimer: ReturnType<typeof setTimeout> | null = null
/** Signature of the agents array as of the last seed/save; used to detect local edits. */
let seedSignature = ''

const STATUS_KEY: Record<AcpAgentStatus, string> = {
  idle: 'acp.status.idle',
  starting: 'acp.status.starting',
  ready: 'acp.status.ready',
  error: 'acp.status.error',
  closed: 'acp.status.closed'
}

function toDraft(config: AcpConfig): ConfigDraft {
  return {
    agents: config.agents.map((agent) => ({
      ...agent,
      args: [...(agent.args ?? [])],
      env: { ...(agent.env ?? {}) },
      argsText: (agent.args ?? []).join('\n'),
      envText: Object.entries(agent.env ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    })),
    mcpServers: (config.mcpServers ?? []).map((s) => ({
      ...s,
      args: [...(s.args ?? [])],
      env: { ...(s.env ?? {}) },
      argsText: (s.args ?? []).join('\n'),
      envText: Object.entries(s.env ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    })),
    autoApprovePermissions: config.autoApprovePermissions,
    logTraffic: config.logTraffic,
    smoothStreaming: config.smoothStreaming,
    autoOpenModifiedFiles: config.autoOpenModifiedFiles !== false,
    restrictFsToWorkspace: config.restrictFsToWorkspace === true,
    defaultWorkingDirectory: config.defaultWorkingDirectory ?? ''
  }
}

function argsFromText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function envFromText(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (key) env[key] = line.slice(index + 1).trim()
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function toConfig(draft: ConfigDraft): AcpConfig {
  const agents: AcpAgentConfig[] = draft.agents.map((agent) => {
    const command = agent.command.trim() || 'npx'
    const description = agent.description?.trim()
    const config: AcpAgentConfig = {
      id: agent.id,
      name: agent.name.trim() || command || agent.id,
      command,
      enabled: agent.enabled !== false
    }
    const args = argsFromText(agent.argsText)
    if (args.length > 0) config.args = args
    const env = envFromText(agent.envText)
    if (env) config.env = env
    if (description) config.description = description
    return config
  })
  const mcpServers: AcpMcpServerConfig[] = draft.mcpServers.map((s) => {
    const command = s.command.trim() || 'npx'
    const server: AcpMcpServerConfig = {
      id: s.id,
      name: s.name.trim() || command || s.id,
      command,
      enabled: s.enabled !== false
    }
    const args = argsFromText(s.argsText)
    if (args.length > 0) server.args = args
    const env = envFromText(s.envText)
    if (env) server.env = env
    return server
  })
  return {
    agents,
    mcpServers,
    autoApprovePermissions: draft.autoApprovePermissions,
    logTraffic: draft.logTraffic,
    smoothStreaming: draft.smoothStreaming,
    autoOpenModifiedFiles: draft.autoOpenModifiedFiles,
    restrictFsToWorkspace: draft.restrictFsToWorkspace,
    defaultWorkingDirectory: draft.defaultWorkingDirectory.trim()
  }
}

function agentSignature(agents: AcpAgentConfig[]): string {
  return agents
    .map((agent) =>
      [
        agent.id,
        agent.name,
        agent.command,
        (agent.args ?? []).join('\u0000'),
        JSON.stringify(agent.env ?? {}),
        agent.description ?? '',
        agent.enabled !== false ? '1' : '0'
      ].join('\u0001')
    )
    .join('\u0002')
}

function seed(config: AcpConfig): void {
  draft.value = toDraft(config)
  seedSignature = agentSignature(toConfig(draft.value).agents)
}

const draft = ref<ConfigDraft>(toDraft(acpStore.config))
seedSignature = agentSignature(toConfig(draft.value).agents)

watch(
  () => acpStore.config,
  (config) => {
    // Only re-seed while the draft has no unsaved agent edits.
    if (agentSignature(toConfig(draft.value).agents) === seedSignature) seed(config)
  },
  { deep: true }
)

/* ------------------------------- helpers -------------------------------- */

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  return typeof e === 'string' ? e : String(e)
}

function flashSaved(): void {
  saved.value = true
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => {
    saved.value = false
  }, 2000)
}

function statusLabel(status: AcpAgentStatus): string {
  return t(STATUS_KEY[status])
}

function runtimeStatus(agentId: string): AcpAgentStatus {
  return acpStore.runtimeFor(agentId)?.status ?? 'idle'
}

function runtimePid(agentId: string): number | undefined {
  return acpStore.runtimeFor(agentId)?.pid
}

function isExpanded(agentId: string): boolean {
  return expanded.value[agentId] ?? false
}

function toggleExpanded(agentId: string): void {
  expanded.value[agentId] = !isExpanded(agentId)
}

/* ------------------------------- persistence ---------------------------- */

async function persist(patch: Partial<AcpConfig>, flash: boolean): Promise<void> {
  saving.value = true
  errorMsg.value = ''
  try {
    await acpStore.saveConfig(patch)
    if (flash) flashSaved()
  } catch (e) {
    errorMsg.value = errorText(e)
  } finally {
    saving.value = false
  }
}

async function saveGeneral(): Promise<void> {
  const current = acpStore.config
  const unchanged =
    current.autoApprovePermissions === draft.value.autoApprovePermissions &&
    current.logTraffic === draft.value.logTraffic &&
    current.smoothStreaming === draft.value.smoothStreaming &&
    (current.autoOpenModifiedFiles !== false) === draft.value.autoOpenModifiedFiles &&
    (current.restrictFsToWorkspace === true) === draft.value.restrictFsToWorkspace &&
    (current.defaultWorkingDirectory ?? '') === draft.value.defaultWorkingDirectory.trim()
  if (unchanged) return
  await persist(
    {
      autoApprovePermissions: draft.value.autoApprovePermissions,
      logTraffic: draft.value.logTraffic,
      smoothStreaming: draft.value.smoothStreaming,
      autoOpenModifiedFiles: draft.value.autoOpenModifiedFiles,
      restrictFsToWorkspace: draft.value.restrictFsToWorkspace,
      defaultWorkingDirectory: draft.value.defaultWorkingDirectory.trim()
    },
    false
  )
}

async function saveAgents(): Promise<void> {
  await persist({ agents: toConfig(draft.value).agents }, true)
  if (!errorMsg.value) seedSignature = agentSignature(acpStore.config.agents)
}

function addMcpServer(): void {
  const id = `mcp-${Date.now().toString(36)}`
  draft.value.mcpServers.push({
    id,
    name: 'New MCP',
    command: 'npx',
    args: [],
    env: {},
    enabled: true,
    argsText: '',
    envText: ''
  })
  expanded.value['mcp:' + id] = true
}

function removeMcpServer(id: string): void {
  draft.value.mcpServers = draft.value.mcpServers.filter((s) => s.id !== id)
  void saveMcpServers()
}

async function saveMcpServers(): Promise<void> {
  await persist({ mcpServers: toConfig(draft.value).mcpServers }, true)
}

async function browseWorkingDirectory(): Promise<void> {
  try {
    const directory = await window.electronAPI.openFolder()
    if (!directory) return
    draft.value.defaultWorkingDirectory = directory
    await saveGeneral()
  } catch (e) {
    errorMsg.value = errorText(e)
  }
}

/* ------------------------------- agent CRUD ----------------------------- */

function addAgent(): void {
  const id = crypto.randomUUID()
  draft.value.agents.push({
    id,
    name: '',
    command: 'npx',
    args: [],
    argsText: '',
    envText: '',
    enabled: true
  })
  expanded.value[id] = true
  pendingRemoveId.value = null
}

function removeAgent(agentId: string): void {
  if (pendingRemoveId.value !== agentId) {
    pendingRemoveId.value = agentId
    if (removeTimer) clearTimeout(removeTimer)
    removeTimer = setTimeout(() => {
      pendingRemoveId.value = null
    }, 3000)
    return
  }
  pendingRemoveId.value = null
  if (removeTimer) {
    clearTimeout(removeTimer)
    removeTimer = null
  }
  draft.value.agents = draft.value.agents.filter((agent) => agent.id !== agentId)
  void saveAgents()
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
  const used = new Set(draft.value.agents.map((agent) => agent.id))
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
  return draft.value.agents.some((configured) => {
    if (configured.name === agent.name) return true
    return configured.command === command && JSON.stringify(argsFromText(configured.argsText)) === JSON.stringify(args)
  })
}

const filteredRegistry = computed<AcpRegistryAgent[]>(() => {
  const query = registryQuery.value.trim().toLowerCase()
  const rank = (a: AcpRegistryAgent): number => (a.installed ? 0 : !a.unavailableReason ? 1 : 2)
  const all = [...acpStore.registry].sort((a, b) => {
    const diff = rank(a) - rank(b)
    return diff !== 0 ? diff : a.name.localeCompare(b.name)
  })
  if (!query) return all
  return all.filter((agent) => {
    const haystack = `${agent.name} ${agent.id} ${agent.description ?? ''}`.toLowerCase()
    return haystack.includes(query)
  })
})

async function toggleRegistry(): Promise<void> {
  showRegistry.value = !showRegistry.value
  if (!showRegistry.value || registryLoaded.value) return
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

function addFromRegistry(agent: AcpRegistryAgent): void {
  if (agent.unavailableReason || isRegistryAgentAdded(agent)) return
  const { command, args } = registryCommand(agent)
  const id = uniqueAgentId(slugify(agent.id || agent.name))
  draft.value.agents.push({
    id,
    name: agent.name,
    command,
    description: agent.description,
    args: [...args],
    argsText: args.join('\n'),
    env: {},
    envText: '',
    enabled: true
  })
  expanded.value[id] = true
}

/* ------------------------------- runtime -------------------------------- */

async function refreshRuntime(): Promise<void> {
  refreshing.value = true
  errorMsg.value = ''
  try {
    await Promise.all([acpStore.refreshAgents(), acpStore.refreshHistory()])
  } catch (e) {
    errorMsg.value = errorText(e)
  } finally {
    refreshing.value = false
  }
}

onBeforeUnmount(() => {
  if (savedTimer) {
    clearTimeout(savedTimer)
    savedTimer = null
  }
  if (removeTimer) {
    clearTimeout(removeTimer)
    removeTimer = null
  }
})
</script>

<style scoped>
.acp-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  max-width: 100%;
  color: var(--text-primary);
  font-size: var(--text-md);
}

.acp-settings-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.acp-settings-title {
  margin: 0;
  font-size: calc(var(--base-font-size) * 1.2);
  font-weight: 600;
  letter-spacing: -0.01em;
}
.acp-settings-desc {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.5;
}

.acp-tabs {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 3px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  align-self: flex-start;
}
.acp-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--text-secondary);
  transition: background var(--transition-fast) ease, color var(--transition-fast) ease;
}
.acp-tab-btn:hover { color: var(--text-primary); }
.acp-tab-btn.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-1);
}
.acp-tab-badge {
  padding: 0 5px;
  border-radius: 999px;
  font-size: var(--text-3xs);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.acp-tab-btn.active .acp-tab-badge {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.acp-card-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.settings-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
}
.settings-row + .settings-row {
  border-top: 1px solid var(--border-hairline);
}
.settings-row-col {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}
.row-info { flex: 1; min-width: 0; }
.row-label { font-size: var(--text-sm); font-weight: 500; color: var(--text-primary); }

.toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  flex-shrink: 0;
}
.toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.toggle-track {
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  position: relative;
  transition: background var(--transition-fast) ease, border-color var(--transition-fast) ease;
}
.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-secondary);
  transition: transform var(--transition-fast) ease, background var(--transition-fast) ease;
}
.toggle input:checked + .toggle-track {
  background: var(--accent);
  border-color: var(--accent);
}
.toggle input:checked + .toggle-track::after {
  transform: translateX(16px);
  background: var(--text-on-accent);
}
.toggle input:focus-visible + .toggle-track {
  box-shadow: var(--focus-ring);
}

.acp-block--plain {
  padding-top: 0 !important;
  border-top: none !important;
}

/* MIR Harness block sits above the ACP groups; the divider keeps the two
   scopes visually separate without another top-level heading. */
.acp-harness {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-color);
}
.acp-divider {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.acp-divider-title {
  flex-shrink: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.acp-divider::after {
  content: '';
  flex: 1;
  min-width: 0;
  height: 1px;
  background: var(--border-color);
}

/* Mirrors the settings-tab form classes; scoped styles do not cross components. */
.settings-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.settings-group-row {
  flex-direction: row;
  align-items: center;
}
.settings-label {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  font-weight: 600;
}
.settings-input {
  width: 100%;
  min-width: 0;
  padding: 6px 10px;
  font-size: var(--text-sm);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
}
.settings-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.settings-select {
  padding: 6px 10px;
  font-size: var(--text-sm);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  max-width: 100%;
}

.acp-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.acp-error {
  padding: 5px 8px;
  font-size: var(--text-xs);
  color: var(--text-danger);
  background: rgba(244, 112, 112, 0.1);
  border-radius: var(--radius-sm);
  word-break: break-word;
  white-space: pre-wrap;
}

.acp-hint {
  font-size: var(--text-xs);
  color: var(--text-faint);
  line-height: 1.5;
}

.acp-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 3px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.acp-btn:not(:disabled):hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}
.acp-btn-primary {
  background: var(--bg-active);
  border-color: transparent;
}
.acp-btn-primary:not(:disabled):hover {
  background: var(--bg-selected);
}
.acp-btn-sm {
  padding: 1px 8px;
  font-size: var(--text-xs);
}
.acp-btn-danger {
  color: var(--text-danger);
}
.acp-btn-danger:hover {
  background: rgba(244, 112, 112, 0.12);
}

.acp-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-color);
}
.acp-block-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.acp-block-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.acp-block-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-left: auto;
}
.acp-saved {
  font-size: var(--text-xs);
  color: var(--text-success);
}

.acp-agent-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-2);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}
.acp-agent-card.is-disabled {
  opacity: 0.6;
}
.acp-agent-summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.acp-expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
}
.acp-expand:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
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
.acp-agent-cmd {
  max-width: 40%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-faint);
}

.acp-agent-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
  padding-left: 26px;
  min-width: 0;
}
.acp-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.acp-textarea {
  resize: vertical;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.5;
}

.acp-registry {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  min-width: 0;
}
.acp-registry-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
.acp-registry-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
}
.acp-registry-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
}
.acp-registry-row:hover {
  background: var(--bg-hover);
}
.acp-registry-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
}
.acp-registry-installed {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--success-soft);
  color: var(--text-success);
  font-size: var(--text-3xs);
  font-weight: 600;
}
.acp-registry-unavailable {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--text-warning);
}

.acp-runtime-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}
.acp-runtime-row:hover {
  background: var(--bg-hover);
}
.acp-runtime-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acp-runtime-status {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.acp-runtime-meta {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-faint);
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
</style>
