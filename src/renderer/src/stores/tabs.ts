import { defineStore } from 'pinia'
import { ref, nextTick } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { toPlainObject } from '../utils'

export type TabType = 'terminal' | 'editor' | 'browser' | 'file' | 'diff'

export interface Tab {
  id: string
  projectId: string
  type: TabType
  title: string
  modified?: boolean
  terminalCwd?: string
  browserUrl?: string
  editorOpenFiles?: string[]
  editorActiveFile?: string
  filePath?: string
  fileLine?: number
  diffFilePath?: string
  diffStaged?: boolean
}

// --- Split pane tree types ---

export interface PaneNode {
  id: string
  type: 'leaf'
  groupId: string
}

export interface SplitNode {
  id: string
  type: 'horizontal' | 'vertical'
  children: [TreeNode, TreeNode]
  sizes: [number, number]
}

export type TreeNode = PaneNode | SplitNode

export interface TabGroup {
  id: string
  tabs: Tab[]
  activeTabId: string | null
}

// --- Tree helpers ---

function collectGroupIds(node: TreeNode): string[] {
  if (node.type === 'leaf') return [node.groupId]
  return [...collectGroupIds(node.children[0]), ...collectGroupIds(node.children[1])]
}

function collectLeaves(node: TreeNode): PaneNode[] {
  if (node.type === 'leaf') return [node]
  return [...collectLeaves(node.children[0]), ...collectLeaves(node.children[1])]
}

function findLeaf(node: TreeNode, groupId: string): PaneNode | null {
  if (node.type === 'leaf') return node.groupId === groupId ? node : null
  return findLeaf(node.children[0], groupId) || findLeaf(node.children[1], groupId)
}

function findParentSplit(
  node: TreeNode,
  childId: string
): { parent: SplitNode; index: 0 | 1 } | null {
  if (node.type === 'leaf') return null
  if (node.children[0].id === childId) return { parent: node, index: 0 }
  if (node.children[1].id === childId) return { parent: node, index: 1 }
  return (
    findParentSplit(node.children[0], childId) ||
    findParentSplit(node.children[1], childId)
  )
}

function replaceNode(tree: TreeNode, targetId: string, replacement: TreeNode): TreeNode {
  if (tree.id === targetId) return replacement
  if (tree.type === 'leaf') return tree
  return {
    ...tree,
    children: [
      replaceNode(tree.children[0], targetId, replacement),
      replaceNode(tree.children[1], targetId, replacement)
    ] as [TreeNode, TreeNode]
  }
}

function updateSplitSizes(tree: TreeNode, nodeId: string, sizes: [number, number]): TreeNode {
  if (tree.type === 'leaf') return tree
  if (tree.id === nodeId) return { ...tree, sizes }
  return {
    ...tree,
    children: [
      updateSplitSizes(tree.children[0], nodeId, sizes),
      updateSplitSizes(tree.children[1], nodeId, sizes)
    ] as [TreeNode, TreeNode]
  }
}

function firstLeaf(node: TreeNode): PaneNode {
  if (node.type === 'leaf') return node
  return firstLeaf(node.children[0])
}

function createDefaultTree(groupId: string): TreeNode {
  return { id: uuidv4(), type: 'leaf', groupId }
}

// --- Store ---

