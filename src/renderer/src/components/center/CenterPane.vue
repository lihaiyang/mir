<template>
  <div class="center-pane-inner" ref="containerRef">
    <!-- PaneGroups for ALL projects (always in DOM to keep Teleport targets alive) -->
    <PaneGroup
      v-for="r in allRegions"
      :key="r.groupId"
      :project-id="r.projectId"
      :group-id="r.groupId"
      :focused="r.projectId === activeProject?.id && tabStore.getFocusedGroupId(r.projectId) === r.groupId"
      :style="regionStyle(r)"
      v-show="r.projectId === activeProject?.id"
    />
    <div
      v-for="s in allSplitters"
      :key="s.nodeId"
      class="splitter"
      :class="s.direction === 'horizontal' ? 'splitter-h' : 'splitter-v'"
      :style="splitterStyle(s)"
      @mousedown="startResize(s, $event)"
      @dblclick="resetSplit(s.nodeId)"
      v-show="s.projectId === activeProject?.id"
    />

    <!-- KeepAlive: all non-browser tabs across all projects -->
    <KeepAlive>
      <template v-for="tab in allTeleportTabs" :key="tab.id">
        <Teleport :to="`#pane-content-${tabToGroup[tab.id]}`" :disabled="!tabToGroup[tab.id]">
          <component
            :is="tabComponents[tab.type]"
            :tab="tab"
            v-show="isTabVisibleInGroup(tab)"
          />
        </Teleport>
      </template>
    </KeepAlive>

    <!-- Standalone browser: one webview per page, hidden ones keep compositor state -->
    <div class="standalone-browser">
      <template v-for="(tab, wpId) in standaloneTabCache" :key="wpId">
        <div
          class="standalone-browser-slot"
          :class="{ 'standalone-hidden': wpId !== selectedWebPage?.id }"
        >
          <BrowserTab :tab="tab" />
        </div>
      </template>
    </div>

    <!-- Project view: shown when no web page is selected -->
    <template v-if="!selectedWebPage">
      <div v-if="!activeProject" class="no-project-hint">
        <p style="font-size:18px;margin-bottom:12px">{{ $t('centerPane.noProject') }}</p>
        <p style="font-size:13px;color:var(--text-secondary)">
          {{ $t('centerPane.noProjectHint') }}
        </p>
      </div>

      <div v-else-if="!paneTree" class="no-tabs-hint">
        <p>{{ $t('centerPane.noTabs') }}</p>
        <button class="btn-primary" @click="createTab('terminal')">{{ $t('centerPane.newTab') }}</button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useProjectStore } from '../../stores/projects'
import { useWebPageStore, standaloneNavBus } from '../../stores/webPages'
import { useTabStore, type TabType, type TreeNode } from '../../stores/tabs'
import PaneGroup from './PaneGroup.vue'
import BrowserTab from './BrowserTab.vue'
import TerminalTab from './TerminalTab.vue'
import EditorTab from './EditorTab.vue'
import FileTab from './FileTab.vue'
import DiffTab from './DiffTab.vue'

const projectStore = useProjectStore()
const webPageStore = useWebPageStore()
const tabStore = useTabStore()

const tabComponents: Record<string, any> = {
  terminal: TerminalTab,
  editor: EditorTab,
  file: FileTab,
  diff: DiffTab
}

// Collect all non-browser tabs across ALL projects, so KeepAlive never evicts them
// when switching between projects
const allTeleportTabs = computed(() => {
  const tabs: import('../../stores/tabs').Tab[] = []
  for (const p of projectStore.projects) {
    tabs.push(...tabStore.getAllTabs(p.id).filter(t => t.type !== 'browser'))
  }
  return tabs
})

// Map tabId → groupId across all projects
const tabToGroup = computed(() => {
  const map: Record<string, string> = {}
  for (const p of projectStore.projects) {
    const groups = tabStore.tabGroups[p.id]
    if (!groups) continue
    for (const [gid, g] of Object.entries(groups)) {
      for (const t of g.tabs) {
        map[t.id] = gid
      }
    }
  }
  return map
})

function isTabVisibleInGroup(tab: import('../../stores/tabs').Tab): boolean {
  if (!activeProject.value) return false
  // Only show tabs belonging to the active project
  if (tab.projectId !== activeProject.value.id) return false
  const gid = tabToGroup.value[tab.id]
  if (!gid) return false
  return tabStore.getGroupActiveTabId(tab.projectId, gid) === tab.id
}

const activeProject = computed(() => projectStore.activeProject)
const selectedWebPage = computed(() => {
  if (!webPageStore.selectedWebPageId) return null
  return webPageStore.webPages.find(w => w.id === webPageStore.selectedWebPageId) ?? null
})

