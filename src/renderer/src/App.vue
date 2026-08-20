<template>
  <div class="app" :data-theme="settingsStore.settings.theme">
    <TitleBar />

    <div class="main-layout">
      <!-- Left pane -->
      <div class="left-pane" :style="layout.leftCollapsed ? { width: '40px' } : { width: layout.leftWidth + 'px' }">
        <LeftPane />
      </div>

      <!-- Splitter L -->
      <div class="splitter" @mousedown="startResize('left', $event)" />

      <!-- Center pane -->
      <div class="center-pane" style="flex:1;min-width:0">
        <CenterPane />
      </div>

      <!-- Splitter R -->
      <div class="splitter" @mousedown="startResize('right', $event)" />

      <!-- Right pane -->
      <div
        class="right-pane"
        :style="layout.rightCollapsed ? { width: '32px' } : { width: layout.rightWidth + 'px' }"
      >
        <RightPane />
      </div>
    </div>

    <!-- Global modals -->
     <CommandPalette v-if="showPalette" @close="showPalette = false" />
     <ContextMenuHost />
     <UpdateToast />
     <NotificationToast ref="notificationToast" />
     <QuickOpenModal v-if="showQuickOpen" @close="showQuickOpen = false" @open="openQuickOpenFile" />
     <WorkspaceModal v-if="showWorkspaces" @close="showWorkspaces = false" />
     <SettingsOverlay v-if="uiStore.overlayMode" :mode="uiStore.overlayMode" @close="uiStore.closeOverlay()" />
     <StatusBar />
   </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, provide } from 'vue'
import { matchesShortcut } from './utils'
import { useI18n } from 'vue-i18n'
import { useLayoutStore } from './stores/layout'
import { useProjectStore } from './stores/projects'
import { useSettingsStore } from './stores/settings'
import { useTabStore } from './stores/tabs'
import { useUIStore } from './stores/ui'
import { useWebPageStore } from './stores/webPages'
import { useBrowserStore, browserReloadBus, PINNED_BROWSER_PROJECT_ID } from './stores/browser'
import { useTerminalStore } from './stores/terminal'
import { useWorkspaceStore } from './stores/workspaces'
import { useRecentStore } from './stores/recent'
import { useFileMetaStore } from './stores/fileMeta'

import TitleBar from './components/TitleBar.vue'
import LeftPane from './components/left/LeftPane.vue'
import CenterPane from './components/center/CenterPane.vue'
import RightPane from './components/right/RightPane.vue'
import ContextMenuHost from './components/ContextMenuHost.vue'
import CommandPalette from './components/CommandPalette.vue'
import UpdateToast from './components/UpdateToast.vue'
import StatusBar from './components/StatusBar.vue'
import NotificationToast from './components/NotificationToast.vue'
import QuickOpenModal from './components/QuickOpenModal.vue'
import WorkspaceModal from './components/WorkspaceModal.vue'
import SettingsOverlay from './components/SettingsOverlay.vue'
import { registerCommand } from './composables/useCommandPalette'
import { openSettings, openPluginManager } from './composables/useGlobalActions'
import { initRendererPlugins } from './plugins/loader'

const { locale, t } = useI18n()
const layout = useLayoutStore()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()
const tabStore = useTabStore()
const webPageStore = useWebPageStore()
const browserStore = useBrowserStore()
const uiStore = useUIStore()
const terminalStore = useTerminalStore()
const workspaceStore = useWorkspaceStore()
const recentStore = useRecentStore()
const fileMetaStore = useFileMetaStore()

const showPalette = ref(false)
const showQuickOpen = ref(false)
const showWorkspaces = ref(false)

provide('showPalette', showPalette)

