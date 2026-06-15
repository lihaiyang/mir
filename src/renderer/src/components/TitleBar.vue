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
          <button class="tl-nav-btn" :disabled="!standaloneNavBus.canGoBack"  @click="navCmd('back')">◀</button>
          <button class="tl-nav-btn" :disabled="!standaloneNavBus.canGoForward" @click="navCmd('forward')">▶</button>
          <button class="tl-nav-btn" @click="navCmd('reload')">
            {{ standaloneNavBus.isLoading ? '✕' : '↺' }}
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
          <button class="tl-nav-btn" @click="openDevTools" :title="$t('browser.devTools')">⚙</button>
        </div>

        <!-- drag pad right -->
        <div class="tl-drag-pad" />
      </div>
    </template>

    <!-- ── Normal project mode: first-row TabBars ── -->
    <template v-else>
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
      <template v-if="layout.rightCollapsed">
        <button class="tl-btn" :title="$t('common.expand')" @click="layout.rightCollapsed = false; layout.persist()">«</button>
      </template>
      <template v-else>
        <div class="tl-right-tabs">
          <div v-for="panel in panels" :key="panel.id"
            class="tl-right-tab" :class="{ active: layout.rightActivePanel === panel.id }"
            @click="layout.rightActivePanel = panel.id; layout.persist()"
          >{{ panel.label }}</div>
        </div>
        <button class="tl-btn" :title="$t('common.collapse')" @click="layout.rightCollapsed = true; layout.persist()">»</button>
      </template>
      <!-- Language quick-toggle: always visible regardless of right-pane collapse state -->
      <div class="tl-lang-toggle">
        <span
          class="tl-lang-btn"
          :class="{ active: currentLanguage === 'en' }"
          @click="setLanguage('en')"
        >EN</span>
        <span class="tl-lang-sep">|</span>
        <span
          class="tl-lang-btn"
          :class="{ active: currentLanguage === 'zh-CN' }"
          @click="setLanguage('zh-CN')"
        >中</span>
      </div>
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
import { useSettingsStore } from '../stores/settings'
import TabBar from './center/TabBar.vue'

const { t, locale } = useI18n()
const layout = useLayoutStore()
const projectStore = useProjectStore()
const tabStore = useTabStore()
const webPageStore = useWebPageStore()
const settingsStore = useSettingsStore()

const currentLanguage = computed(() => settingsStore.settings.language)

function setLanguage(lang: 'en' | 'zh-CN') {
  if (lang === currentLanguage.value) return
  settingsStore.update({ language: lang })
  locale.value = lang
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

const panels = computed(() => [
  { id: 'files' as const, label: t('titlebar.files') },
  { id: 'git' as const, label: t('titlebar.git') },
  { id: 'search' as const, label: t('titlebar.search') }
])

const leftWidthPx = computed(() => (layout.leftCollapsed ? '70px' : layout.leftWidth + 'px'))
const rightWidthPx = computed(() => (layout.rightCollapsed ? '40px' : layout.rightWidth + 'px'))

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
.tl-left { height: 100%; flex-shrink: 0; min-width: 70px; }
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
.tl-right-tabs { display: flex; align-items: center; height: 100%; flex: 1; overflow: hidden; }
.tl-right-tab {
  padding: 0 10px; height: 100%;
  display: flex; align-items: center;
  font-size: 11px; font-weight: 600; cursor: pointer;
  color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap;
  -webkit-app-region: no-drag;
}
.tl-right-tab:hover { color: var(--text-primary); background: var(--bg-hover); }
.tl-right-tab.active { color: var(--text-primary); border-bottom: 2px solid var(--text-accent); }
.tl-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 4px; cursor: pointer;
  color: var(--text-secondary); font-size: 14px; flex-shrink: 0;
  -webkit-app-region: no-drag;
}
.tl-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

/* Language quick-toggle */
.tl-lang-toggle {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
  border-left: 1px solid var(--border-color);
  height: 100%;
}
.tl-lang-btn {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 4px;
  border-radius: 3px;
  cursor: pointer;
  color: var(--text-secondary);
  letter-spacing: 0.04em;
  user-select: none;
}
.tl-lang-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
.tl-lang-btn.active { color: var(--text-accent); }
.tl-lang-sep {
  font-size: 10px;
  color: var(--border-color);
  user-select: none;
}
</style>
