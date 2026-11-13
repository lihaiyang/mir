import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { toPlainObject } from '../utils'
import { useTabStore } from './tabs'
import { BROWSER_PANEL_ORDER_KEY } from './browser'

export interface Project {
  id: string
  name: string
  path: string
  agentCommands?: AgentCommand[]
}

export interface AgentCommand {
  id: string
  name: string
  command: string
  description?: string
}

export const useProjectStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const activeProjectId = ref<string | null>(null)
  const itemOrder = ref<string[]>([])
  // Keys pinned to the top of the left pane, in their own display order.
  // `itemOrder` stays the full flat order (used for the unpinned list and for
  // workspace snapshots); pinned keys simply get rendered in a group above.
  const pinnedOrder = ref<string[]>([])

  const activeProject = computed(() =>
    projects.value.find(p => p.id === activeProjectId.value) ?? null
  )

  async function load() {
    const stored = await window.electronAPI.storeGet('projects')
    if (Array.isArray(stored)) projects.value = stored as Project[]
    const aid = await window.electronAPI.storeGet('activeProjectId')
    if (typeof aid === 'string') activeProjectId.value = aid
    const order = await window.electronAPI.storeGet('itemOrder')
    if (Array.isArray(order) && order.length > 0) {
      itemOrder.value = order as string[]
    } else {
      // Migrate: populate itemOrder from existing projects
      itemOrder.value = projects.value.map(p => 'project:' + p.id)
    }
    const pinned = await window.electronAPI.storeGet('pinnedOrder')
    if (Array.isArray(pinned)) {
      pinnedOrder.value = [
        ...new Set(pinned.filter((k): k is string => typeof k === 'string'))
      ]
    }
    // The built-in browser panel used to sit in a fixed entry outside
    // itemOrder. It is a normal sortable row now: seed it once so existing
    // users still find it at the top. The flag keeps a later user-chosen
    // unpin from being undone on the next launch.
    const panelMigrated = await window.electronAPI.storeGet('browserPanelPinnedMigrated')
    if (panelMigrated !== true) {
      if (!itemOrder.value.includes(BROWSER_PANEL_ORDER_KEY)) {
        itemOrder.value.unshift(BROWSER_PANEL_ORDER_KEY)
      }
      if (!pinnedOrder.value.includes(BROWSER_PANEL_ORDER_KEY)) {
        pinnedOrder.value.unshift(BROWSER_PANEL_ORDER_KEY)
      }
      await persistOrder()
      await persistPinned()
      await window.electronAPI.storeSet('browserPanelPinnedMigrated', true)
    } else if (!itemOrder.value.includes(BROWSER_PANEL_ORDER_KEY)) {
      // Safety net: the panel must always have an order slot, otherwise it
      // would vanish from the left pane.
      itemOrder.value.unshift(BROWSER_PANEL_ORDER_KEY)
      await persistOrder()
    }
  }

  async function persist() {
    await window.electronAPI.storeSet('projects', toPlainObject(projects.value))
    await window.electronAPI.storeSet('activeProjectId', activeProjectId.value)
  }

  async function persistOrder() {
    await window.electronAPI.storeSet('itemOrder', toPlainObject(itemOrder.value))
  }

  async function persistPinned() {
    await window.electronAPI.storeSet('pinnedOrder', toPlainObject(pinnedOrder.value))
  }

  function isPinned(key: string): boolean {
    return pinnedOrder.value.includes(key)
  }

  // Pin an existing item to the very top of the pinned group (above the
  // browser panel too), matching the "固定到顶部" label. The item keeps its
  // itemOrder slot, so unpinning restores its old position in the normal list.
  async function pinItem(key: string) {
    if (!itemOrder.value.includes(key) || pinnedOrder.value.includes(key)) return
    pinnedOrder.value.unshift(key)
    await persistPinned()
  }

  async function unpinItem(key: string) {
    const idx = pinnedOrder.value.indexOf(key)
    if (idx === -1) return
    pinnedOrder.value.splice(idx, 1)
    await persistPinned()
  }

  async function togglePin(key: string) {
    if (isPinned(key)) await unpinItem(key)
    else await pinItem(key)
  }

  // Reorder inside the pinned group. Both keys must be pinned.
  async function reorderPinnedByKey(fromKey: string, toKey: string) {
    if (fromKey === toKey) return
    const from = pinnedOrder.value.indexOf(fromKey)
    const to = pinnedOrder.value.indexOf(toKey)
    if (from === -1 || to === -1) return
    const [item] = pinnedOrder.value.splice(from, 1)
    pinnedOrder.value.splice(to, 0, item)
    await persistPinned()
  }

  async function addProject(folderPath: string) {
    const name = folderPath.split('/').pop() || folderPath
    const project: Project = { id: uuidv4(), name, path: folderPath, agentCommands: [] }
    projects.value.push(project)
    useTabStore().ensureProject(project.id)
    activeProjectId.value = project.id
    itemOrder.value.push('project:' + project.id)
    await persist()
    await persistOrder()
    return project
  }

  async function removeProject(id: string) {
    const idx = projects.value.findIndex(p => p.id === id)
    if (idx === -1) return
    projects.value.splice(idx, 1)
    if (activeProjectId.value === id) {
      activeProjectId.value = projects.value[0]?.id ?? null
    }
    itemOrder.value = itemOrder.value.filter(o => o !== 'project:' + id)
    const pinIdx = pinnedOrder.value.indexOf('project:' + id)
    if (pinIdx !== -1) pinnedOrder.value.splice(pinIdx, 1)
    // Cascade: drop the project's pane tree / tab groups so they don't linger
    // in memory (and in the persisted state) after the project is gone.
    // Terminal scrollback sessions are pruned reactively by App.vue's watcher.
    await useTabStore().purgeProject(id)
    await persist()
    await persistOrder()
    await persistPinned()
  }

  async function renameProject(id: string, newName: string) {
    const p = projects.value.find(p => p.id === id)
    if (p) { p.name = newName; await persist() }
  }

  async function reorderItems(from: number, to: number) {
    const [item] = itemOrder.value.splice(from, 1)
    itemOrder.value.splice(to, 0, item)
    await persistOrder()
  }

  // Key-based reorder: safer than index-based reorder when the rendered list
  // is a filtered view of itemOrder (e.g. browser projects / web pages).
  async function reorderItemsByKey(fromKey: string, toKey: string) {
    if (fromKey === toKey) return
    const from = itemOrder.value.indexOf(fromKey)
    const to = itemOrder.value.indexOf(toKey)
    if (from === -1 || to === -1) return
    const [item] = itemOrder.value.splice(from, 1)
    itemOrder.value.splice(to, 0, item)
    await persistOrder()
  }

  // Key-based move: finds the item's actual position in itemOrder and moves it
  // direction: -1 (up) or +1 (down)
  async function moveItem(key: string, direction: -1 | 1) {
    const idx = itemOrder.value.indexOf(key)
    if (idx === -1) return
    const targetIdx = idx + direction
    if (targetIdx < 0 || targetIdx >= itemOrder.value.length) return
    const [item] = itemOrder.value.splice(idx, 1)
    itemOrder.value.splice(targetIdx, 0, item)
    await persistOrder()
  }

  function addToOrder(key: string) {
    if (!itemOrder.value.includes(key)) {
      itemOrder.value.push(key)
      persistOrder()
    }
  }

  function removeFromOrder(key: string) {
    itemOrder.value = itemOrder.value.filter(o => o !== key)
    const pinIdx = pinnedOrder.value.indexOf(key)
    if (pinIdx !== -1) {
      pinnedOrder.value.splice(pinIdx, 1)
      persistPinned()
    }
    persistOrder()
  }

  async function setActiveProject(id: string | null) {
    activeProjectId.value = id
    await persist()
  }

  async function updateProjectAgentCommands(id: string, commands: AgentCommand[]) {
    const p = projects.value.find(p => p.id === id)
    if (p) { p.agentCommands = commands; await persist() }
  }

  return {
    projects, activeProjectId, activeProject, itemOrder, pinnedOrder,
    load, persist, persistOrder, persistPinned, addProject, removeProject,
    renameProject, reorderItems, reorderItemsByKey, moveItem, addToOrder, removeFromOrder,
    isPinned, pinItem, unpinItem, togglePin, reorderPinnedByKey,
    setActiveProject, updateProjectAgentCommands
  }
})