onMounted(async () => {
  await settingsStore.load()
  locale.value = settingsStore.settings.language
  await layout.load()
  await projectStore.load()
  await recentStore.load()
  await fileMetaStore.load()
  await tabStore.load()
  await webPageStore.load()
  await browserStore.load()
  syncBrowserProjectsToOrder()
  await terminalStore.load()
  await workspaceStore.load()
  pruneTerminalSessions()
  // Re-prune whenever terminal tabs change: without this, closing a terminal
  // tab leaves its scrollback session (up to 256KB) in the store — and in
  // mir-state.json — until the next app launch.
  watch(() => {
    const ids: string[] = []
    for (const p of projectStore.projects) {
      for (const t of tabStore.getAllTabs(p.id)) {
        if (t.type === 'terminal') ids.push(t.id)
      }
    }
    return ids.join(',')
  }, () => { pruneTerminalSessions() })
  await seedDefaults()
  settingsStore.applyTheme()
  window.electronAPI.setAutoUpdate(settingsStore.settings.autoUpdate).catch(() => {})
  window.electronAPI.onReloadBrowser(() => { browserReloadBus.nonce++ })
  window.electronAPI.onWebviewNewWindow(handleWebviewNewWindow)
  setupShortcuts()
  registerBuiltinCommands()
  await initRendererPlugins()

  // All stores loaded: notify status bar to initialize from current active tab
  window.dispatchEvent(new CustomEvent('statusbar-init'))

  watch(() => settingsStore.settings.language, (lang) => {
    locale.value = lang
  })

  watch(() => settingsStore.settings.shortcuts, () => {
    registerBuiltinCommands()
  }, { deep: true })

  watch(() => projectStore.activeProject, (p) => {
    if (p) {
      recentStore.touchProject(p.id, p.name, p.path)
      loadGitStatusForStatusBar(p.path)
    }
  })

  window.addEventListener('mir-notification', onMirNotification)

  // Load git status immediately if a project is already active on startup
  if (projectStore.activeProject) {
    loadGitStatusForStatusBar(projectStore.activeProject.path)
  }

  // Flush any pending debounced persists when window is closing
  window.addEventListener('beforeunload', () => {
    layout.doPersist()
    tabStore.doPersist()
    terminalStore.persistNow()
  })

  // Listen for editor asking to open the global command palette
  window.addEventListener('open-command-palette', onOpenCommandPalette)
})

// Splitter drag
let resizing: 'left' | 'right' | null = null
let startX = 0
let startVal = 0

