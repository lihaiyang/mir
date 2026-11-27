<template>
  <div class="app" :data-theme="settingsStore.settings.theme">
    <TitleBar />

    <div class="main-layout">
      <!-- Left pane (collapses completely; toggle lives in TitleBar like Antigravity/Codex) -->
      <div v-show="!layout.leftCollapsed" class="left-pane" :style="{ width: layout.leftWidth + 'px' }">
        <LeftPane />
      </div>

      <!-- Splitter L -->
      <div v-show="!layout.leftCollapsed" class="splitter" :class="{ dragging: draggingSide === 'left' }" @mousedown="startResize('left', $event)" />

      <!-- Center pane -->
      <div class="center-pane" style="flex:1;min-width:0">
        <CenterPane />
      </div>

      <!-- Splitter R -->
      <div v-show="!layout.rightCollapsed" class="splitter" :class="{ dragging: draggingSide === 'right' }" @mousedown="startResize('right', $event)" />

      <!-- Right pane (collapses completely; toggle lives in TitleBar) -->
      <div
        v-show="!layout.rightCollapsed"
        class="right-pane"
        :style="{ width: layout.rightWidth + 'px' }"
      >
        <RightPane />
      </div>
    </div>

    <!-- Global modals -->
     <CommandPalette v-if="showPalette" @close="showPalette = false" />
     <ContextMenuHost />
     <ToastHost>
       <UpdateToast />
       <NotificationToast ref="notificationToast" />
     </ToastHost>
     <QuickOpenModal v-if="showQuickOpen" @close="showQuickOpen = false" @open="openQuickOpenFile" />
     <WorkspaceModal v-if="showWorkspaces" @close="showWorkspaces = false" />
     <SettingsOverlay v-if="uiStore.overlayMode" :mode="uiStore.overlayMode" @close="uiStore.closeOverlay()" />
     <StatusBar />
   </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, provide } from 'vue'
import { matchesShortcut } from './utils'
import { startDragShield, endDragShield } from './utils/dragShield'
import { useI18n } from 'vue-i18n'
import { useLayoutStore } from './stores/layout'
import { useProjectStore } from './stores/projects'
import { useSettingsStore } from './stores/settings'
import { useTabStore } from './stores/tabs'
import { useUIStore } from './stores/ui'
import { useWebPageStore } from './stores/webPages'
import { useBrowserStore, browserReloadBus, browserActionBus, PINNED_BROWSER_PROJECT_ID } from './stores/browser'
import { useBookmarkStore } from './stores/bookmarks'
import { useTerminalStore } from './stores/terminal'
import { useWorkspaceStore } from './stores/workspaces'
import { useRecentStore } from './stores/recent'
import { useFileMetaStore } from './stores/fileMeta'
import { useAcpStore } from './stores/acp'

import TitleBar from './components/TitleBar.vue'
import LeftPane from './components/left/LeftPane.vue'
import CenterPane from './components/center/CenterPane.vue'
import RightPane from './components/right/RightPane.vue'
import ContextMenuHost from './components/ContextMenuHost.vue'
import CommandPalette from './components/CommandPalette.vue'
import UpdateToast from './components/UpdateToast.vue'
import StatusBar from './components/StatusBar.vue'
import NotificationToast from './components/NotificationToast.vue'
import ToastHost from './components/ui/ToastHost.vue'
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
const bookmarkStore = useBookmarkStore()
const uiStore = useUIStore()
const terminalStore = useTerminalStore()
const workspaceStore = useWorkspaceStore()
const recentStore = useRecentStore()
const fileMetaStore = useFileMetaStore()
const acpStore = useAcpStore()

const showPalette = ref(false)
const showQuickOpen = ref(false)
const showWorkspaces = ref(false)

provide('showPalette', showPalette)

const unsubs: Array<() => void> = []

function onBeforeUnload() {
  layout.doPersist()
  tabStore.doPersist()
  terminalStore.persistNow()
}

