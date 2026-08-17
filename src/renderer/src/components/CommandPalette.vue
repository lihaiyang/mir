<template>
  <div class="cp-overlay" @mousedown.self="$emit('close')">
    <div class="cp-modal">
      <input
        ref="inputEl"
        v-model="query"
        class="cp-input"
        :placeholder="$t('commandPalette.placeholder')"
        @keydown.escape="$emit('close')"
        @keydown.arrow-down.prevent="move(1)"
        @keydown.arrow-up.prevent="move(-1)"
        @keydown.enter.prevent="runSelected"
      />
      <div class="cp-list">
        <template v-for="(group, gIdx) in grouped" :key="group.name">
          <div v-if="group.name" class="cp-group">{{ group.name }}</div>
          <div
            v-for="(cmd, idx) in group.items"
            :key="cmd.id"
            class="cp-item"
            :class="{ active: globalIndex(gIdx, idx) === selectedIdx }"
            @mouseenter="selectedIdx = globalIndex(gIdx, idx)"
            @mousedown.prevent="runItem(cmd)"
          >
            <span class="cp-item-icon"><Icon v-if="cmd.icon" :name="cmd.icon" :size="14" /></span>
            <span class="cp-item-label"><Highlighted :text="cmd.label" :query="query" /></span>
            <span v-if="cmd.keybinding" class="cp-item-kbd">{{ cmd.keybinding }}</span>
          </div>
        </template>
        <div v-if="filtered.length === 0" class="cp-empty">
          {{ $t('commandPalette.noResults') }}
        </div>
      </div>
      <div class="cp-footer">
        <span class="cp-footer-hint"><kbd>↑↓</kbd> {{ $t('commandPalette.navigate') }}</span>
        <span class="cp-footer-hint"><kbd>↵</kbd> {{ $t('commandPalette.select') }}</span>
        <span class="cp-footer-hint"><kbd>esc</kbd> {{ $t('commandPalette.close') }}</span>
        <span v-if="filtered.length" class="cp-footer-count">{{ filtered.length }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { getRegistry, type PaletteCommand } from '../composables/useCommandPalette'
import { fuzzySort, fuzzyMatchIndices } from '../utils/fuzzy'
import Icon from './ui/Icon.vue'

const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()

const inputEl = ref<HTMLInputElement | null>(null)
const query = ref('')
const selectedIdx = ref(0)

const filtered = computed<PaletteCommand[]>(() => {
  const q = query.value.trim()
  if (!q) return [...getRegistry()]
  return fuzzySort(q, getRegistry(), c => c.label)
})

interface CmdGroup {
  name: string
  items: PaletteCommand[]
}

const grouped = computed<CmdGroup[]>(() => {
  const list = filtered.value
  if (list.length === 0) return []
  const groups = new Map<string, PaletteCommand[]>()
  for (const cmd of list) {
    const g = cmd.group || ''
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(cmd)
  }
  return Array.from(groups.entries()).map(([name, items]) => ({ name, items }))
})

function globalIndex(gIdx: number, idx: number): number {
  let offset = 0
  for (let i = 0; i < gIdx; i++) offset += grouped.value[i].items.length
  return offset + idx
}

// Render the label with matched characters wrapped in a highlight span.
const Highlighted = (props: { text: string; query: string }) => {
  const { text, query: q } = props
  const indices = q.trim() ? fuzzyMatchIndices(q.trim(), text) : []
  if (indices.length === 0) return h('span', {}, text)
  const nodes: any[] = []
  let last = 0
  for (const i of indices) {
    if (i > last) nodes.push(h('span', {}, text.slice(last, i)))
    nodes.push(h('span', { class: 'cp-match' }, text[i]))
    last = i + 1
  }
  if (last < text.length) nodes.push(h('span', {}, text.slice(last)))
  return h('span', {}, nodes)
}

watch(query, () => { selectedIdx.value = 0 })
watch(filtered, () => {
  if (selectedIdx.value >= filtered.value.length) selectedIdx.value = 0
})

onMounted(() => nextTick(() => inputEl.value?.focus()))

function move(delta: number) {
  const len = filtered.value.length
  if (!len) return
  selectedIdx.value = (selectedIdx.value + delta + len) % len
}

function runSelected() {
  const cmd = filtered.value[selectedIdx.value]
  if (cmd) runItem(cmd)
}

function runItem(cmd: PaletteCommand) {
  emit('close')
  nextTick(() => cmd.run())
}
</script>

<style scoped>
.cp-overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
  background: var(--overlay);
  display: flex;
  justify-content: center;
  padding-top: 12vh;
  animation: overlay-in var(--transition-base) ease;
}

.cp-modal {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-3);
  width: 560px;
  max-height: 440px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  align-self: flex-start;
  animation: cp-in var(--transition-base) var(--ease-out);
}
@keyframes cp-in {
  from { opacity: 0; transform: translateY(-8px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.cp-input {
  width: 100%;
  padding: 12px 16px;
  font-size: 14px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: 0;
  outline: none;
  box-shadow: none;
}
.cp-input:focus { box-shadow: none; }
.cp-input::placeholder { color: var(--text-secondary); }

.cp-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.cp-group {
  padding: 8px 16px 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-faint);
}

.cp-item {
  display: flex;
  align-items: center;
  padding: 7px 16px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  gap: 10px;
}
.cp-item:hover {
  background: var(--bg-hover);
}
.cp-item.active {
  background: var(--bg-active);
  color: #fff;
}
.cp-item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.cp-item.active .cp-item-icon { color: rgba(255,255,255,0.8); }

.cp-item-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.cp-match {
  color: var(--text-warning);
  font-weight: 600;
}
.cp-item.active .cp-match { color: #fff; text-decoration: underline; }

.cp-item-kbd {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 1px 5px;
  white-space: nowrap;
  flex-shrink: 0;
}
.cp-item.active .cp-item-kbd {
  color: rgba(255,255,255,0.7);
  background: rgba(255,255,255,0.1);
  border-color: rgba(255,255,255,0.2);
}

.cp-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
}

.cp-footer {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 16px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-secondary);
}
.cp-footer-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-faint);
}
.cp-footer-hint kbd {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 0 4px;
}
.cp-footer-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-faint);
}
</style>
