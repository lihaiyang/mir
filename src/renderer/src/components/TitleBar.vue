<template>
  <div class="titlebar">
    <div class="tl-left" :style="{ width: leftWidthPx }" />
    <div class="tl-splitter" />

    <!-- ── Standalone web page mode: narrow centered address bar ── -->
    <template v-if="selectedWebPage">
      <div class="tl-center tl-center--browser">
        <!-- drag pad left -->
        <div class="tl-drag-pad" />

        <!-- nav + address bar cluster -->
        <div class="tl-browser-bar" @dblclick.stop>
          <button class="tl-nav-btn" :disabled="!standaloneNavBus.canGoBack"  @click="navCmd('back')"><Icon name="chevron-left" :size="13" /></button>
          <button class="tl-nav-btn" :disabled="!standaloneNavBus.canGoForward" @click="navCmd('forward')"><Icon name="chevron-right" :size="13" /></button>
          <button class="tl-nav-btn" @click="navCmd('reload')">
            <Icon :name="standaloneNavBus.isLoading ? 'x' : 'refresh'" :size="13" />
          </button>
          <input
            v-model="addrBar"
            class="tl-url-input"
            :placeholder="$t('browser.placeholder')"
            @keydown.enter="navTo"
            @focus="($event.target as HTMLInputElement).select()"
            @dblclick.stop
            @mousedown.stop
          />
          <button class="tl-nav-btn" @click="openDevTools" :title="$t('browser.devTools')"><Icon name="wrench" :size="13" /></button>
        </div>

        <!-- drag pad right -->
        <div class="tl-drag-pad" />
      </div>
    </template>

    <!-- ── Browser panel mode: tab bar teleported here from BrowserPanel ──
         The container stays in the DOM permanently (v-show, NOT v-if): destroying
         it on a mode switch would also destroy the <Teleport> content mounted into
         it from BrowserPanel, and the Teleport never re-mounts into the rebuilt
         container — the tab bar would then be gone until the app restarts. -->
    <div
      v-show="!selectedWebPage && browserStore.active"
      id="mir-browser-tabs"
      class="tl-center tl-center--browser-tabs"
    />

    <!-- ── Normal project mode: first-row TabBars ── -->
    <template v-if="!selectedWebPage && !browserStore.active">
      <div class="tl-center">
        <div
          v-for="(pane, i) in firstRowPanes"
          :key="pane.groupId"
          class="tl-tabbar-slot"
          :style="{ flex: pane.widthFraction }"
        >
          <TabBar
            v-if="activeProject"
            :project-id="activeProject.id"
            :group-id="pane.groupId"
          />
          <div
            v-if="i < firstRowPanes.length - 1"
            class="tl-pane-splitter"
            @mousedown.stop="startResize(firstRowSplitters[i], $event)"
          />
        </div>
      </div>
    </template>

    <div class="tl-splitter" />

    <div class="tl-right" :style="{ width: rightWidthPx }">
      <div class="tl-right-spacer" />
      <button class="tl-btn" :title="$t('common.settings')" @click="openSettings"><Icon name="settings" :size="14" /></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLayoutStore } from '../stores/layout'
import { useProjectStore } from '../stores/projects'
import { useTabStore } from '../stores/tabs'
import { useWebPageStore, standaloneNavBus } from '../stores/webPages'
import { useBrowserStore } from '../stores/browser'
import TabBar from './center/TabBar.vue'
import Icon from './ui/Icon.vue'

const { t } = useI18n()
const layout = useLayoutStore()
const projectStore = useProjectStore()
const tabStore = useTabStore()
const webPageStore = useWebPageStore()
const browserStore = useBrowserStore()

function openSettings() {
  if (!projectStore.activeProject) return
  tabStore.addTab(projectStore.activeProject.id, 'settings')
}

const activeProject = computed(() => projectStore.activeProject)
const selectedWebPage = computed(() => {
  if (!webPageStore.selectedWebPageId) return null
  return webPageStore.webPages.find(w => w.id === webPageStore.selectedWebPageId) ?? null
})

// Address bar input (mirrors navBus.url, locally editable)
const addrBar = ref('')

watch(() => standaloneNavBus.url, (u) => {
  addrBar.value = u
}, { immediate: true })

watch(selectedWebPage, (wp) => {
  if (wp) addrBar.value = wp.url
})

function navCmd(cmd: 'back' | 'forward' | 'reload') {
  standaloneNavBus.cmd = cmd
}

function navTo() {
  standaloneNavBus.cmdUrl = addrBar.value
  standaloneNavBus.cmd = 'navigate'
}

function openDevTools() {
  standaloneNavBus.cmd = 'devtools'
}

const firstRowPanes = computed(() => {
  if (!activeProject.value) return []
  return tabStore.getFirstRowPanes(activeProject.value.id)
})
const firstRowSplitters = computed(() => {
  if (!activeProject.value) return []
  return tabStore.getFirstRowSplitters(activeProject.value.id)
})