function onWindowFocus() {
  const p = projectStore.activeProject
  if (p && !(!layout.rightCollapsed && layout.rightActivePanel === 'git')) {
    loadGitStatusForStatusBar(p.path)
  }
}

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
  await bookmarkStore.load()
  syncBrowserProjectsToOrder()
  await terminalStore.load()
  await workspaceStore.load()
  pruneTerminalSessions()
  await seedDefaults()
  settingsStore.applyTheme()
  window.electronAPI.setAutoUpdate(settingsStore.settings.autoUpdate).catch(() => {})
  unsubs.push(window.electronAPI.onReloadBrowser(() => { browserReloadBus.nonce++ }))
  unsubs.push(window.electronAPI.onBrowserAction(handleBrowserAction))
  unsubs.push(window.electronAPI.onWebviewNewWindow(handleWebviewNewWindow))
  setupShortcuts()
  registerBuiltinCommands()
  await initRendererPlugins()

  // ACP agents/sessions: subscribes to main-process events and restores the
  // live state. Runs after the tab store loaded because session title updates
  // are mirrored onto the matching chat tab.
  void acpStore.init()

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
  window.addEventListener('focus', onWindowFocus)

  // Load git status immediately if a project is already active on startup
  if (projectStore.activeProject) {
    loadGitStatusForStatusBar(projectStore.activeProject.path)
  }

  // Flush any pending debounced persists when window is closing
  window.addEventListener('beforeunload', onBeforeUnload)

  // Listen for editor asking to open the global command palette
  window.addEventListener('open-command-palette', onOpenCommandPalette)
})

// Splitter drag.
// A gesture that travels towards the centre pane passes over the browser
// panes' <webview> guests, which would otherwise swallow the mousemove stream
// (the splitter then only moved away from the browser, never towards it), so
// the drag runs behind a host-DOM shield — see utils/dragShield.ts.
let resizing: 'left' | 'right' | null = null
let startX = 0
let startVal = 0
const draggingSide = ref<'left' | 'right' | null>(null)

function startResize(side: 'left' | 'right', e: MouseEvent) {
  resizing = side
  draggingSide.value = side
  startX = e.clientX
  startVal = side === 'left' ? layout.leftWidth : layout.rightWidth
  window.addEventListener('mousemove', onMouseMove)
  startDragShield({ cursor: 'col-resize', onEnd: stopResize })
}

function onMouseMove(e: MouseEvent) {
  if (!resizing) return
  const delta = e.clientX - startX
  if (resizing === 'left') {
    layout.leftWidth = Math.max(180, Math.min(460, startVal + delta))
  } else {
    layout.rightWidth = Math.max(300, Math.min(700, startVal - delta))
  }
}

// Runs once per gesture, whether the release lands on the splitter, on pane
// content, on a webview or outside the window entirely.
function stopResize() {
  if (!resizing) return
  resizing = null
  draggingSide.value = null
  window.removeEventListener('mousemove', onMouseMove)
  layout.persist()
}