export const useTabStore = defineStore('tabs', () => {
  const paneTrees = ref<Record<string, TreeNode>>({})
  const tabGroups = ref<Record<string, Record<string, TabGroup>>>({})
  const focusedGroupId = ref<Record<string, string | null>>({})

  // --- Basic accessors ---

  function getPaneTree(projectId: string): TreeNode | null {
    return paneTrees.value[projectId] ?? null
  }

  function getGroup(projectId: string, groupId: string): TabGroup | null {
    return tabGroups.value[projectId]?.[groupId] ?? null
  }

  function getGroupTabs(projectId: string, groupId: string): Tab[] {
    return getGroup(projectId, groupId)?.tabs ?? []
  }

  function getGroupActiveTabId(projectId: string, groupId: string): string | null {
    return getGroup(projectId, groupId)?.activeTabId ?? null
  }

  function getGroupActiveTab(projectId: string, groupId: string): Tab | null {
    const group = getGroup(projectId, groupId)
    if (!group?.activeTabId) return null
    return group.tabs.find(t => t.id === group.activeTabId) ?? null
  }

  function getFocusedGroupId(projectId: string): string | null {
    return focusedGroupId.value[projectId] ?? null
  }

  // Returns first-row panes with their width fractions (sum = 1.0).
  // Horizontal splits → both children in row, sizes from split; vertical → only top child.
  function getFirstRowPaneIds(projectId: string): string[] {
    return getFirstRowPanes(projectId).map(p => p.groupId)
  }

  interface FirstRowPane {
    groupId: string
    widthFraction: number
  }

  function getFirstRowPanes(projectId: string): FirstRowPane[] {
    const tree = paneTrees.value[projectId]
    if (!tree) return []
    function walk(node: TreeNode, fraction: number): FirstRowPane[] {
      if (node.type === 'leaf') return [{ groupId: node.groupId, widthFraction: fraction }]
      if (node.type === 'horizontal') {
        const [s0, s1] = node.sizes
        return [...walk(node.children[0], fraction * s0), ...walk(node.children[1], fraction * s1)]
      }
      return walk(node.children[0], fraction)
    }
    return walk(tree, 1)
  }

  // For each adjacent pair of first-row panes, returns the horizontal split node that separates them.
  // This allows the titlebar to render draggable splitters that control the correct pane split.
  interface FirstRowSplitter {
    nodeId: string       // id of the SplitNode to resize
    index: number        // gap index between first-row panes (0 = between pane 0 and 1)
  }

  function getFirstRowSplitters(projectId: string): FirstRowSplitter[] {
    const tree = paneTrees.value[projectId]
    if (!tree) return []
    const result: FirstRowSplitter[] = []
    let nextIndex = 0

    function walk(node: TreeNode): string[] {
      if (node.type === 'leaf') { nextIndex++; return [node.groupId] }
      if (node.type === 'horizontal') {
        const left = walk(node.children[0])
        result.push({ nodeId: node.id, index: nextIndex })
        const right = walk(node.children[1])
        return [...left, ...right]
      }
      return walk(node.children[0])
    }
    walk(tree)
    return result
  }

  function getAllTabs(projectId: string): Tab[] {
    const tree = paneTrees.value[projectId]
    if (!tree) return []
    return collectGroupIds(tree).flatMap(gid => getGroupTabs(projectId, gid))
  }

  // Compatibility wrappers for components that haven't migrated
  function getProjectTabs(projectId: string): Tab[] {
    return getAllTabs(projectId)
  }

  function getActiveTabId(projectId: string): string | null {
    const fgId = focusedGroupId.value[projectId]
    if (!fgId) return null
    return getGroupActiveTabId(projectId, fgId)
  }

  function getActiveTab(projectId: string): Tab | null {
    const fgId = focusedGroupId.value[projectId]
    if (!fgId) return null
    return getGroupActiveTab(projectId, fgId)
  }

  // --- Persistence ---

  async function load() {
    const storedTrees = await window.electronAPI.storeGet('paneTrees')
    if (storedTrees && typeof storedTrees === 'object') {
      paneTrees.value = storedTrees as Record<string, TreeNode>
    }
    const storedGroups = await window.electronAPI.storeGet('tabGroups')
    if (storedGroups && typeof storedGroups === 'object') {
      tabGroups.value = storedGroups as Record<string, Record<string, TabGroup>>
    }
    const storedFocus = await window.electronAPI.storeGet('focusedGroupId')
    if (storedFocus && typeof storedFocus === 'object') {
      focusedGroupId.value = storedFocus as Record<string, string | null>
    }

    if (Object.keys(paneTrees.value).length === 0) {
      await migrateFromLegacy()
    }
  }

  async function migrateFromLegacy() {
    const oldTabs = await window.electronAPI.storeGet('tabs')
    const oldActive = await window.electronAPI.storeGet('activeTabId')

    if (oldTabs && typeof oldTabs === 'object') {
      const tabsRecord = oldTabs as Record<string, Tab[]>
      const activeRecord =
        oldActive && typeof oldActive === 'object'
          ? (oldActive as Record<string, string | null>)
          : {}

      for (const projectId of Object.keys(tabsRecord)) {
        const groupId = uuidv4()
        const tabs = tabsRecord[projectId] || []
        if (!tabGroups.value[projectId]) tabGroups.value[projectId] = {}
        tabGroups.value[projectId][groupId] = {
          id: groupId,
          tabs,
          activeTabId: activeRecord[projectId] ?? tabs[0]?.id ?? null
        }
        paneTrees.value[projectId] = createDefaultTree(groupId)
        focusedGroupId.value[projectId] = groupId
      }
      await doPersist()
    }
  }

  async function doPersist() {
    await window.electronAPI.storeSet('paneTrees', toPlainObject(paneTrees.value))
    await window.electronAPI.storeSet('tabGroups', toPlainObject(tabGroups.value))
    await window.electronAPI.storeSet('focusedGroupId', toPlainObject(focusedGroupId.value))
  }

  // --- Group helpers ---

  function ensureProject(projectId: string): string {
    if (!tabGroups.value[projectId]) tabGroups.value[projectId] = {}

    if (!paneTrees.value[projectId]) {
      const groupId = uuidv4()
      tabGroups.value[projectId][groupId] = { id: groupId, tabs: [], activeTabId: null }
      paneTrees.value[projectId] = createDefaultTree(groupId)
      focusedGroupId.value[projectId] = groupId
      return groupId
    }

    if (!focusedGroupId.value[projectId]) {
      const leaves = collectLeaves(paneTrees.value[projectId])
      const gid = leaves[0]?.groupId
      if (gid) {
        focusedGroupId.value[projectId] = gid
        return gid
      }
      // fallback: create a new group
      const groupId = uuidv4()
      tabGroups.value[projectId][groupId] = { id: groupId, tabs: [], activeTabId: null }
      paneTrees.value[projectId] = createDefaultTree(groupId)
      focusedGroupId.value[projectId] = groupId
      return groupId
    }

    // Verify the focused group still exists, otherwise fix
    if (!tabGroups.value[projectId][focusedGroupId.value[projectId]!]) {
      const leaves = collectLeaves(paneTrees.value[projectId])
      const gid = leaves[0]?.groupId
      if (gid) {
        focusedGroupId.value[projectId] = gid
        return gid
      }
    }

    return focusedGroupId.value[projectId]!
  }

  function findTabGroup(
    projectId: string,
    tabId: string
  ): { groupId: string; group: TabGroup } | null {
    const groups = tabGroups.value[projectId]
    if (!groups) return null
    for (const [gid, g] of Object.entries(groups)) {
      if (g.tabs.some(t => t.id === tabId)) {
        return { groupId: gid, group: g }
      }
    }
    return null
  }

  // --- Pane operations ---

  function splitPane(projectId: string, direction: 'horizontal' | 'vertical', templateTab?: Tab) {
    const fgId = focusedGroupId.value[projectId]
    if (!fgId) return

    const tree = paneTrees.value[projectId]
    if (!tree) return

    const leaf = findLeaf(tree, fgId)
    if (!leaf) return

    const newGroupId = uuidv4()
    if (!tabGroups.value[projectId]) tabGroups.value[projectId] = {}

    let newTabs: Tab[] = []
    if (templateTab) {
      // Clone the template tab but with new ID
      newTabs = [{ ...templateTab, id: uuidv4() }]
    }
    tabGroups.value[projectId][newGroupId] = {
      id: newGroupId,
      tabs: newTabs,
      activeTabId: newTabs[0]?.id ?? null
    }

    const newLeaf: PaneNode = { id: uuidv4(), type: 'leaf', groupId: newGroupId }

    const split: SplitNode = {
      id: uuidv4(),
      type: direction,
      children: [leaf, newLeaf],
      sizes: [0.5, 0.5]
    }

    paneTrees.value[projectId] = replaceNode(tree, leaf.id, split)
    focusedGroupId.value[projectId] = newGroupId
    doPersist()
  }

  function closePane(projectId: string, groupId: string) {
    const tree = paneTrees.value[projectId]
    if (!tree) return

    const leaves = collectLeaves(tree)
    if (leaves.length <= 1) return

    const leaf = findLeaf(tree, groupId)
    if (!leaf) return

    let newTree = tree
    let newFocusId: string | null = null

    const parentInfo = findParentSplit(tree, leaf.id)
    if (parentInfo) {
      const sibling = parentInfo.parent.children[parentInfo.index === 0 ? 1 : 0]
      newTree = replaceNode(tree, parentInfo.parent.id, sibling)
      newFocusId = firstLeaf(sibling).groupId
    }

    paneTrees.value[projectId] = newTree

    if (tabGroups.value[projectId]) {
      delete tabGroups.value[projectId][groupId]
    }

    focusedGroupId.value[projectId] = newFocusId
    doPersist()
  }

  function focusPane(projectId: string, groupId: string) {
    focusedGroupId.value[projectId] = groupId
    doPersist()
  }

  function resizeSplit(projectId: string, nodeId: string, sizes: [number, number]) {
    const tree = paneTrees.value[projectId]
    if (!tree) return
    paneTrees.value[projectId] = updateSplitSizes(tree, nodeId, sizes)
    doPersist()
  }

  // --- Tab CRUD ---

  async function addTab(
    projectId: string,
    type: TabType,
    extra?: Partial<Tab>
  ): Promise<Tab> {
    const fgId = ensureProject(projectId)
    const group = tabGroups.value[projectId][fgId]
    const tab: Tab = {
      id: uuidv4(),
      projectId,
      type,
      title: defaultTitle(type),
      ...extra
    }
    group.tabs.push(tab)
    group.activeTabId = tab.id
    doPersist()
    return tab
  }

  async function closeTab(projectId: string, tabId: string) {
    const result = findTabGroup(projectId, tabId)
    if (!result) return
    const { groupId, group } = result
    const idx = group.tabs.findIndex(t => t.id === tabId)
    if (idx === -1) return

    group.tabs.splice(idx, 1)
    if (group.activeTabId === tabId) {
      group.activeTabId =
        group.tabs[Math.max(0, idx - 1)]?.id ?? group.tabs[0]?.id ?? null
    }

    if (group.tabs.length === 0) {
      nextTick(() => closePane(projectId, groupId))
    }

    doPersist()
  }

  async function setActiveTab(projectId: string, tabId: string) {
    const result = findTabGroup(projectId, tabId)
    if (!result) return
    result.group.activeTabId = tabId
    focusedGroupId.value[projectId] = result.groupId
    doPersist()
  }

  async function renameTab(projectId: string, tabId: string, title: string) {
    const result = findTabGroup(projectId, tabId)
    if (!result) return
    const tab = result.group.tabs.find(t => t.id === tabId)
    if (tab) {
      tab.title = title
      doPersist()
    }
  }

  async function updateTab(projectId: string, tabId: string, patch: Partial<Tab>) {
    const result = findTabGroup(projectId, tabId)
    if (!result) return
    const tab = result.group.tabs.find(t => t.id === tabId)
    if (tab) {
      Object.assign(tab, patch)
      doPersist()
    }
  }

  async function reorderTabs(projectId: string, groupId: string, from: number, to: number) {
    const group = tabGroups.value[projectId]?.[groupId]
    if (!group) return
    const [item] = group.tabs.splice(from, 1)
    group.tabs.splice(to, 0, item)
    doPersist()
  }

  async function closeOtherTabs(projectId: string, tabId: string) {
    const result = findTabGroup(projectId, tabId)
    if (!result) return
    result.group.tabs = result.group.tabs.filter(t => t.id === tabId)
    result.group.activeTabId = tabId
    doPersist()
  }

  async function closeTabsToRight(projectId: string, groupId: string, tabId: string) {
    const group = tabGroups.value[projectId]?.[groupId]
    if (!group) return
    const idx = group.tabs.findIndex(t => t.id === tabId)
    if (idx === -1) return
    group.tabs = group.tabs.slice(0, idx + 1)
    if (!group.tabs.find(t => t.id === group.activeTabId)) {
      group.activeTabId = tabId
    }
    doPersist()
  }

  async function duplicateTab(projectId: string, tabId: string) {
    const result = findTabGroup(projectId, tabId)
    if (!result) return
    const tab = result.group.tabs.find(t => t.id === tabId)
    if (!tab) return
    const newTab: Tab = { ...tab, id: uuidv4() }
    result.group.tabs.push(newTab)
    result.group.activeTabId = newTab.id
    focusedGroupId.value[projectId] = result.groupId
    doPersist()
  }

  function moveTab(
    projectId: string,
    tabId: string,
    toGroupId: string,
    insertIndex?: number
  ) {
    if (!tabGroups.value[projectId]) return
    const toGroup = tabGroups.value[projectId][toGroupId]
    if (!toGroup) return

    const from = findTabGroup(projectId, tabId)
    if (!from) return
    if (from.groupId === toGroupId) return // same group

    const tabIdx = from.group.tabs.findIndex(t => t.id === tabId)
    if (tabIdx === -1) return

    const [tab] = from.group.tabs.splice(tabIdx, 1)

    if (from.group.activeTabId === tabId) {
      from.group.activeTabId =
        from.group.tabs[Math.max(0, tabIdx - 1)]?.id ??
        from.group.tabs[0]?.id ??
        null
    }

    const idx = insertIndex ?? toGroup.tabs.length
    toGroup.tabs.splice(idx, 0, tab)
    toGroup.activeTabId = tab.id
    focusedGroupId.value[projectId] = toGroupId

    if (from.group.tabs.length === 0) {
      nextTick(() => closePane(projectId, from.groupId))
    }

    doPersist()
  }

  return {
    paneTrees,
    tabGroups,
    focusedGroupId,
    getPaneTree,
    getGroup,
    getGroupTabs,
    getGroupActiveTabId,
    getGroupActiveTab,
    getFocusedGroupId,
    getFirstRowPaneIds,
    getFirstRowPanes,
    getFirstRowSplitters,
    getAllTabs,
    getProjectTabs,
    getActiveTabId,
    getActiveTab,
    load,
    doPersist,
    splitPane,
    closePane,
    focusPane,
    resizeSplit,
    addTab,
    closeTab,
    setActiveTab,
    renameTab,
    updateTab,
    reorderTabs,
    closeOtherTabs,
    closeTabsToRight,
    duplicateTab,
    moveTab,
    ensureProject
  }
})

function defaultTitle(type: TabType): string {
  switch (type) {
    case 'terminal':
      return 'Terminal'
    case 'editor':
      return 'Editor'
    case 'browser':
      return 'Browser'
    case 'file':
      return 'File'
    case 'diff':
      return 'Diff'
  }
}