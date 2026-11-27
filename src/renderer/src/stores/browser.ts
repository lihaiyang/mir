import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { toPlainObject } from '../utils'
import i18n from '../i18n'
import { useSettingsStore } from './settings'

export interface BrowserTabState {
  id: string
  url: string
  title: string
  favicon?: string
}

export interface BrowserProject {
  id: string
  name: string
  tabs: BrowserTabState[]
  activeTabId: string | null
}

export const NEWTAB_URL = 'mir://newtab'
export const DEFAULT_HOME_URL = 'https://www.baidu.com/'
export const PINNED_BROWSER_PROJECT_ID = 'browser-panel'
// Order key of the built-in browser panel in the left pane (itemOrder /
// pinnedOrder). It is a regular row like projects and web pages: it can be
// pinned, unpinned and sorted, it just cannot be renamed or removed.
export const BROWSER_PANEL_ORDER_KEY = 'browser:' + PINNED_BROWSER_PROJECT_ID

// Reload bus: the main process forwards Cmd/Ctrl+R (and F5) to the renderer via
// `shortcut:reload-browser`; App.vue bumps this nonce. BrowserPanel and BrowserTab
// watch it and reload themselves only when they are the active browser surface.
export const browserReloadBus = reactive({ nonce: 0 })

// Action bus for browser-level shortcuts (reload, hard-reload, back, forward,
// focus-address, find, zoom-in, zoom-out, zoom-reset).
export const browserActionBus = reactive<{ nonce: number; action: string; index?: number }>({
  nonce: 0,
  action: ''
})

function newBrowserProject(name: string): BrowserProject {
  return { id: uuidv4(), name, tabs: [], activeTabId: null }
}