// Make sure every browser project — including the built-in panel, which is a
// regular sortable left-pane row now — is part of the item order.
function syncBrowserProjectsToOrder() {
  for (const bp of browserStore.projects) {
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

function dispatchBrowserAction(action: string, index?: number) {
  browserActionBus.action = action
  browserActionBus.index = index
  browserActionBus.nonce++
}

function handleBrowserAction(payload: { action: string; index?: number }) {
  const { action, index } = payload
  const isBrowserActive = browserStore.active && !!browserStore.activeProjectId

  if (action === 'close-tab') {
    if (isBrowserActive) {
      const bpid = browserStore.activeProjectId!
      const activeTabId = browserStore.getActiveTabId(bpid)
      if (activeTabId) browserStore.closeTab(activeTabId, bpid)
      return
    }
    const pid = projectStore.activeProjectId
    if (!pid) return
    const fgId = tabStore.getFocusedGroupId(pid)
    if (!fgId) return
    const activeTab = tabStore.getGroupActiveTab(pid, fgId)
    if (activeTab) {
      if (activeTab.modified && !confirm(t('editor.unsavedCloseConfirm', { name: activeTab.title }))) return
      tabStore.closeTab(pid, activeTab.id)
    }
    return
  }

  if (action === 'new-tab') {
    if (isBrowserActive) {
      const bpid = browserStore.activeProjectId!
      browserStore.openTab(undefined, bpid)
      dispatchBrowserAction('focus-address')
      return
    }
    if (projectStore.activeProjectId) {
      tabStore.addTab(projectStore.activeProjectId, 'terminal')
    }
    return
  }

  if (action === 'reopen-tab') {
    if (isBrowserActive) {
      browserStore.reopenClosedTab(browserStore.activeProjectId!)
    } else {
      reopenLastClosedTab()
    }
    return
  }

  if (action === 'next-tab' || action === 'prev-tab') {
    const dir = action === 'next-tab' ? 1 : -1
    if (isBrowserActive) {
      browserStore.cycleTab(dir, browserStore.activeProjectId!)
      return
    }
    const pid = projectStore.activeProjectId
    if (!pid) return
    const fgId = tabStore.getFocusedGroupId(pid)
    if (!fgId) return
    const tabs = tabStore.getGroupTabs(pid, fgId)
    const activeId = tabStore.getGroupActiveTabId(pid, fgId)
    const idx = tabs.findIndex(tab => tab.id === activeId)
    if (idx !== -1 && tabs.length > 1) {
      const next = (idx + dir + tabs.length) % tabs.length
      if (tabs[next]) tabStore.setActiveTab(pid, tabs[next].id)
    }
    return
  }

  if (action === 'switch-tab' || action === 'switch-tab-last') {
    if (isBrowserActive) {
      browserStore.switchToTabIndex(action === 'switch-tab-last' ? -1 : (index ?? 0), browserStore.activeProjectId!)
    }
    return
  }

  if (action === 'toggle-bookmarks-bar') {
    void settingsStore.update({ showBookmarksBar: !settingsStore.settings.showBookmarksBar })
    return
  }

  dispatchBrowserAction(action, index)
}

function handleGlobalKey(e: KeyboardEvent) {
  const s = settingsStore.settings.shortcuts

  if (matchesShortcut(e, s.settings)) { e.preventDefault(); openSettings(); return }
  if (matchesShortcut(e, s.commandPalette)) { e.preventDefault(); showPalette.value = true; return }

  const mod = e.ctrlKey || e.metaKey
  if (browserStore.active && browserStore.activeProjectId) {
    const k = e.key.toLowerCase()
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
      e.preventDefault()
      handleBrowserAction({ action: e.shiftKey ? 'prev-tab' : 'next-tab' })
      return
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      handleBrowserAction({ action: e.key === 'ArrowLeft' ? 'back' : 'forward' })
      return
    }
    if (mod && !e.altKey) {
      if (k === 't') { e.preventDefault(); handleBrowserAction({ action: e.shiftKey ? 'reopen-tab' : 'new-tab' }); return }
      if (k === 'l' && !e.shiftKey) { e.preventDefault(); handleBrowserAction({ action: 'focus-address' }); return }
      if (k === 'f' && !e.shiftKey) { e.preventDefault(); handleBrowserAction({ action: 'find' }); return }
      if (k === 'd' && !e.shiftKey) { e.preventDefault(); handleBrowserAction({ action: 'bookmark' }); return }
      if (k === 'b' && e.shiftKey) { e.preventDefault(); handleBrowserAction({ action: 'toggle-bookmarks-bar' }); return }
      if (e.key === '[' && !e.shiftKey) { e.preventDefault(); handleBrowserAction({ action: 'back' }); return }
      if (e.key === ']' && !e.shiftKey) { e.preventDefault(); handleBrowserAction({ action: 'forward' }); return }
      if (!e.shiftKey && e.key >= '1' && e.key <= '8') { e.preventDefault(); handleBrowserAction({ action: 'switch-tab', index: Number(e.key) - 1 }); return }
      if (!e.shiftKey && e.key === '9') { e.preventDefault(); handleBrowserAction({ action: 'switch-tab-last' }); return }
      if (e.key === '=' || e.key === '+') { e.preventDefault(); handleBrowserAction({ action: 'zoom-in' }); return }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); handleBrowserAction({ action: 'zoom-out' }); return }
      if (e.key === '0' && !e.shiftKey) { e.preventDefault(); handleBrowserAction({ action: 'zoom-reset' }); return }
    }
  }

  if (matchesShortcut(e, s.find)) { e.preventDefault(); dispatchEditorAction('editor-find'); return }
  if (matchesShortcut(e, s.save)) { e.preventDefault(); dispatchEditorAction('editor-save'); return }

  // Hardcoded global shortcuts not yet exposed in settings
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
    const s = await window.electronAPI.gitStatus(projectPath)
    if (s) {
      window.dispatchEvent(new CustomEvent('statusbar-git', { detail: { branch: s.branch, ahead: s.ahead ?? 0, behind: s.behind ?? 0 } }))
    } else {
      window.dispatchEvent(new CustomEvent('statusbar-git', { detail: { branch: null, ahead: 0, behind: 0 } }))
    }
  } catch { /* ignore */ }
}

