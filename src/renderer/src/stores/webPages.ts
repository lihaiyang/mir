import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { toPlainObject } from '../utils'
import { useProjectStore } from './projects'

export interface WebPage {
  id: string
  title: string
  url: string
  baselineTitle: string
  hasNotification: boolean
}

// Navigation bus: TitleBar writes commands, BrowserTab reads state
export interface NavBus {
  // BrowserTab → TitleBar (current state)
  url: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  // TitleBar → BrowserTab (command to execute, cleared after read)
  cmd: 'back' | 'forward' | 'reload' | 'navigate' | 'devtools' | null
  cmdUrl: string  // used when cmd === 'navigate'
}

export const standaloneNavBus = reactive<NavBus>({
  url: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  cmd: null,
  cmdUrl: ''
})

export const useWebPageStore = defineStore('webPages', () => {
  const webPages = ref<WebPage[]>([])
  const selectedWebPageId = ref<string | null>(null)

  function getProjectStore() {
    return useProjectStore()
  }

  async function load() {
    const stored = await window.electronAPI.storeGet('webPages')
    if (Array.isArray(stored)) webPages.value = stored as WebPage[]
    const sid = await window.electronAPI.storeGet('selectedWebPageId')
    if (typeof sid === 'string') selectedWebPageId.value = sid
    // Ensure all web pages are in itemOrder
    const ps = getProjectStore()
    for (const wp of webPages.value) {
      const key = 'webpage:' + wp.id
      if (!ps.itemOrder.includes(key)) {
        ps.addToOrder(key)
      }
    }
  }

  async function persist() {
    await window.electronAPI.storeSet('webPages', toPlainObject(webPages.value))
    await window.electronAPI.storeSet('selectedWebPageId', selectedWebPageId.value)
  }

  async function addWebPage(url: string, title: string) {
    const wp: WebPage = {
      id: uuidv4(),
      title,
      url,
      baselineTitle: title,
      hasNotification: false
    }
    webPages.value.push(wp)
    getProjectStore().addToOrder('webpage:' + wp.id)
    await persist()
    return wp
  }

  async function removeWebPage(id: string) {
    const idx = webPages.value.findIndex(w => w.id === id)
    if (idx === -1) return
    webPages.value.splice(idx, 1)
    if (selectedWebPageId.value === id) {
      selectedWebPageId.value = null
    }
    getProjectStore().removeFromOrder('webpage:' + id)
    await persist()
  }

  async function renameWebPage(id: string, newTitle: string) {
    const w = webPages.value.find(w => w.id === id)
    if (w) { w.title = newTitle; await persist() }
  }

  async function selectWebPage(id: string | null) {
    selectedWebPageId.value = id
    await persist()
  }

  async function markAsRead(id: string) {
    const w = webPages.value.find(w => w.id === id)
    if (w) {
      w.hasNotification = false
      await persist()
    }
  }

  async function setNotification(id: string, active: boolean) {
    const w = webPages.value.find(w => w.id === id)
    if (w) { w.hasNotification = active; await persist() }
  }

  async function updateBaselineTitle(id: string, newBaseline: string) {
    const w = webPages.value.find(w => w.id === id)
    if (w) { w.baselineTitle = newBaseline; await persist() }
  }

  return {
    webPages, selectedWebPageId,
    load, persist, addWebPage, removeWebPage,
    renameWebPage, selectWebPage, markAsRead,
    setNotification, updateBaselineTitle
  }
})