function startResize(side: 'left' | 'right', e: MouseEvent) {
  resizing = side
  startX = e.clientX
  startVal = side === 'left' ? layout.leftWidth : layout.rightWidth
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function onMouseMove(e: MouseEvent) {
  if (!resizing) return
  const delta = e.clientX - startX
  if (resizing === 'left') {
    layout.leftWidth = Math.max(150, Math.min(400, startVal + delta))
  } else {
    layout.rightWidth = Math.max(240, Math.min(600, startVal - delta))
  }
}

function onMouseUp() {
  resizing = null
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  layout.persist()
}

// Make sure every user-created browser project is part of the sortable
// left-pane item order (pinned panel is excluded — it has a fixed entry).
function syncBrowserProjectsToOrder() {
  for (const bp of browserStore.projects) {
    if (bp.id === PINNED_BROWSER_PROJECT_ID) continue
    const key = 'browser:' + bp.id
    if (!projectStore.itemOrder.includes(key)) {
      projectStore.addToOrder(key)
    }
  }
}

// First-run defaults: a home-directory project + a default browser tab.
async function seedDefaults() {
  if (projectStore.projects.length === 0) {
    const home = await window.electronAPI.getPath('home')
    if (home) {
      const p = await projectStore.addProject(home)
      await projectStore.renameProject(p.id, t('leftPane.homeProject'))
    }
  }
  if (browserStore.getTabs(PINNED_BROWSER_PROJECT_ID).length === 0) {
    browserStore.openTab(undefined, PINNED_BROWSER_PROJECT_ID)
  }
}

// Drop terminal sessions whose terminal tab no longer exists (closed tabs).
function pruneTerminalSessions() {
  const ids = new Set<string>()
  for (const p of projectStore.projects) {
    for (const t of tabStore.getAllTabs(p.id)) {
      if (t.type === 'terminal') ids.add(t.id)
    }
  }
  terminalStore.prune(ids)
}

// A link inside an embedded page requested a new window (target=_blank /
// window.open). Open it as a new tab in the appropriate browser surface.
function handleWebviewNewWindow(url: string) {
  if (!url || url === 'about:blank') return
  if (browserStore.active) {
    browserStore.openTab(url, browserStore.activeProjectId ?? PINNED_BROWSER_PROJECT_ID)
  } else if (webPageStore.selectedWebPageId) {
    // From a standalone web page bookmark → open in the fixed browser panel
    browserStore.openTab(url, PINNED_BROWSER_PROJECT_ID)
    browserStore.activate()
    projectStore.setActiveProject(null)
    webPageStore.selectWebPage(null)
  } else if (projectStore.activeProject) {
    tabStore.addTab(projectStore.activeProject.id, 'browser', { title: '', browserUrl: url })
  }
}

function registerBuiltinCommands() {
  const s = settingsStore.settings.shortcuts
  registerCommand({
    id: 'mir.settings',
    label: t('commandPalette.openSettings'),
    group: 'Preferences',
    icon: 'settings',
    keybinding: s.settings,
    run: () => { openSettings() }
  })
  registerCommand({
    id: 'mir.plugins',
    label: t('plugins.manage'),
    group: 'Preferences',
    icon: 'plugin',
    run: () => { openPluginManager() }
  })
  registerCommand({
    id: 'editor.toggleWordWrap',
    label: t('commandPalette.toggleWordWrap'),
    group: 'Editor',
    icon: 'file-text',
    run: () => {
      const cur = settingsStore.settings.editorWordWrap
      settingsStore.update({ editorWordWrap: cur === 'off' ? 'on' : 'off' })
    }
  })
  registerCommand({
    id: 'mir.quickOpen',
    label: t('commandPalette.quickOpen'),
    group: 'File',
    icon: 'file',
    keybinding: 'Ctrl+P',
    run: () => { showQuickOpen.value = true }
  })
  registerCommand({
    id: 'mir.search',
    label: t('commandPalette.search'),
    group: 'View',
    icon: 'search',
    keybinding: 'Ctrl+Shift+F',
    run: () => { layout.rightActivePanel = 'search'; layout.rightCollapsed = false; layout.persist() }
  })
  registerCommand({
    id: 'mir.toggleRightPanel',
    label: t('commandPalette.toggleRightPanel'),
    group: 'View',
    icon: 'panel-right',
    keybinding: 'Ctrl+B',
    run: () => { layout.rightCollapsed = !layout.rightCollapsed; layout.persist() }
  })
  registerCommand({
    id: 'mir.reopenClosedTab',
    label: t('commandPalette.reopenClosedTab'),
    group: 'File',
    icon: 'rotate',
    keybinding: 'Ctrl+Shift+T',
    run: () => { reopenLastClosedTab() }
  })
  registerCommand({
    id: 'mir.newTerminal',
    label: t('commandPalette.newTerminal'),
    group: 'Terminal',
    icon: 'terminal',
    keybinding: s.newTab,
    run: () => {
      if (projectStore.activeProject) tabStore.addTab(projectStore.activeProject.id, 'terminal')
    }
  })
  registerCommand({
    id: 'mir.toggleFiles',
    label: t('commandPalette.toggleFiles'),
    group: 'View',
    icon: 'folder',
    run: () => { layout.rightActivePanel = 'files'; layout.rightCollapsed = false; layout.persist() }
  })
  registerCommand({
    id: 'mir.toggleGit',
    label: t('commandPalette.toggleGit'),
    group: 'View',
    icon: 'git-branch',
    run: () => { layout.rightActivePanel = 'git'; layout.rightCollapsed = false; layout.persist() }
  })
  registerCommand({
    id: 'mir.togglePanelIcons',
    label: t('commandPalette.togglePanelIcons'),
    group: 'View',
    icon: 'columns',
    run: () => {
      settingsStore.update({ showPanelIcons: !settingsStore.settings.showPanelIcons })
    }
  })
  registerCommand({
    id: 'mir.workspaces',
    label: t('workspace.title'),
    group: 'View',
    icon: 'layout',
    run: () => { showWorkspaces.value = true }
  })
}

function onOpenCommandPalette() {
  showPalette.value = true
}

function openQuickOpenFile(filePath: string) {
  if (!projectStore.activeProject) return
  const pid = projectStore.activeProject.id
  const fileName = filePath.split('/').pop() || filePath
  const existing = tabStore.getProjectTabs(pid).find(tt => tt.type === 'file' && tt.filePath === filePath)
  if (existing) {
    tabStore.setActiveTab(pid, existing.id)
  } else {
    tabStore.addTab(pid, 'file', { title: fileName, filePath })
  }
  recentStore.touchFile(filePath, pid)
}

function setupShortcuts() {
  window.addEventListener('keydown', handleGlobalKey)
}

function handleGlobalKey(e: KeyboardEvent) {
  const s = settingsStore.settings.shortcuts

  if (matchesShortcut(e, s.settings)) { e.preventDefault(); openSettings(); return }
  if (matchesShortcut(e, s.commandPalette)) { e.preventDefault(); showPalette.value = true; return }
  if (matchesShortcut(e, s.find)) { e.preventDefault(); dispatchEditorAction('editor-find'); return }
  if (matchesShortcut(e, s.save)) { e.preventDefault(); dispatchEditorAction('editor-save'); return }

  // Hardcoded global shortcuts not yet exposed in settings
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.shiftKey && e.key === 'F') { e.preventDefault(); layout.rightActivePanel = 'search'; layout.rightCollapsed = false; layout.persist(); return }
  if (mod && e.key === 'p') { e.preventDefault(); showQuickOpen.value = true; return }
  if (mod && e.shiftKey && e.key === 'T') { e.preventDefault(); reopenLastClosedTab(); return }
  if (mod && e.key === 'b') { e.preventDefault(); layout.rightCollapsed = !layout.rightCollapsed; layout.persist(); return }
}

