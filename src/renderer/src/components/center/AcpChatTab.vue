<template>
  <div class="acp-chat">
    <template v-if="session">
      <SessionHeader :session="session" :agent-name="agentName" :busy="busy" @cancel="onCancel" />

      <div v-if="loading" class="chat-banner">
        <Icon name="rotate" :size="12" class-name="spin" />
        <span>{{ t('acp.chat.replaying', 'Loading session history…') }}</span>
      </div>
      <div v-else-if="sessionStatus !== 'active'" class="chat-banner chat-banner--warn">
        <Icon name="alert-triangle" :size="12" />
        <span>{{ sessionStatusNotice }}</span>
      </div>

      <div class="chat-body">
        <div ref="listEl" class="chat-list" @scroll="onScroll">
          <div v-if="!items.length" class="chat-empty">
            <Icon name="robot" :size="28" class="chat-empty-icon" />
            <div class="chat-empty-title">{{ agentName }}</div>
            <div class="chat-empty-hint">
              {{ t('acp.chat.emptyHint', 'Send a message to start the conversation') }}
            </div>

            <div v-if="availableCommands.length" class="chat-commands">
              <div class="chat-commands-label">{{ t('acp.chat.commandsTitle', 'Slash commands') }}</div>
              <div class="chat-command-chips">
                <button
                  v-for="command in availableCommands"
                  :key="command.name"
                  class="chat-command-chip"
                  type="button"
                  :title="command.description"
                  @click="seedComposer(`/${command.name} `)"
                >
                  <span class="chat-command-name">/{{ command.name }}</span>
                  <span class="chat-command-desc">{{ command.description }}</span>
                </button>
              </div>
            </div>
          </div>

          <template v-else>
            <template v-for="item in items" :key="item.id">
              <PlanCard v-if="item.kind === 'plan'" :entries="item.entries" />
              <ToolCallCard v-else-if="item.kind === 'tool'" :tool-call="item.toolCall" />
              <ChatMessage v-else :item="item" />
            </template>
          </template>
        </div>

        <button
          v-if="showJump"
          class="chat-jump"
          type="button"
          @click="jumpToLatest"
        >
          <Icon name="arrow-down" :size="12" />
          <span>{{ t('acp.chat.jumpLatest', 'Jump to latest') }}</span>
        </button>
      </div>

      <div v-if="pendingPermission" class="chat-permission">
        <PermissionCard :request="pendingPermission" />
      </div>

      <ChatComposer
        :session-id="session.sessionId"
        :disabled="composerDisabled"
        :busy="busy"
        :available-commands="availableCommands"
        :seed="composerSeed"
        @send="onSend"
        @cancel="onCancel"
      />
    </template>

    <!-- Stale/restored tab: no runtime session behind this tab id. -->
    <div v-else class="chat-missing">
      <Icon name="robot" :size="28" class="chat-missing-icon" />
      <div class="chat-missing-title">{{ t('acp.chat.noSessionTitle', 'Session not attached') }}</div>
      <div class="chat-missing-hint">
        {{ t('acp.chat.noSessionHint', 'This tab is not connected to an agent session. Start a new session to continue.') }}
      </div>
      <div v-if="!availableAgents.length" class="chat-missing-subhint">
        {{ t('acp.chat.noAgents', 'No agents configured yet — add one in the agent panel.') }}
      </div>

      <div class="chat-missing-actions">
        <select v-if="availableAgents.length" v-model="pickedAgentId" class="chat-agent-select">
          <option v-for="agent in availableAgents" :key="agent.id" :value="agent.id">
            {{ agent.name }}
          </option>
        </select>
        <button
          class="chat-primary-btn"
          type="button"
          :disabled="!pickedAgentId || creating"
          @click="startSession"
        >
          <Icon name="plus" :size="12" />
          <span>{{ creating ? t('acp.chat.creating', 'Starting…') : t('acp.chat.startSession', 'Start session') }}</span>
        </button>
        <button class="chat-secondary-btn" type="button" @click="openAgentsPanel">
          {{ t('acp.chat.openAgents', 'Agent panel') }}
        </button>
      </div>

      <div v-if="createError" class="chat-missing-error">{{ createError }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../ui/Icon.vue'
import ChatMessage from './acp/ChatMessage.vue'
import ToolCallCard from './acp/ToolCallCard.vue'
import PlanCard from './acp/PlanCard.vue'
import PermissionCard from './acp/PermissionCard.vue'
import ChatComposer from './acp/ChatComposer.vue'
import SessionHeader from './acp/SessionHeader.vue'
import { useAcpStore } from '../../stores/acp'
import { useProjectStore } from '../../stores/projects'
import { useLayoutStore } from '../../stores/layout'
import { useTabStore } from '../../stores/tabs'
import type { Tab } from '../../stores/tabs'
import type { AcpAgentConfig, AcpPermissionRequest } from '@shared/acp'

const props = defineProps<{ tab: Tab }>()

const { t } = useI18n()
const acpStore = useAcpStore()
const projectStore = useProjectStore()
const layout = useLayoutStore()
const tabStore = useTabStore()

/** Only stick to the bottom while the user is within this distance of it. */
const STICK_THRESHOLD_PX = 80

const listEl = ref<HTMLElement | null>(null)
const stick = ref(true)
const showJump = ref(false)
const creating = ref(false)
const createError = ref('')
const pickedAgentId = ref('')
const composerSeed = ref<{ text: string; key: number } | null>(null)
let seedCounter = 0

const sessionId = computed(() => props.tab.acpSessionId ?? '')

const session = computed(() => {
  const id = sessionId.value
  if (!id) return null
  return acpStore.sessions[id]?.session ?? null
})

const items = computed(() => {
  const id = sessionId.value
  if (!id) return []
  return acpStore.sessions[id]?.items ?? []
})

const loading = computed(() => {
  const id = sessionId.value
  if (!id) return false
  return acpStore.sessions[id]?.loading ?? false
})

const busy = computed(() => {
  const id = sessionId.value
  if (!id) return false
  return acpStore.sessions[id]?.promptInFlight ?? false
})

const pendingPermission = computed<AcpPermissionRequest | null>(() => {
  const id = sessionId.value
  if (!id) return null
  return acpStore.pendingPermissionFor(id) ?? null
})

const availableCommands = computed(() => session.value?.availableCommands ?? [])

const agentName = computed(() => {
  const current = session.value
  if (!current) return props.tab.title
  return current.agentName || acpStore.configuredAgent(current.agentId)?.name || current.agentId
})

const sessionStatus = computed(() => session.value?.status ?? 'closed')

const composerDisabled = computed(() => loading.value || sessionStatus.value !== 'active')

const sessionStatusNotice = computed(() => {
  if (loading.value) return t('acp.chat.replaying', 'Loading session history…')
  if (sessionStatus.value === 'interrupted') {
    return t('acp.chat.interrupted', 'Session interrupted — send a message to continue')
  }
  if (sessionStatus.value === 'closed') {
    return t('acp.chat.closed', 'Session closed — reconnect the agent to continue')
  }
  return ''
})

const availableAgents = computed<AcpAgentConfig[]>(() =>
  (acpStore.config?.agents ?? []).filter((agent) => agent.enabled !== false)
)

/**
 * Changes whenever new content may have been appended; used to follow the tail
 * while streaming without watching the whole item tree.
 */
const scrollSignal = computed(() => {
  const list = items.value
  const last = list[list.length - 1]
  let tail = 0
  if (last) {
    if (last.kind === 'tool') {
      tail = (last.toolCall.content?.length ?? 0) + (last.toolCall.status ?? '').length
    } else if (last.kind === 'plan') {
      tail = last.entries.length
    } else {
      tail = last.text.length
    }
  }
  return `${list.length}:${tail}:${pendingPermission.value ? 1 : 0}`
})

watch(
  availableAgents,
  (agents) => {
    if (pickedAgentId.value && agents.some((agent) => agent.id === pickedAgentId.value)) return
    const matched = agents.find((agent) => agent.name === props.tab.title)
    pickedAgentId.value = matched?.id ?? agents[0]?.id ?? ''
  },
  { immediate: true }
)

watch(scrollSignal, () => {
  if (stick.value) scrollToBottom()
})

watch(loading, (value) => {
  if (!value && stick.value) scrollToBottom()
})

watch(sessionId, () => {
  stick.value = true
  showJump.value = false
  scrollToBottom()
})

/**
 * 「平滑呈现」动画只改 DOM，不改变 store 里的 items，所以 scrollSignal 不会动。
 * 用 MutationObserver 观察列表内容增长，在吸底状态下继续跟随。
 */
let scrollObserver: MutationObserver | null = null
let scrollFrame = 0

function followContentGrowth(): void {
  if (!stick.value || scrollFrame !== 0) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    if (stick.value) scrollToBottom()
  })
}

