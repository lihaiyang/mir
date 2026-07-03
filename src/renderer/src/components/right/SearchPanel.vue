<template>
  <div class="search-panel">
    <div class="search-controls">
      <div class="search-row">
        <input
          v-model="query"
          ref="queryInput"
          class="search-input"
          :placeholder="$t('search.placeholder')"
          @focus="onFocus"
          @blur="onBlur"
          @keydown.enter="runSearch"
          @keydown.escape="showHistory = false"
        />
        <button class="icon-btn" title="Search" @click="runSearch" :disabled="searching">🔍</button>
      </div>

      <!-- History dropdown -->
      <div v-if="showHistory && history.length > 0" class="search-history">
        <div
          v-for="h in history"
          :key="h"
          class="history-item"
          @mousedown.prevent="query = h; showHistory = false"
        >{{ h }}</div>
      </div>

      <div class="search-options">
        <label class="opt-label" :title="$t('search.caseSensitive')">
          <input type="checkbox" v-model="caseSensitive" />Aa
        </label>
        <label class="opt-label" :title="$t('search.wholeWord')">
          <input type="checkbox" v-model="wholeWord" />\\b
        </label>
        <label class="opt-label" :title="$t('search.regex')">
          <input type="checkbox" v-model="isRegex" />.*
        </label>
      </div>

      <div class="search-row">
        <input
          v-model="extensionsInput"
          class="search-input"
          :placeholder="$t('search.filterExt')"
          style="font-size:11px"
        />
      </div>

      <!-- Replace row -->
      <div class="search-row">
        <input
          v-model="replaceQuery"
          class="search-input"
          :placeholder="$t('search.replaceWith')"
        />
        <button class="icon-btn" :title="$t('search.replaceAll')" @click="confirmReplace" :disabled="searching || !replaceQuery">⇄</button>
      </div>
    </div>

    <div v-if="searching" class="search-progress">{{ $t('search.searching') }} — {{ matchCount }} matches in {{ filesProcessed }} files</div>
    <div v-else-if="searchError" class="search-error">{{ searchError }}</div>
    <div v-else-if="results.length === 0 && hasSearched" class="search-empty">{{ $t('search.noResults') }}</div>
    <div v-else-if="results.length > 0" class="search-summary">{{ matchCount }} matches ({{ filesProcessed }} files scanned)</div>

    <!-- Results -->
    <div class="results-scroll">
      <template v-for="(group, file) in groupedResults" :key="file">
        <div class="result-file-header" @click="toggleFile(file as string)">
          <span>{{ fileCollapsed.has(file as string) ? '▸' : '▾' }}</span>
          <span class="result-file-name">{{ file }}</span>
          <span class="result-count">{{ group.length }}</span>
        </div>
        <template v-if="!fileCollapsed.has(file as string)">
          <div
            v-for="match in group"
            :key="match.line + ':' + match.col"
            class="result-item"
            @click="openResult(match)"
          >
            <span class="result-line">{{ match.line }}</span>
            <span class="result-text" v-html="highlight(match.text)" />
          </div>
        </template>
      </template>
    </div>

    <!-- Replace confirm -->
    <div v-if="replacePreview" class="modal-overlay" @click.self="replacePreview = null">
      <div class="modal">
        <div class="modal-title">{{ $t('search.replaceAll') }}</div>
        <p style="font-size:13px;margin-bottom:12px">
          {{ $t('search.replaceConfirm', { count: results.length, from: query, to: replaceQuery }) }}
        </p>
        <div class="modal-actions">
          <button class="btn-secondary" @click="replacePreview = null">{{ $t('common.cancel') }}</button>
          <button class="btn-primary" @click="doReplace">{{ $t('search.replaceAll') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useProjectStore } from '../../stores/projects'
import { useTabStore } from '../../stores/tabs'
import { useFileTree } from '../../composables/useFileTree'

const projectStore = useProjectStore()
const tabStore = useTabStore()
const { joinPath } = useFileTree()
const activeProject = computed(() => projectStore.activeProject)

const query = ref('')
const replaceQuery = ref('')
const caseSensitive = ref(false)
const wholeWord = ref(false)
const isRegex = ref(false)
const extensionsInput = ref('')
const searching = ref(false)
const searchError = ref('')
const hasSearched = ref(false)
const results = ref<SearchMatch[]>([])
const matchCount = ref(0)
const filesProcessed = ref(0)
const history = ref<string[]>([])
const showHistory = ref(false)
let blurTimer: ReturnType<typeof setTimeout> | null = null
const fileCollapsed = ref(new Set<string>())
const replacePreview = ref<null | true>(null)
let currentSearchId: string | null = null

const groupedResults = computed(() => {
  const map: Record<string, SearchMatch[]> = {}
  results.value.forEach(r => {
    if (!map[r.file]) map[r.file] = []
    map[r.file].push(r)
  })
  return map
})

onMounted(async () => {
  const stored = await window.electronAPI.storeGet('searchHistory') as string[] | null
  if (Array.isArray(stored)) history.value = stored
})

onUnmounted(() => {
  if (currentSearchId) {
    window.electronAPI.searchCancel(currentSearchId)
    currentSearchId = null
  }
  offResults?.()
  offComplete?.()
  offError?.()
  offResults = null
  offComplete = null
  offError = null
})

let offResults: (() => void) | null = null
let offComplete: (() => void) | null = null
let offError: (() => void) | null = null

function setupListeners() {
  offResults = window.electronAPI.onSearchResults((id, matches) => {
    if (id !== currentSearchId) return
    results.value = [...results.value, ...matches]
    matchCount.value = results.value.length
  })
  offComplete = window.electronAPI.onSearchComplete((id, files, total) => {
    if (id !== currentSearchId) return
    filesProcessed.value = files
    matchCount.value = total
    searching.value = false
    currentSearchId = null
    saveHistory()
  })
  offError = window.electronAPI.onSearchError((id, message) => {
    if (id !== currentSearchId) return
    searchError.value = message
    searching.value = false
    currentSearchId = null
  })
}

function saveHistory() {
  history.value = [query.value, ...history.value.filter(h => h !== query.value)].slice(0, 10)
  window.electronAPI.storeSet('searchHistory', history.value)
}

function onFocus() {
  if (blurTimer) { clearTimeout(blurTimer); blurTimer = null }
  showHistory.value = true
}

function onBlur() {
  blurTimer = setTimeout(() => { showHistory.value = false }, 200)
}

function runSearch() {
  if (!query.value.trim() || !activeProject.value) return
  if (currentSearchId) {
    window.electronAPI.searchCancel(currentSearchId)
  }
  if (!offResults) setupListeners()

  currentSearchId = crypto.randomUUID()
  searching.value = true
  searchError.value = ''
  hasSearched.value = true
  results.value = []
  matchCount.value = 0
  filesProcessed.value = 0
  fileCollapsed.value.clear()

  const extensions = extensionsInput.value
    .split(',')
    .map(e => e.trim().startsWith('.') ? e.trim() : '.' + e.trim())
    .filter(e => e.length > 1)

  window.electronAPI.searchStart(currentSearchId, {
    rootPath: activeProject.value.path,
    query: query.value,
    isRegex: isRegex.value,
    caseSensitive: caseSensitive.value,
    wholeWord: wholeWord.value,
    extensions: extensions.length > 0 ? extensions : undefined
  })
}

function toggleFile(file: string) {
  if (fileCollapsed.value.has(file)) fileCollapsed.value.delete(file)
  else fileCollapsed.value.add(file)
}

async function openResult(match: SearchMatch) {
  if (!activeProject.value) return
  const fp = joinPath(activeProject.value.path, match.file)
  const pid = activeProject.value.id
  const fileName = fp.split('/').pop() || fp
  // Reuse existing file tab for same path, or create new one
  const existing = tabStore.getProjectTabs(pid).find(t => t.type === 'file' && t.filePath === fp)
  if (existing) {
    tabStore.updateTab(pid, existing.id, { fileLine: match.line })
    tabStore.setActiveTab(pid, existing.id)
  } else {
    await tabStore.addTab(pid, 'file', { title: fileName, filePath: fp, fileLine: match.line })
  }
}

function highlight(text: string): string {
  if (!query.value) return escapeHtml(text)
  try {
    let q = isRegex.value ? query.value : escapeRegex(query.value)
    if (wholeWord.value) q = `\\b${q}\\b`
    const re = new RegExp(`(${q})`, caseSensitive.value ? 'g' : 'gi')
    return escapeHtml(text).replace(re, '<mark>$1</mark>')
  } catch {
    return escapeHtml(text)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function confirmReplace() {
  if (results.value.length === 0) return
  replacePreview.value = true
}

async function doReplace() {
  replacePreview.value = null
  if (!activeProject.value) return
  // Group by file
  const fileGroups = groupedResults.value
  for (const [relPath, matches] of Object.entries(fileGroups)) {
    const fp = joinPath(activeProject.value.path, relPath)
    let { content } = await window.electronAPI.readFile(fp)
    try {
      let q = isRegex.value ? query.value : escapeRegex(query.value)
      if (wholeWord.value) q = `\\b${q}\\b`
      const re = new RegExp(q, caseSensitive.value ? 'g' : 'gi')
      content = content.replace(re, replaceQuery.value)
      await window.electronAPI.writeFile(fp, content)
    } catch {}
  }
  runSearch()
}
</script>

<style scoped>
.search-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font-size: 12px;
}
.search-controls {
  padding: 8px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.search-row {
  display: flex;
  gap: 4px;
  align-items: center;
}
.search-input { flex: 1; font-size: 12px; }
.search-options { display: flex; gap: 8px; align-items: center; }
.opt-label {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 5px;
  border-radius: 3px;
  border: 1px solid var(--border-color);
}
.opt-label:hover { background: var(--bg-hover); }
.search-history {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  max-height: 120px;
  overflow-y: auto;
}
.history-item { padding: 4px 8px; cursor: pointer; font-size: 11px; }
.history-item:hover { background: var(--bg-hover); }
.search-progress, .search-empty { padding: 8px; color: var(--text-secondary); font-size: 11px; }
.search-error { padding: 8px; color: var(--text-danger); font-size: 11px; }
.search-summary { padding: 4px 8px; font-size: 11px; color: var(--text-accent); background: var(--bg-tertiary); border-bottom: 1px solid var(--border-color); }
.results-scroll { flex: 1; overflow-y: auto; }
.result-file-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--bg-tertiary);
  cursor: pointer;
  position: sticky;
  top: 0;
}
.result-file-header:hover { background: var(--bg-hover); }
.result-file-name { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-count { font-size: 10px; color: var(--text-accent); background: var(--bg-active); padding: 1px 5px; border-radius: 8px; }
.result-item {
  display: flex;
  gap: 6px;
  padding: 2px 8px 2px 16px;
  cursor: pointer;
  font-family: monospace;
}
.result-item:hover { background: var(--bg-hover); }
.result-line { color: var(--text-accent); width: 36px; text-align: right; flex-shrink: 0; font-size: 11px; }
.result-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
:deep(mark) { background: #f59e0b; color: #000; border-radius: 2px; padding: 0 1px; }
</style>