// The side panes are border-box sized (width includes their 1px divider
// border), so the titlebar segments must be 1px narrower for the titlebar
// splitters to land exactly on the same pixels as the pane borders below.
const leftWidthPx = computed(() => (layout.leftCollapsed ? 40 : layout.leftWidth) - 1 + 'px')
const rightWidthPx = computed(() => (layout.rightCollapsed ? 32 : layout.rightWidth) - 1 + 'px')

// Splitter drag
let resizeNodeId: string | null = null
let resizeStartX = 0
let resizeStartSizes: [number, number] = [0.5, 0.5]

function startResize(splitter: { nodeId: string }, e: MouseEvent) {
  if (!activeProject.value) return
  resizeNodeId = splitter.nodeId
  resizeStartX = e.clientX
  const tree = tabStore.getPaneTree(activeProject.value.id)
  const sizes = findSizes(tree, splitter.nodeId)
  if (sizes) resizeStartSizes = sizes
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function findSizes(node: import('../../stores/tabs').TreeNode | null, targetId: string): [number, number] | null {
  if (!node || node.type === 'leaf') return null
  if (node.id === targetId) return [...node.sizes]
  return findSizes(node.children[0], targetId) || findSizes(node.children[1], targetId)
}

function onMouseMove(e: MouseEvent) {
  if (!resizeNodeId || !activeProject.value) return
  const container = document.querySelector('.tl-center') as HTMLElement | null
  if (!container) return
  const total = container.getBoundingClientRect().width
  if (total <= 0) return
  const delta = (e.clientX - resizeStartX) / total
  const s0 = Math.max(0.1, Math.min(0.9, resizeStartSizes[0] + delta))
  const s1 = Math.max(0.1, Math.min(0.9, 1 - s0))
  tabStore.resizeSplit(activeProject.value.id, resizeNodeId, [s0, s1])
}

function onMouseUp() {
  resizeNodeId = null
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}
</script>

<style scoped>
.titlebar {
  display: flex; align-items: center;
  height: 32px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  -webkit-app-region: drag; flex-shrink: 0;
}
.tl-left { height: 100%; flex-shrink: 0; min-width: 40px; }
.tl-splitter {
  width: 1px; height: 100%;
  background: var(--border-color); flex-shrink: 0;
}
.tl-splitter:hover { background: var(--text-accent); }

/* ── Normal tab mode ── */
.tl-center {
  display: flex; align-items: center;
  flex: 1; min-width: 0; height: 100%;
}
.tl-tabbar-slot {
  position: relative;
  min-width: 0; height: 100%;
}
.tl-pane-splitter {
  position: absolute;
  right: -4px; top: 0; bottom: 0;
  width: 4px;
  background: var(--border-color);
  cursor: col-resize;
  z-index: 10;
  -webkit-app-region: no-drag;
}
.tl-pane-splitter:hover { background: var(--text-accent); }
.tl-center :deep(.tab-bar) {
  border-bottom: none;
  -webkit-app-region: drag;
}

/* ── Browser panel tabs (teleported in from BrowserPanel) ── */
.tl-center--browser-tabs {
  overflow: hidden;
  -webkit-app-region: drag;
}
.tl-center--browser-tabs :deep(.bp-tabbar) {
  height: 100%;
  padding: 0 6px;
  background: transparent;
  border-bottom: none;
  -webkit-app-region: drag;
}
.tl-center--browser-tabs :deep(.bp-tab),
.tl-center--browser-tabs :deep(.bp-tab-close),
.tl-center--browser-tabs :deep(.bp-new-tab) {
  -webkit-app-region: no-drag;
}

/* ── Browser / standalone mode ── */
.tl-center--browser {
  justify-content: center;
  gap: 0;
}
/* drag pads on both sides fill remaining space */
.tl-drag-pad {
  flex: 1;
  min-width: 40px;    /* always at least 40px drag zone on each side */
  height: 100%;
  -webkit-app-region: drag;
}
/* the nav+input cluster: fixed width, centered, no-drag */
.tl-browser-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  width: clamp(320px, 38%, 560px);
  flex-shrink: 0;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 0 4px;
  height: 22px;
  -webkit-app-region: no-drag;
}
.tl-browser-bar:focus-within {
  border-color: var(--text-accent);
}
.tl-nav-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 4px; flex-shrink: 0;
  font-size: 11px; color: var(--text-secondary);
  -webkit-app-region: no-drag;
}
.tl-nav-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.tl-nav-btn:disabled { opacity: 0.35; cursor: default; }
.tl-nav-btn:disabled:hover { background: none; }
.tl-url-input {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  padding: 1px 6px;
  background: transparent;
  border: none;
  color: var(--text-primary);
  outline: none;
  -webkit-app-region: no-drag;
}

/* ── Right panel ── */
.tl-right { display: flex; align-items: center; flex-shrink: 0; height: 100%; }
.tl-right-spacer { flex: 1; -webkit-app-region: drag; }
.tl-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 4px; cursor: pointer;
  color: var(--text-secondary); font-size: 14px; flex-shrink: 0;
  -webkit-app-region: no-drag;
}
.tl-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
</style>