let gitStatusInterval: ReturnType<typeof setInterval> | null = null
function startGitStatusPolling() {
  if (gitStatusInterval) clearInterval(gitStatusInterval)
  gitStatusInterval = setInterval(() => {
    if (document.hidden) return
    if (!layout.rightCollapsed && layout.rightActivePanel === 'git') return
    const p = projectStore.activeProject
    if (p) loadGitStatusForStatusBar(p.path)
  }, 10000)
}
startGitStatusPolling()

onUnmounted(() => {
  if (gitStatusInterval) {
    clearInterval(gitStatusInterval)
    gitStatusInterval = null
  }
  for (const off of unsubs) off()
  unsubs.length = 0
  window.removeEventListener('keydown', handleGlobalKey)
  window.removeEventListener('mousemove', onMouseMove)
  endDragShield()
  window.removeEventListener('open-command-palette', onOpenCommandPalette)
  window.removeEventListener('mir-notification', onMirNotification)
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-sunken, var(--bg-secondary));
  color: var(--text-primary);
}
.main-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 0 8px 6px;
}
.left-pane,
.center-pane,
.right-pane {
  border-radius: var(--radius-lg, 12px);
  overflow: hidden;
  background: var(--bg-primary);
  border: 1px solid var(--border-hairline);
  box-shadow: var(--shadow-1);
}
.left-pane {
  flex-shrink: 0;
  background: var(--bg-secondary);
}
.right-pane {
  flex-shrink: 0;
  background: var(--bg-secondary);
}
/* Floating-island gap acts as the resize handle: subtle hairline pill at rest, accented on hover/drag. */
.splitter {
  position: relative;
  width: 8px;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
}
.splitter::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  height: 24px;
  border-radius: 999px;
  background: var(--border-hairline);
  transition: background var(--transition-fast) ease, height var(--transition-fast) ease;
}
.splitter:hover::after,
.splitter.dragging::after {
  background: var(--accent-strong);
  height: 56px;
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

/* Splitter drags (left/right panes, title bar, pane splits) run behind a
   transparent shield that lives in the host document above every pane. A
   <webview> guest takes over hit-testing the moment the cursor enters it, so
   without the shield the gesture died whenever it moved towards a browser
   pane. `mir-resizing` keeps the guests click-through on top of that. */
.mir-drag-shield {
  position: fixed;
  inset: 0;
  z-index: 9000;
  background: transparent;
}
body.mir-resizing webview {
  pointer-events: none !important;
}
</style>
