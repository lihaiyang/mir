<template>
  <div class="composer" :class="{ 'is-disabled': disabled }">
    <!-- Slash command picker -->
    <div v-if="popupOpen" class="slash-popup" role="listbox">
      <button
        v-for="(command, index) in filteredCommands"
        :key="command.name"
        class="slash-item"
        :class="{ 'is-active': index === activeIndex }"
        type="button"
        role="option"
        :aria-selected="index === activeIndex"
        @mousedown.prevent="pickCommand(command)"
        @mouseenter="activeIndex = index"
      >
        <span class="slash-name">/{{ command.name }}</span>
        <span class="slash-desc">{{ command.description }}</span>
      </button>
    </div>

    <div class="composer-box">
      <textarea
        ref="inputEl"
        v-model="text"
        class="composer-input"
        rows="1"
        :placeholder="placeholderText"
        :disabled="disabled"
        @keydown="onKeydown"
        @input="resize"
      />
      <div class="composer-bar">
        <span class="composer-hint">{{ hintText }}</span>
        <button
          v-if="busy"
          class="composer-stop"
          type="button"
          :title="t('acp.composer.stop', 'Stop')"
          @click="emit('cancel')"
        >
          <Icon name="x" :size="12" />
          <span>{{ t('acp.composer.stop', 'Stop') }}</span>
        </button>
        <button
          v-else
          class="composer-send"
          type="button"
          :disabled="!canSend"
          :title="t('acp.composer.send', 'Send')"
          @click="submit"
        >
          <Icon name="send" :size="13" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../../ui/Icon.vue'
import type { AvailableCommand } from '@shared/acp'

const props = withDefaults(
  defineProps<{
    sessionId?: string
    disabled?: boolean
    busy?: boolean
    availableCommands?: AvailableCommand[]
    placeholder?: string
    /** Lets the parent push text (e.g. a slash-command chip) into the composer. */
    seed?: { text: string; key: number } | null
  }>(),
  {
    sessionId: '',
    disabled: false,
    busy: false,
    availableCommands: () => [],
    placeholder: '',
    seed: null
  }
)

const emit = defineEmits<{ send: [text: string]; cancel: [] }>()

const { t } = useI18n()

const MAX_TEXTAREA_HEIGHT = 160

const inputEl = ref<HTMLTextAreaElement | null>(null)
const text = ref('')
const activeIndex = ref(0)
const dismissed = ref(false)

const placeholderText = computed(
  () => props.placeholder || t('acp.composer.placeholder', 'Ask the agent…')
)

const hintText = computed(() =>
  props.busy
    ? t('acp.composer.busyHint', 'Agent is working…')
    : t('acp.composer.hint', 'Enter to send · Shift+Enter for newline')
)

const canSend = computed(() => !props.disabled && !props.busy && text.value.trim().length > 0)

/** Current `/xxx` query while the user is typing a command name. */
const commandQuery = computed<string | null>(() => {
  const value = text.value
  if (!value.startsWith('/') || value.includes('\n')) return null
  const query = value.slice(1)
  if (query.includes(' ')) return null
  return query.toLowerCase()
})

const filteredCommands = computed<AvailableCommand[]>(() => {
  const query = commandQuery.value
  if (query === null || !props.availableCommands.length) return []
  return props.availableCommands
    .filter((command) => command.name.toLowerCase().includes(query))
    .slice(0, 8)
})

const popupOpen = computed(() => !dismissed.value && filteredCommands.value.length > 0)

watch(text, () => {
  dismissed.value = false
})

watch(commandQuery, () => {
  activeIndex.value = 0
})

watch(
  () => props.seed,
  (seed) => {
    if (!seed) return
    text.value = seed.text
    void nextTick(() => {
      resize()
      focusInput()
    })
  },
  { deep: false }
)

onMounted(() => {
  resize()
  focusInput()
})

function focusInput(): void {
  inputEl.value?.focus()
}

function resize(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden'
}

function submit(): void {
  if (!canSend.value) return
  const value = text.value.trim()
  if (!value) return
  emit('send', value)
  text.value = ''
  dismissed.value = true
  void nextTick(() => {
    resize()
    focusInput()
  })
}

function pickCommand(command: AvailableCommand): void {
  text.value = `/${command.name} `
  dismissed.value = true
  void nextTick(() => {
    resize()
    focusInput()
  })
}

function onKeydown(event: KeyboardEvent): void {
  if (popupOpen.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      activeIndex.value = (activeIndex.value + 1) % filteredCommands.value.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const length = filteredCommands.value.length
      activeIndex.value = (activeIndex.value - 1 + length) % length
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      dismissed.value = true
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      const command = filteredCommands.value[activeIndex.value]
      if (command) pickCommand(command)
      return
    }
  }

  // Never submit while an IME composition session is committing.
  if (event.isComposing) return

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
}
</script>

<style scoped>
.composer {
  position: relative;
  flex-shrink: 0;
  padding: var(--space-2) var(--space-4) var(--space-3);
  border-top: 1px solid var(--border-color);
  background: var(--bg-primary);
}

.composer-box {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  transition: border-color var(--transition-fast) ease, box-shadow var(--transition-fast) ease;
}
.composer-box:focus-within {
  border-color: var(--text-accent);
  box-shadow: var(--focus-ring);
}
.composer.is-disabled .composer-box { opacity: 0.6; }

.composer-input {
  width: 100%;
  min-height: 30px;
  max-height: 160px;
  padding: var(--space-2) var(--space-3) 0;
  border: none;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: var(--text-md);
  line-height: 1.5;
  resize: none;
  overflow-y: hidden;
}
.composer-input:focus {
  border: none;
  box-shadow: none;
}
.composer-input::placeholder { color: var(--text-faint); }

.composer-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 2px var(--space-2) 2px var(--space-3);
}
.composer-hint {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: var(--radius-sm);
  color: var(--text-accent);
}
.composer-send:hover:not(:disabled) { background: var(--bg-hover); }
.composer-send:disabled { color: var(--text-faint); }

.composer-stop {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--text-danger);
}
.composer-stop:hover { background: var(--bg-hover); }

/* slash command popup */
.slash-popup {
  position: absolute;
  left: var(--space-4);
  right: var(--space-4);
  bottom: calc(100% - var(--space-1));
  z-index: 20;
  max-height: 220px;
  overflow-y: auto;
  padding: var(--space-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  box-shadow: var(--shadow-2);
}
.slash-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  padding: 5px var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
}
.slash-item.is-active { background: var(--bg-selected); }
.slash-name {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--text-accent);
}
.slash-desc {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