export const useBrowserStore = defineStore('browser', () => {
  // All browser projects. The first one is always the pinned browser panel
  // (id = PINNED_BROWSER_PROJECT_ID), created lazily in load()/ensurePinned().
  const projects = ref<BrowserProject[]>([])
  const activeProjectId = ref<string | null>(null)
  // Kept in sync with activeProjectId; legacy code uses this boolean a lot.
  const active = ref(false)

  const activeProject = computed<BrowserProject | null>(() =>
    projects.value.find(p => p.id === activeProjectId.value) ?? null
  )

  function resolveHomeUrl(): string {
    const raw = useSettingsStore().settings.browserHomeUrl?.trim() || ''
    if (!raw) return NEWTAB_URL
    if (
      raw.startsWith('http://') ||
      raw.startsWith('https://') ||
      raw.startsWith('file://') ||
      raw === NEWTAB_URL
    ) {
      return raw
    }
    return `https://${raw}`
  }

  function ensurePinned(): BrowserProject {
    let pinned = projects.value.find(p => p.id === PINNED_BROWSER_PROJECT_ID)
    if (!pinned) {
      pinned = { id: PINNED_BROWSER_PROJECT_ID, name: i18n.global.t('browser.pinnedProject'), tabs: [], activeTabId: null }
      projects.value.unshift(pinned)
    }
    return pinned
  }

  async function load() {
    // Legacy single-browser-panel persistence -> migrate into the pinned project.
    const storedTabs = await window.electronAPI.storeGet('browserTabs')
    const legacyTabs = Array.isArray(storedTabs) ? (storedTabs as BrowserTabState[]) : []
    const atid = await window.electronAPI.storeGet('browserActiveTabId')
    const legacyActiveTabId = typeof atid === 'string' ? atid : null

    const storedProjects = await window.electronAPI.storeGet('browserProjects')
    if (Array.isArray(storedProjects) && storedProjects.length > 0) {
      projects.value = storedProjects as BrowserProject[]
      ensurePinned()
    } else {
      const pinned = ensurePinned()
      pinned.tabs = legacyTabs
      pinned.activeTabId = legacyActiveTabId ?? legacyTabs[0]?.id ?? null
    }

    const apid = await window.electronAPI.storeGet('browserActiveProjectId')
    if (typeof apid === 'string' && projects.value.some(p => p.id === apid)) {
      activeProjectId.value = apid
    } else {
      // Legacy boolean flag.
      const act = await window.electronAPI.storeGet('browserPanelActive')
      if (typeof act === 'boolean' && act) {
        activeProjectId.value = PINNED_BROWSER_PROJECT_ID
      } else {
        activeProjectId.value = null
      }
    }

    // Make sure every project has at least one tab.
    for (const p of projects.value) {
      if (p.tabs.length > 0 && !p.activeTabId) p.activeTabId = p.tabs[0].id
      if (p.tabs.length === 0) {
        const tab: BrowserTabState = { id: uuidv4(), url: resolveHomeUrl(), title: '' }
        p.tabs.push(tab)
        p.activeTabId = tab.id
      }
    }

    active.value = activeProjectId.value !== null
    await persist()
  }

  async function persist() {
    await window.electronAPI.storeSet('browserProjects', toPlainObject(projects.value))
    await window.electronAPI.storeSet('browserActiveProjectId', activeProjectId.value)
    await window.electronAPI.storeSet('browserPanelActive', active.value)
    // Keep legacy keys fresh for compatibility with old workspaces / rollbacks.
    const pinned = projects.value.find(p => p.id === PINNED_BROWSER_PROJECT_ID)
    if (pinned) {
      await window.electronAPI.storeSet('browserTabs', toPlainObject(pinned.tabs))
      await window.electronAPI.storeSet('browserActiveTabId', pinned.activeTabId)
    }
  }

  function getProject(id: string): BrowserProject | null {
    return projects.value.find(p => p.id === id) ?? null
  }

  function getTabs(id: string): BrowserTabState[] {
    return getProject(id)?.tabs ?? []
  }

  function getActiveTabId(id: string): string | null {
    return getProject(id)?.activeTabId ?? null
  }

  function getActiveTab(id: string): BrowserTabState | null {
    const p = getProject(id)
    if (!p?.activeTabId) return null
    return p.tabs.find(t => t.id === p.activeTabId) ?? null
  }

  function addProject(name?: string): BrowserProject {
    ensurePinned()
    const idx = projects.value.length
    const p = newBrowserProject(name || i18n.global.t('browser.projectName', { index: idx }))
    const tab: BrowserTabState = { id: uuidv4(), url: resolveHomeUrl(), title: '' }
    p.tabs.push(tab)
    p.activeTabId = tab.id
    projects.value.push(p)
    persist()
    return p
  }

  async function removeProject(id: string) {
    if (id === PINNED_BROWSER_PROJECT_ID) return
    const idx = projects.value.findIndex(p => p.id === id)
    if (idx === -1) return
    projects.value.splice(idx, 1)
    if (activeProjectId.value === id) {
      activeProjectId.value = null
      active.value = false
    }
    await persist()
  }

  async function renameProject(id: string, name: string) {
    const p = getProject(id)
    if (p) {
      p.name = name
      await persist()
    }
  }

  async function activateProject(id: string) {
    if (!projects.value.some(p => p.id === id)) return
    activeProjectId.value = id
    active.value = true
    await persist()
  }

  async function activate() {
    await activateProject(PINNED_BROWSER_PROJECT_ID)
  }

  async function deactivate() {
    activeProjectId.value = null
    active.value = false
    await persist()
  }

  function openTab(url?: string, projectId?: string): BrowserTabState {
    const pid = projectId ?? activeProjectId.value ?? PINNED_BROWSER_PROJECT_ID
    const p = getProject(pid) ?? ensurePinned()
    const tab: BrowserTabState = { id: uuidv4(), url: url || resolveHomeUrl(), title: '' }
    p.tabs.push(tab)
    p.activeTabId = tab.id
    persist()
    return tab
  }

  // In-memory closed-tab history per browser project (for Cmd/Ctrl+Shift+T)
  const closedTabs = ref<Record<string, Array<{ url: string; title: string; favicon?: string }>>>({})

  function pushClosedTab(pid: string, tab: BrowserTabState) {
    if (!closedTabs.value[pid]) closedTabs.value[pid] = []
    closedTabs.value[pid].push({ url: tab.url, title: tab.title, favicon: tab.favicon })
    if (closedTabs.value[pid].length > 20) {
      closedTabs.value[pid].shift()
    }
  }

  function closeTab(id: string, projectId?: string) {
    const pid = projectId ?? activeProjectId.value ?? PINNED_BROWSER_PROJECT_ID
    const p = getProject(pid)
    if (!p) return
    const idx = p.tabs.findIndex(t => t.id === id)
    if (idx === -1) return
    pushClosedTab(pid, p.tabs[idx])
    p.tabs.splice(idx, 1)
    if (p.activeTabId === id) {
      p.activeTabId = p.tabs[Math.max(0, idx - 1)]?.id ?? p.tabs[0]?.id ?? null
    }
    persist()
  }

  function reopenClosedTab(projectId?: string): BrowserTabState | null {
    const pid = projectId ?? activeProjectId.value ?? PINNED_BROWSER_PROJECT_ID
    const stack = closedTabs.value[pid]
    if (!stack || stack.length === 0) return null
    const entry = stack.pop()!
    const p = getProject(pid) ?? ensurePinned()
    const tab: BrowserTabState = {
      id: uuidv4(),
      url: entry.url || DEFAULT_HOME_URL,
      title: entry.title || '',
      favicon: entry.favicon
    }
    p.tabs.push(tab)
    p.activeTabId = tab.id
    persist()
    return tab
  }

  function duplicateTab(id: string, projectId?: string): BrowserTabState | null {
    const pid = projectId ?? activeProjectId.value ?? PINNED_BROWSER_PROJECT_ID
    const p = getProject(pid)
    if (!p) return null
    const idx = p.tabs.findIndex(t => t.id === id)
    if (idx === -1) return null
    const src = p.tabs[idx]
    const tab: BrowserTabState = {
      id: uuidv4(),
      url: src.url || DEFAULT_HOME_URL,
      title: src.title,
      favicon: src.favicon
    }
    p.tabs.splice(idx + 1, 0, tab)
    p.activeTabId = tab.id
    persist()
    return tab
  }

  function closeOtherTabs(id: string, projectId?: string) {
    const pid = projectId ?? activeProjectId.value ?? PINNED_BROWSER_PROJECT_ID
    const p = getProject(pid)
    if (!p) return
    const keep = p.tabs.find(t => t.id === id)
    if (!keep) return
    for (const t of p.tabs) {
      if (t.id !== id) pushClosedTab(pid, t)
    }
    p.tabs = [keep]
    p.activeTabId = keep.id
    persist()
  }

  function closeTabsToRight(id: string, projectId?: string) {
    const pid = projectId ?? activeProjectId.value ?? PINNED_BROWSER_PROJECT_ID
    const p = getProject(pid)
    if (!p) return
    const idx = p.tabs.findIndex(t => t.id === id)
    if (idx === -1) return
    for (let i = idx + 1; i < p.tabs.length; i++) {
      pushClosedTab(pid, p.tabs[i])
    }
    p.tabs = p.tabs.slice(0, idx + 1)
    if (!p.tabs.some(t => t.id === p.activeTabId)) {
      p.activeTabId = id
    }
    persist()
  }

  function reorderTabs(fromIndex: number, toIndex: number, projectId?: string) {
    const pid = projectId ?? activeProjectId.value ?? PINNED_BROWSER_PROJECT_ID
    const p = getProject(pid)
    if (!p) return
    if (fromIndex < 0 || fromIndex >= p.tabs.length || toIndex < 0 || toIndex >= p.tabs.length || fromIndex === toIndex) return
    const [moved] = p.tabs.splice(fromIndex, 1)
    p.tabs.splice(toIndex, 0, moved)
    persist()
  }

  function cycleTab(direction: 1 | -1, projectId?: string) {
    const pid = projectId ?? activeProjectId.value ?? PINNED_BROWSER_PROJECT_ID
    const p = getProject(pid)
    if (!p || p.tabs.length <= 1) return
    const idx = p.tabs.findIndex(t => t.id === p.activeTabId)
    const cur = idx === -1 ? 0 : idx
    const next = (cur + direction + p.tabs.length) % p.tabs.length
    p.activeTabId = p.tabs[next].id
    persist()
  }

  function switchToTabIndex(index: number, projectId?: string) {
    const pid = projectId ?? activeProjectId.value ?? PINNED_BROWSER_PROJECT_ID
    const p = getProject(pid)
    if (!p || p.tabs.length === 0) return
    const targetIdx = index < 0 ? p.tabs.length - 1 : Math.min(index, p.tabs.length - 1)
    p.activeTabId = p.tabs[targetIdx].id
    persist()
  }

  function setActiveTab(id: string, projectId?: string) {
    const pid = projectId ?? activeProjectId.value ?? PINNED_BROWSER_PROJECT_ID
    const p = getProject(pid)
    if (p && p.tabs.some(t => t.id === id)) {
      p.activeTabId = id
      persist()
    }
  }

  function updateTab(id: string, patch: Partial<BrowserTabState>, projectId?: string) {
    const pid = projectId ?? activeProjectId.value ?? PINNED_BROWSER_PROJECT_ID
    const p = getProject(pid)
    const t = p?.tabs.find(t => t.id === id)
    if (t) {
      Object.assign(t, patch)
      persist()
    }
  }

  return {
    projects, activeProjectId, active, activeProject,
    load, persist,
    getProject, getTabs, getActiveTabId, getActiveTab,
    addProject, removeProject, renameProject, activateProject, activate, deactivate,
    openTab, closeTab, reopenClosedTab, duplicateTab, closeOtherTabs, closeTabsToRight,
    reorderTabs, cycleTab, switchToTabIndex, setActiveTab, updateTab,
    ensurePinned, resolveHomeUrl
  }
})
