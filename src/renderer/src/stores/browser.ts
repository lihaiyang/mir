import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { toPlainObject } from '../utils'

export interface BrowserTabState {
  id: string
  url: string
  title: string
}

export const DEFAULT_HOME_URL = 'https://www.baidu.com/'

// Reload bus: the main process forwards Cmd/Ctrl+R (and F5) to the renderer via
// `shortcut:reload-browser`; App.vue bumps this nonce. BrowserPanel and BrowserTab
// watch it and reload themselves only when they are the active browser surface.
export const browserReloadBus = reactive({ nonce: 0 })

export const useBrowserStore = defineStore('browser', () => {
  const active = ref(false)
  const tabs = ref<BrowserTabState[]>([])
  const activeTabId = ref<string | null>(null)

  async function load() {
    const storedTabs = await window.electronAPI.storeGet('browserTabs')
    if (Array.isArray(storedTabs)) tabs.value = storedTabs as BrowserTabState[]
    const atid = await window.electronAPI.storeGet('browserActiveTabId')
    if (typeof atid === 'string') activeTabId.value = atid
    const act = await window.electronAPI.storeGet('browserPanelActive')
    if (typeof act === 'boolean') active.value = act
    if (tabs.value.length > 0 && !activeTabId.value) activeTabId.value = tabs.value[0].id
  }

  async function persist() {
    await window.electronAPI.storeSet('browserTabs', toPlainObject(tabs.value))
    await window.electronAPI.storeSet('browserActiveTabId', activeTabId.value)
    await window.electronAPI.storeSet('browserPanelActive', active.value)
  }

  function openTab(url?: string): BrowserTabState {
    const tab: BrowserTabState = { id: uuidv4(), url: url || DEFAULT_HOME_URL, title: '' }
    tabs.value.push(tab)
    activeTabId.value = tab.id
    persist()
    return tab
  }

  function closeTab(id: string) {
    const idx = tabs.value.findIndex(t => t.id === id)
    if (idx === -1) return
    tabs.value.splice(idx, 1)
    if (activeTabId.value === id) {
      activeTabId.value = tabs.value[Math.max(0, idx - 1)]?.id ?? tabs.value[0]?.id ?? null
    }
    persist()
  }

  function setActiveTab(id: string) {
    if (tabs.value.some(t => t.id === id)) {
      activeTabId.value = id
      persist()
    }
  }

  function updateTab(id: string, patch: Partial<BrowserTabState>) {
    const t = tabs.value.find(t => t.id === id)
    if (t) {
      Object.assign(t, patch)
      persist()
    }
  }

  function activate() {
    active.value = true
    persist()
  }

  function deactivate() {
    active.value = false
    persist()
  }

  return {
    active, tabs, activeTabId,
    load, persist, openTab, closeTab, setActiveTab, updateTab, activate, deactivate
  }
})
