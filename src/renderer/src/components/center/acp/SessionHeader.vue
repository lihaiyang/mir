<template>
  <header class="session-header">
    <div class="header-main">
      <span class="status-dot" :class="`status-dot--${statusTone}`" :title="statusLabel" />
      <span class="agent-name" :title="agentName">{{ agentName }}</span>
      <span v-if="cwdName" class="cwd" :title="session.cwd">{{ cwdName }}</span>
      <span class="spacer" />

      <span v-if="usageText" class="usage" :title="usageTitle">
        <Icon name="activity" :size="11" />
        <span class="usage-value">{{ usageText }}</span>
      </span>

      <button
        v-if="busy"
        class="icon-btn"
        type="button"
        :title="t('acp.header.stop', 'Stop')"
        @click="emit('cancel')"
      >
        <Icon name="x" :size="14" />
      </button>
      <button
        class="icon-btn"
        type="button"
        :title="t('acp.header.openPanel', 'Open agent panel')"
        @click="openAgentsPanel"
      >
        <Icon name="panel-right" :size="14" />
      </button>
      <button
        class="icon-btn"
        type="button"
        :title="t('acp.header.disconnect', 'Disconnect agent')"
        @click="disconnect"
      >
        <Icon name="x-circle" :size="14" />
      </button>
    </div>

    <div v-if="hasControls" class="header-controls">
      <label v-if="modeChoices.length" class="control">
        <span class="control-label">{{ t('acp.header.mode', 'Mode') }}</span>
        <select class="control-select" :value="currentModeId" @change="onModeChange">
          <option v-for="mode in modeChoices" :key="mode.id" :value="mode.id">
            {{ mode.name }}
          </option>
        </select>
      </label>

      <label v-if="modelOption" class="control">
        <span class="control-label">{{ t('acp.header.model', 'Model') }}</span>
        <select
          class="control-select control-select--model"
          :value="modelOption.currentValue"
          :title="modelTitle"
          @change="onConfigSelect(modelOption.id, $event)"
        >
          <option v-for="choice in modelChoices" :key="choice.value" :value="choice.value">
            {{ choice.name }}
          </option>
        </select>
      </label>

      <label v-for="option in thoughtOptions" :key="option.id" class="control">
        <span class="control-label">{{ option.name }}</span>
        <select class="control-select" :value="option.currentValue" @change="onConfigSelect(option.id, $event)">
          <option v-for="choice in choicesOf(option)" :key="choice.value" :value="choice.value">
            {{ choice.name }}
          </option>
        </select>
      </label>

      <div v-if="otherControls.length" class="more-wrap">
        <button
          class="icon-btn"
          type="button"
          :title="t('acp.header.more', 'More options')"
          @click="moreOpen = !moreOpen"
        >
          <Icon name="more" :size="14" />
        </button>
        <div v-if="moreOpen" class="more-popover">
          <div v-for="option in otherControls" :key="option.id" class="more-row">
            <span class="more-label" :title="option.description ?? undefined">{{ option.name }}</span>
            <select
              v-if="option.type === 'select'"
              class="more-select"
              :value="option.currentValue"
              @change="onConfigSelect(option.id, $event)"
            >
              <option v-for="choice in option.choices" :key="choice.value" :value="choice.value">
                {{ choice.name }}
              </option>
            </select>
            <input
              v-else
              class="more-checkbox"
              type="checkbox"
              :checked="option.currentValue"
              @change="onConfigBoolean(option.id, $event)"
            />
          </div>
        </div>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../../ui/Icon.vue'
import { useAcpStore } from '../../../stores/acp'
import { useLayoutStore } from '../../../stores/layout'
import type { AcpSessionDetail, SessionConfigOption } from '@shared/acp'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>
type StatusTone = 'ready' | 'active' | 'error' | 'idle' | 'closed'
type SelectChoice = { value: string; name: string; group?: string }

/** Flattened select/boolean config options for the "⋯" popover. */
type OtherControl =
  | { id: string; name: string; description: string | null; type: 'select'; currentValue: string; choices: SelectChoice[] }
  | { id: string; name: string; description: string | null; type: 'boolean'; currentValue: boolean }

const props = defineProps<{ session: AcpSessionDetail; agentName: string; busy: boolean }>()

const emit = defineEmits<{ cancel: [] }>()

const { t } = useI18n()
const acpStore = useAcpStore()
const layout = useLayoutStore()

const numberFormat = new Intl.NumberFormat()
const moreOpen = ref(false)

const agentName = computed(() => props.agentName || t('acp.header.unknownAgent', 'Agent'))

const runtimeStatus = computed(() => {
  if (props.session.status === 'closed') return 'closed'
  return acpStore.runtimeFor(props.session.agentId)?.status ?? 'idle'
})

const statusTone = computed<StatusTone>(() => {
  switch (runtimeStatus.value) {
    case 'ready':
      return 'ready'
    case 'starting':
      return 'active'
    case 'error':
      return 'error'
    case 'closed':
      return 'closed'
    default:
      return 'idle'
  }
})

const statusLabel = computed(() => {
  switch (runtimeStatus.value) {
    case 'ready':
      return t('acp.header.status.ready', 'Connected')
    case 'starting':
      return t('acp.header.status.starting', 'Starting')
    case 'error':
      return t('acp.header.status.error', 'Error')
    case 'closed':
      return t('acp.header.status.closed', 'Disconnected')
    default:
      return t('acp.header.status.idle', 'Idle')
  }
})