function dispatchEditorAction(eventName: string) {
  const pid = projectStore.activeProjectId
  if (!pid) return
  const gid = tabStore.getFocusedGroupId(pid)
  if (!gid) return
  const tid = tabStore.getGroupActiveTabId(pid, gid)
  if (!tid) return
  window.dispatchEvent(new CustomEvent(eventName, { detail: { projectId: pid, groupId: gid, tabId: tid } }))
}

function reopenLastClosedTab() {
  const item = recentStore.popClosedTab()
  if (!item) return
  const pid = item.projectId
  const tab = item.tab
  if (tab.filePath) {
    tabStore.addTab(pid, 'file', { title: tab.title, filePath: tab.filePath })
  } else if (tab.terminalCwd !== undefined) {
    tabStore.addTab(pid, 'terminal', { title: tab.title, terminalCwd: tab.terminalCwd })
  } else if (tab.browserUrl) {
    tabStore.addTab(pid, 'browser', { title: tab.title, browserUrl: tab.browserUrl })
  }
}

const notificationToast = ref<InstanceType<typeof NotificationToast> | null>(null)

function onMirNotification(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.type && detail?.text) {
    notificationToast.value?.show(detail.type, detail.text, detail.duration)
  }
}

async function loadGitStatusForStatusBar(projectPath: string) {
  try {
    const s = await window.electronAPI.gitStatus(projectPath) as { branch: string; ahead: number; behind: number } | null
    if (s) {
      window.dispatchEvent(new CustomEvent('statusbar-git', { detail: { branch: s.branch, ahead: s.ahead ?? 0, behind: s.behind ?? 0 } }))
    }
  } catch { /* ignore */ }
}

let gitStatusInterval: ReturnType<typeof setInterval> | null = null
function startGitStatusPolling() {
  if (gitStatusInterval) clearInterval(gitStatusInterval)
  gitStatusInterval = setInterval(() => {
    const p = projectStore.activeProject
    if (p) loadGitStatusForStatusBar(p.path)
  }, 10000)
}
startGitStatusPolling()

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKey)
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('open-command-palette', onOpenCommandPalette)
  window.removeEventListener('mir-notification', onMirNotification)
})
</script>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-primary);
  color: var(--text-primary);
}
.main-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.left-pane {
  flex-shrink: 0;
  overflow: hidden;
  border-right: 1px solid var(--border-color);
  transition: width var(--transition-base) var(--ease-out);
}
.right-pane {
  flex-shrink: 0;
  overflow: hidden;
  border-left: 1px solid var(--border-color);
  transition: width var(--transition-base) var(--ease-out);
}
/* Drag hot-zone only: the visible divider is the 1px panel border, so the
   line stays uniform and aligned with the titlebar splitters. The hot-zone
   turns into a subtle accent glow while dragging/hovering. */
.splitter {
  width: 3px;
  margin: 0 -1px;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
  transition: background var(--transition-fast) ease;
}
.splitter:hover,
.splitter.dragging {
  background: rgba(76, 194, 255, 0.35);
}
</style>

<style>
/* During host-level drag-and-drop (left-pane item reorder), make every
   <webview> click-through. A webview runs in its own renderer process and,
   when the cursor enters it mid-drag, it steals the drag so the host never
   receives `dragend`. That leaves the Chromium drag session stuck, after
   which NO new drag can start — breaking folder and webpage reordering alike. */
body.mir-dragging webview {
  pointer-events: none !important;
}
</style>
