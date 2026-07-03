import { defineStore } from 'pinia'
import { ref } from 'vue'
import { toPlainObject } from '../utils'

export interface RecentProject {
  id: string
  name: string
  path: string
  lastOpened: number
}

export interface RecentFile {
  path: string
  projectId: string
  lastOpened: number
}

export interface ClosedTab {
  tab: {
    type: string
    title: string
    terminalCwd?: string
    browserUrl?: string
    filePath?: string
  }
  projectId: string
  closedAt: number
}

const MAX_RECENT_PROJECTS = 10
const MAX_RECENT_FILES = 30
const MAX_CLOSED_TABS = 20

export const useRecentStore = defineStore('recent', () => {
  const recentProjects = ref<RecentProject[]>([])
  const recentFiles = ref<RecentFile[]>([])
  const closedTabs = ref<ClosedTab[]>([])

  async function load() {
    const storedProjects = await window.electronAPI.storeGet('recentProjects')
    if (Array.isArray(storedProjects)) recentProjects.value = storedProjects
    const storedFiles = await window.electronAPI.storeGet('recentFiles')
    if (Array.isArray(storedFiles)) recentFiles.value = storedFiles
    const storedClosed = await window.electronAPI.storeGet('recentClosedTabs')
    if (Array.isArray(storedClosed)) closedTabs.value = storedClosed
  }

  async function persistProjects() {
    await window.electronAPI.storeSet('recentProjects', toPlainObject(recentProjects.value))
  }

  async function persistFiles() {
    await window.electronAPI.storeSet('recentFiles', toPlainObject(recentFiles.value))
  }

  async function persistClosed() {
    await window.electronAPI.storeSet('recentClosedTabs', toPlainObject(closedTabs.value))
  }

  function touchProject(id: string, name: string, path: string) {
    recentProjects.value = recentProjects.value.filter(p => p.id !== id)
    recentProjects.value.unshift({ id, name, path, lastOpened: Date.now() })
    if (recentProjects.value.length > MAX_RECENT_PROJECTS) {
      recentProjects.value = recentProjects.value.slice(0, MAX_RECENT_PROJECTS)
    }
    persistProjects()
  }

  function touchFile(path: string, projectId: string) {
    recentFiles.value = recentFiles.value.filter(f => !(f.path === path && f.projectId === projectId))
    recentFiles.value.unshift({ path, projectId, lastOpened: Date.now() })
    if (recentFiles.value.length > MAX_RECENT_FILES) {
      recentFiles.value = recentFiles.value.slice(0, MAX_RECENT_FILES)
    }
    persistFiles()
  }

  function tabClosed(tab: { type: string; title: string; terminalCwd?: string; browserUrl?: string; filePath?: string }, projectId: string) {
    closedTabs.value.unshift({ tab, projectId, closedAt: Date.now() })
    if (closedTabs.value.length > MAX_CLOSED_TABS) {
      closedTabs.value = closedTabs.value.slice(0, MAX_CLOSED_TABS)
    }
    persistClosed()
  }

  function popClosedTab(): ClosedTab | undefined {
    const item = closedTabs.value.shift()
    persistClosed()
    return item
  }

  async function clearRecentFiles() {
    recentFiles.value = []
    await persistFiles()
  }

  async function removeRecentProject(id: string) {
    recentProjects.value = recentProjects.value.filter(p => p.id !== id)
    await persistProjects()
  }

  return {
    recentProjects,
    recentFiles,
    closedTabs,
    load,
    touchProject,
    touchFile,
    tabClosed,
    popClosedTab,
    clearRecentFiles,
    removeRecentProject,
  }
})