onMounted(() => {
  acpStore.init().catch(() => undefined)
  scrollToBottom()
  const el = listEl.value
  if (el) {
    scrollObserver = new MutationObserver(followContentGrowth)
    scrollObserver.observe(el, { childList: true, characterData: true, subtree: true })
  }
})

onUnmounted(() => {
  scrollObserver?.disconnect()
  scrollObserver = null
  if (scrollFrame !== 0) cancelAnimationFrame(scrollFrame)
  scrollFrame = 0
})

onActivated(() => {
  if (stick.value) scrollToBottom()
})

function scrollToBottom(): void {
  void nextTick(() => {
    const el = listEl.value
    if (!el) return
    el.scrollTop = el.scrollHeight
  })
}

function onScroll(): void {
  const el = listEl.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  stick.value = distance < STICK_THRESHOLD_PX
  showJump.value = !stick.value
}

function jumpToLatest(): void {
  stick.value = true
  showJump.value = false
  scrollToBottom()
}

function seedComposer(text: string): void {
  seedCounter += 1
  composerSeed.value = { text, key: seedCounter }
}

function onSend(text: string): void {
  const current = session.value
  if (!current || !text) return
  stick.value = true
  showJump.value = false
  acpStore.sendPrompt(current.sessionId, text).catch(() => undefined)
  scrollToBottom()
}

