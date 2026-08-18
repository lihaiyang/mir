import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { toPlainObject } from '../utils'

export interface BrowserTabState {
  id: string
  url: string
  title: string
}

export interface BrowserProject {
  id: string
  name: string
  tabs: BrowserTabState[]
  activeTabId: string | null
}

export const DEFAULT_HOME_URL = 'https://www.baidu.com/'
export const PINNED_BROWSER_PROJECT_ID = 'browser-panel'

// Reload bus: the main process forwards Cmd/Ctrl+R (and F5) to the renderer via
// `shortcut:reload-browser`; App.vue bumps this nonce. BrowserPanel and BrowserTab
// watch it and reload themselves only when they are the active browser surface.
export const browserReloadBus = reactive({ nonce: 0 })

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

  function ensurePinned(): BrowserProject {
    let pinned = projects.value.find(p => p.id === PINNED_BROWSER_PROJECT_ID)
    if (!pinned) {
      pinned = { id: PINNED_BROWSER_PROJECT_ID, name: '浏览器', tabs: [], activeTabId: null }
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
        const tab: BrowserTabState = { id: uuidv4(), url: DEFAULT_HOME_URL, title: '' }
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
    const p = newBrowserProject(name || `浏览器 ${idx}`)
    const tab: BrowserTabState = { id: uuidv4(), url: DEFAULT_HOME_URL, title: '' }
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
    const tab: BrowserTabState = { id: uuidv4(), url: url || DEFAULT_HOME_URL, title: '' }
    p.tabs.push(tab)
    p.activeTabId = tab.id
    persist()
    return tab
  }

  function closeTab(id: string, projectId?: string) {
    const pid = projectId ?? activeProjectId.value ?? PINNED_BROWSER_PROJECT_ID
    const p = getProject(pid)
    if (!p) return
    const idx = p.tabs.findIndex(t => t.id === id)
    if (idx === -1) return
    p.tabs.splice(idx, 1)
    if (p.activeTabId === id) {
      p.activeTabId = p.tabs[Math.max(0, idx - 1)]?.id ?? p.tabs[0]?.id ?? null
    }
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
    openTab, closeTab, setActiveTab, updateTab,
    ensurePinned
  }
})