const cwdName = computed(() => basename(props.session.cwd))

const usageText = computed(() => {
  const usage = props.session.usage
  if (!usage || (!usage.used && !usage.size)) return ''
  return `${numberFormat.format(usage.used)}/${numberFormat.format(usage.size)}`
})

const usageTitle = computed(() => {
  const usage = props.session.usage
  if (!usage) return ''
  const base = t('acp.header.usageTitle', '{used} / {size} tokens', {
    named: { used: numberFormat.format(usage.used), size: numberFormat.format(usage.size) }
  })
  if (!usage.cost) return base
  return `${base} · ${usage.cost.amount.toFixed(2)} ${usage.cost.currency}`
})

const modeChoices = computed(() => props.session.modes?.availableModes ?? [])
const currentModeId = computed(() => props.session.modes?.currentModeId ?? '')

const configOptions = computed<SessionConfigOption[]>(() => props.session.configOptions ?? [])

const selectOptions = computed<SelectOption[]>(() =>
  configOptions.value.filter((option) => option.type === 'select')
)

const modelOption = computed<SelectOption | undefined>(() =>
  selectOptions.value.find((option) => option.category === 'model')
)
const modelChoices = computed<SelectChoice[]>(() => (modelOption.value ? choicesOf(modelOption.value) : []))
/** 完整模型名（含 id / 提供商）——下拉宽度有限，悬停时用 title 显示全称 */
const modelTitle = computed(() => {
  const current = modelOption.value?.currentValue
  return modelChoices.value.find((choice) => choice.value === current)?.name ?? current ?? ''
})

const thoughtOptions = computed<SelectOption[]>(() =>
  selectOptions.value.filter((option) => option.category === 'thought_level')
)

const otherControls = computed<OtherControl[]>(() =>
  configOptions.value
    .filter((option) => option.category !== 'model' && option.category !== 'thought_level')
    .map((option): OtherControl => {
      if (option.type === 'select') {
        return {
          id: option.id,
          name: option.name,
          description: option.description ?? null,
          type: 'select',
          currentValue: option.currentValue,
          choices: choicesOf(option)
        }
      }
      return {
        id: option.id,
        name: option.name,
        description: option.description ?? null,
        type: 'boolean',
        currentValue: option.currentValue
      }
    })
)

const hasControls = computed(
  () => modeChoices.value.length > 0 || configOptions.value.length > 0
)

function basename(path: string | null | undefined): string {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

function choicesOf(option: SelectOption): SelectChoice[] {
  const choices: SelectChoice[] = []
  for (const entry of option.options) {
    if ('group' in entry) {
      for (const item of entry.options) {
        choices.push({ value: item.value, name: item.name, group: entry.group })
      }
    } else {
      choices.push({ value: entry.value, name: entry.name })
    }
  }
  return choices
}

function onModeChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (!value) return
  acpStore.setMode(props.session.sessionId, value).catch(() => undefined)
}

function onConfigSelect(configId: string, event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  acpStore
    .setConfigOption(props.session.sessionId, configId, value)
    .catch(() => undefined)
}

function onConfigBoolean(configId: string, event: Event): void {
  const value = (event.target as HTMLInputElement).checked
  acpStore
    .setConfigOption(props.session.sessionId, configId, value)
    .catch(() => undefined)
}

function disconnect(): void {
  acpStore.disconnectAgent(props.session.agentId).catch(() => undefined)
}

function openAgentsPanel(): void {
  layout.rightActivePanel = 'acp-agents'
  layout.rightCollapsed = false
  layout.persist()
}
</script>

<style scoped>
.session-header {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-primary);
  user-select: none;
}

.header-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 32px;
  padding: 0 var(--space-3);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-faint);
}
.status-dot--ready { background: var(--text-success); }
.status-dot--active {
  background: var(--text-accent);
  animation: pulse 1.2s ease-in-out infinite;
}
.status-dot--error { background: var(--text-danger); }
.status-dot--closed { background: var(--text-faint); opacity: 0.6; }
@keyframes pulse {
  50% { opacity: 0.35; }
}

.agent-name {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}

.cwd {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-faint);
  padding: 1px 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}

.spacer { flex: 1; }

.usage {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-faint);
}

.header-controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3) var(--space-2);
  flex-wrap: wrap;
}

.control {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.control-label {
  font-size: var(--text-xs);
  color: var(--text-faint);
  white-space: nowrap;
}
.control-select {
  height: 22px;
  max-width: 190px;
  padding: 0 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.control-select--model {
  max-width: 340px;
}

.control-select:hover { border-color: var(--border-strong); }

.more-wrap { position: relative; }
.more-popover {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 30;
  min-width: 240px;
  max-height: 320px;
  overflow-y: auto;
  padding: var(--space-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  box-shadow: var(--shadow-2);
}
.more-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 3px 0;
}
.more-row + .more-row { border-top: 1px solid var(--border-color); padding-top: 5px; }
.more-label {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.more-select {
  height: 22px;
  max-width: 140px;
  padding: 0 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.more-checkbox { accent-color: var(--text-accent); }
</style>
