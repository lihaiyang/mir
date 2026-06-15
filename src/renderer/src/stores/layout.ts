import { defineStore } from 'pinia'
import { ref } from 'vue'
import { debounce, toPlainObject } from '../utils'

export const useLayoutStore = defineStore('layout', () => {
  const leftWidth = ref(220)
  const rightWidth = ref(300)
  const leftCollapsed = ref(false)
  const rightCollapsed = ref(false)
  const rightActivePanel = ref<'files' | 'git' | 'search'>('files')
  const rightFileTreeExpanded = ref<Record<string, Record<string, boolean>>>({})

  async function load() {
    const stored = await window.electronAPI.storeGet('layout')
    if (stored && typeof stored === 'object') {
      const l = stored as Record<string, unknown>
      if (typeof l.leftWidth === 'number') leftWidth.value = l.leftWidth
      if (typeof l.rightWidth === 'number') rightWidth.value = l.rightWidth
      if (typeof l.leftCollapsed === 'boolean') leftCollapsed.value = l.leftCollapsed
      if (typeof l.rightCollapsed === 'boolean') rightCollapsed.value = l.rightCollapsed
      if (l.rightActivePanel === 'files' || l.rightActivePanel === 'git' || l.rightActivePanel === 'search') rightActivePanel.value = l.rightActivePanel
      if (l.rightFileTreeExpanded) rightFileTreeExpanded.value = l.rightFileTreeExpanded as Record<string, Record<string, boolean>>
    }
  }

  async function doPersist() {
    await window.electronAPI.storeSet('layout', toPlainObject({
      leftWidth: leftWidth.value,
      rightWidth: rightWidth.value,
      leftCollapsed: leftCollapsed.value,
      rightCollapsed: rightCollapsed.value,
      rightActivePanel: rightActivePanel.value,
      rightFileTreeExpanded: rightFileTreeExpanded.value
    }))
  }

  const persist = debounce(doPersist, 300)

  function setExpandedState(projectId: string, path: string, expanded: boolean) {
    if (!rightFileTreeExpanded.value[projectId]) {
      rightFileTreeExpanded.value[projectId] = {}
    }
    rightFileTreeExpanded.value[projectId][path] = expanded
    persist()
  }

  function getExpandedState(projectId: string, path: string): boolean {
    return rightFileTreeExpanded.value[projectId]?.[path] ?? false
  }

  return {
    leftWidth, rightWidth, leftCollapsed, rightCollapsed, rightActivePanel, rightFileTreeExpanded,
    load, persist, doPersist, setExpandedState, getExpandedState
  }
})
