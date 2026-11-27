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

    <div
      class="composer-box"
      :class="{ 'is-dragover': dragOver }"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <!-- Pending image attachments -->
      <div v-if="images.length > 0" class="composer-images">
        <div v-for="(img, idx) in images" :key="idx" class="composer-image-chip">
          <img :src="`data:${img.mimeType};base64,${img.data}`" :alt="img.name || 'image'" class="composer-image-thumb" />
          <button
            type="button"
            class="composer-image-remove"
            :title="t('common.remove', 'Remove')"
            @click="removeImage(idx)"
           :aria-label="t('common.remove', 'Remove')">
            <Icon name="x" :size="10" />
          </button>
        </div>
      </div>

      <textarea
        ref="inputEl"
        v-model="text"
        class="composer-input"
        rows="1"
        :placeholder="placeholderText"
        :disabled="disabled"
        @keydown="onKeydown"
        @input="resize"
        @paste="onPaste"
      />
      <div class="composer-bar">
        <input
          ref="fileInputEl"
          type="file"
          accept="image/*"
          multiple
          class="composer-file-input"
          @change="onFileSelect"
        />
        <button
          class="composer-attach"
          type="button"
          :disabled="disabled || busy"
          :title="t('acp.composer.attachImage', 'Attach image')"
          @click="fileInputEl?.click()"
         :aria-label="t('acp.composer.attachImage', 'Attach image')">
          <Icon name="plus" :size="13" />
        </button>
        <span class="composer-hint">{{ hintText }}</span>
        <button
          v-if="busy"
          class="composer-stop"
          type="button"
          :title="t('acp.composer.stop', 'Stop')"
          @click="emit('cancel')"
         :aria-label="t('acp.composer.stop', 'Stop')">
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
         :aria-label="t('acp.composer.send', 'Send')">
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

export interface ComposerImage {
  data: string
  mimeType: string
  name?: string
}

const emit = defineEmits<{ send: [payload: { text: string; images: ComposerImage[] }]; cancel: [] }>()

const { t } = useI18n()

const MAX_TEXTAREA_HEIGHT = 160
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const inputEl = ref<HTMLTextAreaElement | null>(null)
const fileInputEl = ref<HTMLInputElement | null>(null)
const text = ref('')
const images = ref<ComposerImage[]>([])
const dragOver = ref(false)
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

const canSend = computed(
  () => !props.disabled && !props.busy && (text.value.trim().length > 0 || images.value.length > 0)
)

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

function readFileAsImage(file: File): Promise<ComposerImage | null> {
  if (!file.type.startsWith('image/') || file.size > MAX_IMAGE_BYTES) return Promise.resolve(null)
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma < 0) {
        resolve(null)
        return
      }
      resolve({
        data: result.slice(comma + 1),
        mimeType: file.type || 'image/png',
        name: file.name
      })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

async function addImageFiles(files: FileList | File[]): Promise<void> {
  for (const file of Array.from(files)) {
    const img = await readFileAsImage(file)
    if (img) images.value.push(img)
  }
}

function removeImage(index: number): void {
  images.value.splice(index, 1)
}

function onPaste(event: ClipboardEvent): void {
  const items = event.clipboardData?.items
  if (!items) return
  const imageFiles: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) imageFiles.push(f)
    }
  }
  if (imageFiles.length > 0) {
    event.preventDefault()
    void addImageFiles(imageFiles)
  }
}

function onDrop(event: DragEvent): void {
  dragOver.value = false
  if (props.disabled || props.busy) return
  const files = event.dataTransfer?.files
  if (files?.length) void addImageFiles(files)
}

function onFileSelect(event: Event): void {
  const input = event.target as HTMLInputElement
  if (input.files?.length) {
    void addImageFiles(input.files)
    input.value = ''
  }
}

function submit(): void {
  if (!canSend.value) return
  const value = text.value.trim()
  const attachedImages = [...images.value]
  if (!value && attachedImages.length === 0) return
  emit('send', { text: value, images: attachedImages })
  text.value = ''
  images.value = []
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
  padding: var(--space-3) var(--space-5) var(--space-4);
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-primary);
}

.composer-box {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-2);
  transition: border-color var(--transition-fast) ease, box-shadow var(--transition-fast) ease;
}
.composer-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.composer-box.is-dragover {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.composer-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px var(--space-4) 0;
}
.composer-image-chip {
  position: relative;
  width: 52px;
  height: 52px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}
.composer-image-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.composer-image-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.composer-file-input { display: none; }
.composer-attach {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
}
.composer-attach:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.composer-attach:disabled { opacity: 0.4; }
.composer.is-disabled .composer-box { opacity: 0.6; }

.composer-input {
  width: 100%;
  min-height: 44px;
  max-height: 220px;
  padding: 10px var(--space-4) 2px;
  border: none;
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-lg);
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
  padding: 6px var(--space-2) 6px var(--space-4);
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
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: var(--radius-sm);
  color: var(--accent-strong);
}
.composer-send:hover:not(:disabled) { background: var(--bg-hover); }
.composer-send:disabled { color: var(--text-faint); }

.composer-stop {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 var(--space-3);
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
  max-height: 260px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-panel);
}
.slash-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  text-align: left;
}
.slash-item.is-active { background: var(--bg-selected); }
.slash-name {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--accent-strong);
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