function onCancel(): void {
  const current = session.value
  if (!current) return
  acpStore.cancelPrompt(current.sessionId).catch(() => undefined)
}

async function startSession(): Promise<void> {
  const agentId = pickedAgentId.value
  if (!agentId || creating.value) return
  creating.value = true
  createError.value = ''
  try {
    const detail = await acpStore.createSession(agentId, projectStore.activeProject?.path)
    if (acpStore.hasChatTab(detail.sessionId)) {
      // createSession opened (or focused) its own chat tab; drop this stale one.
      tabStore.closeTab(props.tab.projectId, props.tab.id).catch(() => undefined)
    } else {
      // No tab could be opened automatically (e.g. no project) — reuse this tab.
      tabStore.updateTab(props.tab.projectId, props.tab.id, {
        acpSessionId: detail.sessionId,
        title: detail.agentName || detail.agentId
      }).catch(() => undefined)
    }
  } catch (error) {
    createError.value = error instanceof Error ? error.message : String(error)
  } finally {
    creating.value = false
  }
}

function openAgentsPanel(): void {
  layout.rightActivePanel = 'acp-agents'
  layout.rightCollapsed = false
  layout.persist()
}
</script>

<style scoped>
.acp-chat {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-primary);
}

.chat-banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
  padding: 5px var(--space-4);
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.chat-banner--warn { color: var(--text-warning); }

.chat-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}

.chat-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) 0 var(--space-3);
}

.chat-jump {
  position: absolute;
  left: 50%;
  bottom: var(--space-3);
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  box-shadow: var(--shadow-1);
  z-index: 10;
}
.chat-jump:hover { color: var(--text-primary); background: var(--bg-hover); }

.chat-permission {
  flex-shrink: 0;
  padding-top: var(--space-1);
}

/* ── empty conversation ── */
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48px var(--space-4) var(--space-2);
  text-align: center;
}
.chat-empty-icon { color: var(--text-faint); opacity: 0.7; }
.chat-empty-title {
  margin-top: var(--space-3);
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--text-primary);
}
.chat-empty-hint {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  color: var(--text-faint);
}

.chat-commands {
  margin-top: var(--space-5);
  width: 100%;
  max-width: 560px;
  text-align: left;
}
.chat-commands-label {
  margin-bottom: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.chat-command-chips {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.chat-command-chip {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  padding: 4px var(--space-2);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  text-align: left;
}
.chat-command-chip:hover { border-color: var(--border-strong); background: var(--bg-hover); }
.chat-command-name {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--text-accent);
}
.chat-command-desc {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── missing session ── */
.chat-missing {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  text-align: center;
}
.chat-missing-icon { color: var(--text-faint); opacity: 0.7; }
.chat-missing-title {
  margin-top: var(--space-3);
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--text-primary);
}
.chat-missing-hint {
  margin-top: var(--space-1);
  max-width: 420px;
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--text-faint);
}
.chat-missing-subhint {
  margin-top: var(--space-2);
  max-width: 420px;
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.chat-missing-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.chat-missing-error {
  margin-top: var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-danger);
}

.chat-agent-select {
  height: 26px;
  max-width: 200px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.chat-primary-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--text-accent);
  color: var(--text-on-accent);
  font-size: var(--text-sm);
}
.chat-primary-btn:hover:not(:disabled) { filter: brightness(1.08); background: var(--text-accent); }

.chat-secondary-btn {
  height: 26px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
.chat-secondary-btn:hover { border-color: var(--border-strong); color: var(--text-primary); }

.spin { animation: spin 1.1s linear infinite; }
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
