import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { toPlainObject } from '../utils'
import { useTabStore } from './tabs'

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
  }

  async function persist() {
    await window.electronAPI.storeSet('projects', toPlainObject(projects.value))
    await window.electronAPI.storeSet('activeProjectId', activeProjectId.value)
  }

  async function persistOrder() {
    await window.electronAPI.storeSet('itemOrder', toPlainObject(itemOrder.value))
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
    await persist()
    await persistOrder()
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
    projects, activeProjectId, activeProject, itemOrder,
    load, persist, persistOrder, addProject, removeProject,
    renameProject, reorderItems, moveItem, addToOrder, removeFromOrder,
    setActiveProject, updateProjectAgentCommands
  }
})
