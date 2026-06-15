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
        <div
          v-for="(cmd, idx) in filtered"
          :key="cmd.id"
          class="cp-item"
          :class="{ active: idx === selectedIdx }"
          @mouseenter="selectedIdx = idx"
          @mousedown.prevent="runItem(cmd)"
        >
          <span class="cp-item-label">{{ cmd.label }}</span>
          <span v-if="cmd.keybinding" class="cp-item-kbd">{{ cmd.keybinding }}</span>
        </div>
        <div v-if="filtered.length === 0" class="cp-empty">
          {{ $t('commandPalette.noResults') }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { getRegistry } from '../composables/useCommandPalette'

const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()

const inputEl = ref<HTMLInputElement | null>(null)
const query = ref('')
const selectedIdx = ref(0)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = q
    ? getRegistry().filter(c => c.label.toLowerCase().includes(q))
    : [...getRegistry()]
  return list
})

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
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: center;
  padding-top: 80px;
}

.cp-modal {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  width: 520px;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
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
}
.cp-input::placeholder { color: var(--text-secondary); }

.cp-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.cp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  gap: 12px;
}
.cp-item:hover,
.cp-item.active {
  background: var(--bg-active);
  color: #fff;
}

.cp-item-label { flex: 1; }

.cp-item-kbd {
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
  padding: 16px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
}
</style>
