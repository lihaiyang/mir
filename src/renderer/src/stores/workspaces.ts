import { defineStore } from 'pinia'
import { ref } from 'vue'
import { toPlainObject } from '../utils'
import { useProjectStore } from './projects'
import { useTabStore } from './tabs'
import { useWebPageStore } from './webPages'
import { useBrowserStore } from './browser'
import { useLayoutStore } from './layout'

// A workspace is a named snapshot of the full app state: projects, pane layout,
// open tabs, web pages, browser panel and sidebar/layout sizes.
export interface WorkspaceSnapshot {
  projects: ReturnType<typeof useProjectStore>['projects']
  activeProjectId: string | null
  itemOrder: string[]
  paneTrees: ReturnType<typeof useTabStore>['paneTrees']
  tabGroups: ReturnType<typeof useTabStore>['tabGroups']
  focusedGroupId: ReturnType<typeof useTabStore>['focusedGroupId']
  webPages: ReturnType<typeof useWebPageStore>['webPages']
  selectedWebPageId: string | null
  browserTabs: ReturnType<typeof useBrowserStore>['tabs']
  browserActiveTabId: string | null
  browserPanelActive: boolean
  layout: {
    leftWidth: number
    rightWidth: number
    leftCollapsed: boolean
    rightCollapsed: boolean
    rightActivePanel: string
    rightFileTreeExpanded: Record<string, Record<string, boolean>>
  }
}

export interface Workspace {
  name: string
  snapshot: WorkspaceSnapshot
  updatedAt: number
}

export const useWorkspaceStore = defineStore('workspaces', () => {
  const workspaces = ref<Record<string, Workspace>>({})
  const activeName = ref<string | null>(null)

  async function load() {
    const stored = await window.electronAPI.storeGet('workspaces')
    if (stored && typeof stored === 'object') {
      workspaces.value = stored as Record<string, Workspace>
    }
    const an = await window.electronAPI.storeGet('activeWorkspaceName')
    if (typeof an === 'string') activeName.value = an
  }

  async function persist() {
    await window.electronAPI.storeSet('workspaces', toPlainObject(workspaces.value))
    await window.electronAPI.storeSet('activeWorkspaceName', activeName.value)
  }

  function capture(): WorkspaceSnapshot {
    const projectStore = useProjectStore()
    const tabStore = useTabStore()
    const webPageStore = useWebPageStore()
    const browserStore = useBrowserStore()
    const layout = useLayoutStore()
    return {
      projects: toPlainObject(projectStore.projects),
      activeProjectId: projectStore.activeProjectId,
      itemOrder: toPlainObject(projectStore.itemOrder),
      paneTrees: toPlainObject(tabStore.paneTrees),
      tabGroups: toPlainObject(tabStore.tabGroups),
      focusedGroupId: toPlainObject(tabStore.focusedGroupId),
      webPages: toPlainObject(webPageStore.webPages),
      selectedWebPageId: webPageStore.selectedWebPageId,
      browserTabs: toPlainObject(browserStore.tabs),
      browserActiveTabId: browserStore.activeTabId,
      browserPanelActive: browserStore.active,
      layout: {
        leftWidth: layout.leftWidth,
        rightWidth: layout.rightWidth,
        leftCollapsed: layout.leftCollapsed,
        rightCollapsed: layout.rightCollapsed,
        rightActivePanel: layout.rightActivePanel,
        rightFileTreeExpanded: toPlainObject(layout.rightFileTreeExpanded)
      }
    }
  }

  async function apply(s: WorkspaceSnapshot) {
    const projectStore = useProjectStore()
    const tabStore = useTabStore()
    const webPageStore = useWebPageStore()
    const browserStore = useBrowserStore()
    const layout = useLayoutStore()

    projectStore.projects = s.projects
    projectStore.activeProjectId = s.activeProjectId
    projectStore.itemOrder = s.itemOrder
    await projectStore.persist()
    await projectStore.persistOrder()

    tabStore.paneTrees = s.paneTrees
    tabStore.tabGroups = s.tabGroups
    tabStore.focusedGroupId = s.focusedGroupId
    await tabStore.doPersist()

    webPageStore.webPages = s.webPages
    webPageStore.selectedWebPageId = s.selectedWebPageId
    await webPageStore.persist()

    browserStore.tabs = s.browserTabs
    browserStore.activeTabId = s.browserActiveTabId
    browserStore.active = s.browserPanelActive
    await browserStore.persist()

    layout.leftWidth = s.layout.leftWidth
    layout.rightWidth = s.layout.rightWidth
    layout.leftCollapsed = s.layout.leftCollapsed
    layout.rightCollapsed = s.layout.rightCollapsed
    layout.rightActivePanel = s.layout.rightActivePanel
    layout.rightFileTreeExpanded = s.layout.rightFileTreeExpanded
    await layout.doPersist()
  }

  async function saveAs(name: string) {
    workspaces.value[name] = { name, snapshot: capture(), updatedAt: Date.now() }
    activeName.value = name
    await persist()
  }

  async function switchTo(name: string) {
    const target = workspaces.value[name]
    if (!target) return
    // Switching to the already-active workspace just saves current state into it.
    if (name === activeName.value) {
      await updateActive()
      return
    }
    // Save the current state back into the workspace we're leaving (if any).
    if (activeName.value && workspaces.value[activeName.value]) {
      workspaces.value[activeName.value] = {
        ...workspaces.value[activeName.value],
        snapshot: capture(),
        updatedAt: Date.now()
      }
    }
    await apply(target.snapshot)
    activeName.value = name
    await persist()
  }

  // Persist the current state into the active workspace without switching.
  async function updateActive() {
    if (activeName.value && workspaces.value[activeName.value]) {
      workspaces.value[activeName.value] = {
        ...workspaces.value[activeName.value],
        snapshot: capture(),
        updatedAt: Date.now()
      }
      await persist()
    }
  }

  async function remove(name: string) {
    delete workspaces.value[name]
    if (activeName.value === name) activeName.value = null
    await persist()
  }

  async function rename(oldName: string, newName: string) {
    const n = newName.trim()
    if (!n || n === oldName || !workspaces.value[oldName] || workspaces.value[n]) return
    workspaces.value[n] = { ...workspaces.value[oldName], name: n }
    delete workspaces.value[oldName]
    if (activeName.value === oldName) activeName.value = n
    await persist()
  }

  return {
    workspaces, activeName,
    load, persist, capture, apply, saveAs, switchTo, updateActive, remove, rename
  }
})