// Keep a BrowserTab per web page so switching doesn't reload the webview
const standaloneTabCache = ref<Record<string, {
  id: string; projectId: string; type: 'browser'; title: string; browserUrl: string
}>>({})

watch(selectedWebPage, (wp) => {
  if (wp && !standaloneTabCache.value[wp.id]) {
    standaloneTabCache.value = {
      ...standaloneTabCache.value,
      [wp.id]: {
        id: `standalone-browser-${wp.id}`,
        projectId: '',
        type: 'browser',
        title: wp.title,
        browserUrl: wp.url
      }
    }
  }
  // Sync navBus when switching to an already-cached page so TitleBar updates
  if (wp) {
    standaloneNavBus.url = wp.url
    standaloneNavBus.isLoading = false
  }
})

const paneTree = computed(() => {
  if (!activeProject.value) return null
  return tabStore.getPaneTree(activeProject.value.id)
})

const containerRef = ref<HTMLElement | null>(null)
const containerW = ref(0)
const containerH = ref(0)
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        containerW.value = entry.contentRect.width
        containerH.value = entry.contentRect.height
      }
    })
    resizeObserver.observe(containerRef.value)
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})

// --- Flat layout computation (all projects) ---

interface Region {
  groupId: string
  projectId: string
  x: number; y: number; width: number; height: number
}

interface SplitterInfo {
  nodeId: string
  projectId: string
  x: number; y: number; width: number; height: number
  direction: 'horizontal' | 'vertical'
}

const SPLITTER_SIZE = 4

function computeLayout(tree: TreeNode | null, w: number, h: number): { regions: Region[]; splitters: SplitterInfo[] } {
  if (!tree || w <= 0 || h <= 0) return { regions: [], splitters: [] }

  const regions: Region[] = []
  const splitters: SplitterInfo[] = []

  function walk(node: TreeNode, bounds: { x: number; y: number; width: number; height: number }) {
    if (node.type === 'leaf') {
      regions.push({ groupId: node.groupId, projectId: '', ...bounds })
      return
    }

    const [s0, s1] = node.sizes

    if (node.type === 'horizontal') {
      const w0 = Math.max(0, bounds.width * s0 - SPLITTER_SIZE / 2)
      const splitX = bounds.x + bounds.width * s0
      const w1 = Math.max(0, bounds.width * s1 - SPLITTER_SIZE / 2)

      splitters.push({ nodeId: node.id, projectId: '', x: splitX, y: bounds.y, width: SPLITTER_SIZE, height: bounds.height, direction: 'horizontal' })

      walk(node.children[0], { x: bounds.x, y: bounds.y, width: w0, height: bounds.height })
      walk(node.children[1], { x: splitX + SPLITTER_SIZE / 2, y: bounds.y, width: w1, height: bounds.height })
    } else {
      const h0 = Math.max(0, bounds.height * s0 - SPLITTER_SIZE / 2)
      const splitY = bounds.y + bounds.height * s0
      const h1 = Math.max(0, bounds.height * s1 - SPLITTER_SIZE / 2)

      splitters.push({ nodeId: node.id, projectId: '', x: bounds.x, y: splitY, width: bounds.width, height: SPLITTER_SIZE, direction: 'vertical' })

      walk(node.children[0], { x: bounds.x, y: bounds.y, width: bounds.width, height: h0 })
      walk(node.children[1], { x: bounds.x, y: splitY + SPLITTER_SIZE / 2, width: bounds.width, height: h1 })
    }
  }

  walk(tree, { x: 0, y: 0, width: w, height: h })
  return { regions, splitters }
}

// Compute regions for ALL projects — always kept in DOM so Teleport targets survive
// project switches. Only the active project's panes are visible (v-show).
const allRegions = computed(() => {
  const result: Region[] = []
  for (const p of projectStore.projects) {
    const tree = tabStore.getPaneTree(p.id)
    if (!tree) continue
    const { regions } = computeLayout(tree, containerW.value, containerH.value)
    for (const r of regions) {
      result.push({ ...r, projectId: p.id })
    }
  }
  return result
})

const allSplitters = computed(() => {
  const result: SplitterInfo[] = []
  for (const p of projectStore.projects) {
    const tree = tabStore.getPaneTree(p.id)
    if (!tree) continue
    const { splitters } = computeLayout(tree, containerW.value, containerH.value)
    for (const s of splitters) {
      result.push({ ...s, projectId: p.id })
    }
  }
  return result
})

function regionStyle(r: Region) {
  return {
    position: 'absolute' as const,
    left: r.x + 'px',
    top: r.y + 'px',
    width: r.width + 'px',
    height: r.height + 'px'
  }
}

