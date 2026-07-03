<template>
  <Teleport to="body">
    <div class="sbp-overlay" @mousedown.self="close">
      <div
        ref="pickerEl"
        class="sbp-modal"
        :style="modalStyle"
      >
        <input
          v-if="filterable"
          ref="inputEl"
          v-model="query"
          class="sbp-input"
          :placeholder="placeholder"
          @keydown.escape.prevent="close"
          @keydown.arrow-down.prevent="move(1)"
          @keydown.arrow-up.prevent="move(-1)"
          @keydown.enter.prevent="selectSelected"
        />
        <div class="sbp-list" ref="listEl">
          <template v-for="(group, gIdx) in groupedItems" :key="group.name">
            <div v-if="group.name" class="sbp-group">{{ group.name }}</div>
            <div
              v-for="(item, idx) in group.items"
              :key="item.value"
              class="sbp-item"
              :class="{ active: globalIndex(gIdx, idx) === selectedIdx }"
              @mouseenter="selectedIdx = globalIndex(gIdx, idx)"
              @mousedown.prevent="selectItem(item)"
            >
              <span class="sbp-label">{{ item.label }}</span>
              <span v-if="item.value === currentValue" class="sbp-check">✓</span>
            </div>
          </template>
          <div v-if="flatItems.length === 0" class="sbp-empty">No results</div>
        </div>
        <div v-if="$slots.footer" class="sbp-footer">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'

export interface PickerItem {
  value: string
  label: string
  group?: string
}

const props = defineProps<{
  items: PickerItem[]
  target: HTMLElement
  currentValue?: string
  filterable?: boolean
  placeholder?: string
}>()

const emit = defineEmits<{
  (e: 'select', value: string): void
  (e: 'close'): void
}>()

const pickerEl = ref<HTMLDivElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLDivElement | null>(null)
const query = ref('')
const selectedIdx = ref(0)
const modalStyle = ref({ left: '0px', top: '0px' })

const flatItems = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.items
  return props.items.filter(i => i.label.toLowerCase().includes(q) || i.value.toLowerCase().includes(q))
})

const groupedItems = computed(() => {
  const map = new Map<string, PickerItem[]>()
  for (const item of flatItems.value) {
    const g = item.group || ''
    if (!map.has(g)) map.set(g, [])
    map.get(g)!.push(item)
  }
  const result: { name: string; items: PickerItem[] }[] = []
  for (const [name, items] of map) {
    result.push({ name, items })
  }
  return result
})

function globalIndex(groupIdx: number, itemIdx: number): number {
  let count = 0
  for (let i = 0; i < groupIdx; i++) {
    count += groupedItems.value[i].items.length
  }
  return count + itemIdx
}

function move(delta: number) {
  const len = flatItems.value.length
  if (!len) return
  selectedIdx.value = (selectedIdx.value + delta + len) % len
  scrollSelectedIntoView()
}

function scrollSelectedIntoView() {
  nextTick(() => {
    const list = listEl.value
    if (!list) return
    const active = list.querySelector('.sbp-item.active') as HTMLElement | null
    if (active) {
      active.scrollIntoView({ block: 'nearest' })
    }
  })
}

function selectSelected() {
  const item = flatItems.value[selectedIdx.value]
  if (item) selectItem(item)
}

function selectItem(item: PickerItem) {
  emit('select', item.value)
}

function close() {
  emit('close')
}

function updatePosition() {
  const rect = props.target.getBoundingClientRect()
  const pickerHeight = pickerEl.value?.offsetHeight ?? 240
  const margin = 4
  let top = rect.bottom + margin
  if (top + pickerHeight > window.innerHeight) {
    top = rect.top - pickerHeight - margin
  }
  modalStyle.value = {
    left: rect.left + 'px',
    top: top + 'px'
  }
}

function handleKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

onMounted(() => {
  nextTick(() => {
    updatePosition()
    inputEl.value?.focus()
    // Select current value if exists
    const idx = flatItems.value.findIndex(i => i.value === props.currentValue)
    if (idx >= 0) selectedIdx.value = idx
  })
  window.addEventListener('keydown', handleKey)
  window.addEventListener('resize', updatePosition)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKey)
  window.removeEventListener('resize', updatePosition)
})
</script>

<style scoped>
.sbp-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.sbp-modal {
  position: fixed;
  width: 240px;
  max-height: 320px;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.sbp-input {
  width: 100%;
  padding: 8px 10px;
  font-size: 12px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-color);
  color: var(--text-primary);
  outline: none;
}

.sbp-input::placeholder {
  color: var(--text-secondary);
}

.sbp-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.sbp-group {
  padding: 4px 10px;
  font-size: 10px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.sbp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  gap: 8px;
}

.sbp-item:hover,
.sbp-item.active {
  background: var(--bg-active);
  color: #fff;
}

.sbp-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sbp-check {
  font-size: 11px;
  flex-shrink: 0;
}

.sbp-empty {
  padding: 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
}

.sbp-footer {
  padding: 8px 10px;
  border-top: 1px solid var(--border-color);
}
</style>
