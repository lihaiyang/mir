<template>
  <div class="qo-overlay" @mousedown.self="$emit('close')">
    <div class="qo-modal">
      <input
        ref="inputEl"
        v-model="query"
        class="qo-input"
        :placeholder="$t('quickOpen.placeholder')"
        @keydown.escape="$emit('close')"
        @keydown.arrow-down.prevent="move(1)"
        @keydown.arrow-up.prevent="move(-1)"
        @keydown.enter.prevent="openSelected"
      />
      <div class="qo-list">
        <div
          v-for="(item, idx) in filtered"
          :key="item.path"
          class="qo-item"
          :class="{ active: idx === selectedIdx, recent: item.isRecent }"
          @mouseenter="selectedIdx = idx"
          @mousedown.prevent="openItem(item)"
        >
          <span class="qo-icon">{{ item.icon }}</span>
          <span class="qo-name">{{ item.name }}</span>
          <span class="qo-path">{{ item.dirPath }}</span>
          <span v-if="item.isRecent" class="qo-recent-badge">{{ $t('quickOpen.recent') }}</span>
        </div>
        <div v-if="filtered.length === 0" class="qo-empty">
          {{ $t('quickOpen.noResults') }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProjectStore } from '../stores/projects'
import { useRecentStore } from '../stores/recent'
import { fuzzySort } from '../utils/fuzzy'
import { fileIcon } from '../constants'

const emit = defineEmits<{ (e: 'close'): void; (e: 'open', path: string): void }>()

const { t } = useI18n()
const projectStore = useProjectStore()
const recentStore = useRecentStore()

const inputEl = ref<HTMLInputElement | null>(null)
const query = ref('')
const selectedIdx = ref(0)
const allFiles = ref<{ path: string; name: string; dirPath: string; icon: string }[]>([])

interface QuickOpenItem {
  path: string
  name: string
  dirPath: string
  icon: string
  isRecent: boolean
}

const recentPaths = computed(() => {
  const set = new Set<string>()
  const pid = projectStore.activeProject?.id
  if (!pid) return set
  for (const f of recentStore.recentFiles) {
    if (f.projectId === pid) set.add(f.path)
  }
  return set
})

const filtered = computed<QuickOpenItem[]>(() => {
  const q = query.value.trim()
  const recent = recentPaths.value
  const items = allFiles.value.map(f => ({
    ...f,
    isRecent: recent.has(f.path),
  }))
  if (!q) {
    return items.sort((a, b) => {
      if (a.isRecent && !b.isRecent) return -1
      if (!a.isRecent && b.isRecent) return 1
      return a.name.localeCompare(b.name)
    })
  }
  return fuzzySort(q, items, i => i.name + ' ' + i.path)
})

watch(query, () => { selectedIdx.value = 0 })
watch(filtered, () => {
  if (selectedIdx.value >= filtered.value.length) selectedIdx.value = 0
})

onMounted(async () => {
  nextTick(() => inputEl.value?.focus())
  await loadFiles()
})

async function loadFiles() {
  const project = projectStore.activeProject
  if (!project) return
  const files: typeof allFiles.value = []
  await walkDir(project.path, project.path, files)
  allFiles.value = files
}

async function walkDir(root: string, dir: string, out: { path: string; name: string; dirPath: string; icon: string }[]) {
  const entries = await window.electronAPI.readdir(dir)
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (['node_modules', 'dist', 'out', '.cache', '__pycache__', '.next', '.git'].includes(e.name)) continue
    const fullPath = dir === e.name ? e.name : `${dir}/${e.name}`
    if (e.isDirectory) {
      await walkDir(root, fullPath, out)
    } else {
      const relPath = fullPath.startsWith(root + '/') ? fullPath.slice(root.length + 1) : fullPath
      out.push({
        path: fullPath,
        name: e.name,
        dirPath: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '',
        icon: fileIcon(e.name),
      })
    }
  }
}

function move(delta: number) {
  const len = filtered.value.length
  if (!len) return
  selectedIdx.value = (selectedIdx.value + delta + len) % len
}

function openSelected() {
  const item = filtered.value[selectedIdx.value]
  if (item) openItem(item)
}

function openItem(item: QuickOpenItem) {
  emit('open', item.path)
  emit('close')
}
</script>

<style scoped>
.qo-overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: center;
  padding-top: 60px;
}

.qo-modal {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  width: 560px;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.qo-input {
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
.qo-input::placeholder { color: var(--text-secondary); }

.qo-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.qo-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
}
.qo-item:hover,
.qo-item.active {
  background: var(--bg-active);
  color: #fff;
}

.qo-icon { font-size: 13px; flex-shrink: 0; }

.qo-name {
  font-weight: 500;
  flex-shrink: 0;
}

.qo-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: 11px;
}
.qo-item.active .qo-path { color: rgba(255,255,255,0.6); }

.qo-recent-badge {
  font-size: 10px;
  color: var(--text-accent);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 1px 5px;
  flex-shrink: 0;
}
.qo-item.active .qo-recent-badge {
  color: rgba(255,255,255,0.8);
  background: rgba(255,255,255,0.1);
  border-color: rgba(255,255,255,0.2);
}

.qo-empty {
  padding: 16px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
}
</style>