function splitterStyle(s: SplitterInfo) {
  return {
    position: 'absolute' as const,
    left: s.x + 'px',
    top: s.y + 'px',
    width: s.width + 'px',
    height: s.height + 'px'
  }
}

// --- Resize ---

let resizing: { nodeId: string; direction: 'horizontal' | 'vertical'; start: number; sizes: [number, number]; totalSize: number } | null = null

function startResize(s: SplitterInfo, e: MouseEvent) {
  if (!activeProject.value) return
  const sizes = getSplitSizes(tabStore.getPaneTree(activeProject.value.id), s.nodeId)
  if (!sizes) return

  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect) return

  resizing = {
    nodeId: s.nodeId,
    direction: s.direction,
    start: s.direction === 'horizontal' ? e.clientX : e.clientY,
    sizes: [...sizes],
    totalSize: s.direction === 'horizontal' ? rect.width : rect.height
  }

  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function getSplitSizes(tree: TreeNode | null, nodeId: string): [number, number] | null {
  if (!tree) return null
  if (tree.type === 'leaf') return null
  if (tree.id === nodeId) return [...tree.sizes]
  return getSplitSizes(tree.children[0], nodeId) || getSplitSizes(tree.children[1], nodeId)
}

function onMouseMove(e: MouseEvent) {
  if (!resizing || !activeProject.value || resizing.totalSize <= 0) return
  const delta = (resizing.direction === 'horizontal' ? e.clientX : e.clientY) - resizing.start
  const deltaPct = delta / resizing.totalSize
  const s0 = Math.max(0.1, Math.min(0.9, resizing.sizes[0] + deltaPct))
  const s1 = Math.max(0.1, Math.min(0.9, 1 - s0))
  tabStore.resizeSplit(activeProject.value.id, resizing.nodeId, [s0, s1])
}

function onMouseUp() {
  resizing = null
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}

function resetSplit(nodeId: string) {
  if (!activeProject.value) return
  tabStore.resizeSplit(activeProject.value.id, nodeId, [0.5, 0.5])
}

// --- Keyboard ---

function handleKey(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  if (!activeProject.value) return
  const pid = activeProject.value.id

  if (mod && e.key === 't') {
    e.preventDefault()
    tabStore.addTab(pid, 'terminal')
  }
  if (mod && e.key === 'w') {
    e.preventDefault()
    const fgId = tabStore.getFocusedGroupId(pid)
    if (!fgId) return
    const activeTabId = tabStore.getGroupActiveTabId(pid, fgId)
    if (activeTabId) tabStore.closeTab(pid, activeTabId)
  }
  if (mod && e.key === '\\') {
    e.preventDefault()
    doSplit(e.shiftKey ? 'vertical' : 'horizontal')
  }
  if (mod && e.key === 'Tab') {
    e.preventDefault()
    const fgId = tabStore.getFocusedGroupId(pid)
    if (!fgId) return
    const tabs = tabStore.getGroupTabs(pid, fgId)
    const activeTabId = tabStore.getGroupActiveTabId(pid, fgId)
    const idx = tabs.findIndex(t => t.id === activeTabId)
    if (idx === -1) return
    const next = e.shiftKey
      ? (idx - 1 + tabs.length) % tabs.length
      : (idx + 1) % tabs.length
    if (tabs[next]) tabStore.setActiveTab(pid, tabs[next].id)
  }
}

async function doSplit(direction: 'horizontal' | 'vertical') {
  const pid = activeProject.value!.id
  const fgId = tabStore.getFocusedGroupId(pid)
  if (!fgId) return
  const activeTab = tabStore.getGroupActiveTab(pid, fgId)
  if (activeTab) {
    const template = { ...activeTab }
    tabStore.splitPane(pid, direction, template)
  } else {
    tabStore.splitPane(pid, direction)
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKey)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKey)
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})

async function createTab(type: TabType) {
  if (!activeProject.value) return
  await tabStore.addTab(activeProject.value.id, type)
}
</script>

<style scoped>
.center-pane-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
  position: relative;
  overflow: hidden;
}

.no-tabs-hint,
.no-project-hint {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  gap: 12px;
}

.standalone-browser {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  pointer-events: none;
}
/* Each web page gets its own absolutely-positioned slot */
.standalone-browser-slot {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
}
/* visibility:hidden instead of display:none — preserves webview compositor state */
.standalone-hidden {
  visibility: hidden;
  pointer-events: none;
}

.splitter {
  background: var(--border-color);
  z-index: 10;
}
.splitter:hover {
  background: var(--text-accent);
}
.splitter-h { cursor: col-resize; }
.splitter-v { cursor: row-resize; }
</style>