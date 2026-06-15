<template>
  <!-- Collapsed icon bar -->
  <div v-if="layout.leftCollapsed" class="left-pane-inner collapsed">
    <div class="icon-bar">
      <div class="icon-bar-btn" :title="$t('common.expand')" @click="layout.leftCollapsed = false; layout.persist()">»</div>
      <div
        v-for="item in orderedItems"
        :key="item.orderKey"
        class="icon-bar-btn"
        :class="{ active: isItemActive(item), notifying: item.type === 'webpage' && item.data.hasNotification }"
        :title="itemTitle(item)"
        @click="onItemClick(item)"
      >
        <span v-if="item.type === 'project'">📁</span>
        <span v-else-if="item.data.hasNotification">🔔</span>
        <span v-else>🌐</span>
      </div>
    </div>
  </div>

  <!-- Expanded -->
  <div v-else class="left-pane-inner" @dragover.prevent @drop="onDrop">
      <div class="left-header">
        <button class="icon-btn" :title="$t('common.collapse')" @click="layout.leftCollapsed = true; layout.persist()">«</button>
        <span class="left-title">{{ $t('titlebar.leftTitle') }}</span>
        <div class="add-wrapper" ref="addBtnRef">
          <button class="icon-btn" title="Add" @click.stop="toggleAddMenu">+</button>
          <div v-if="showAddMenu" class="add-dropdown" @click.stop @mouseleave="showAddMenu = false">
            <div class="add-dropdown-item" @click="addProject">📁 {{ $t('titlebar.addProject') }}</div>
            <div class="add-dropdown-item" @click="startNewFolder">📂 {{ $t('leftPane.newFolder') }}</div>
            <div class="add-dropdown-item" @click="startAddWebPage">🌐 {{ $t('titlebar.addWebPage') }}</div>
          </div>
        </div>
      </div>

    <div class="item-list">
      <div
        v-if="orderedItems.length === 0"
        class="empty-hint"
      >
        {{ $t('leftPane.emptyHint') }}
      </div>

      <div
        v-for="(item, idx) in orderedItems"
        :key="item.orderKey"
        class="left-item"
        :class="{
          active: isItemActive(item),
          notifying: item.type === 'webpage' && item.data.hasNotification
        }"
        draggable="true"
        @click="onItemClick(item)"
        @contextmenu="showItemMenu($event, item, idx)"
        @dragstart="dragStart($event, idx)"
        @dragover.prevent="dragOver(idx)"
        @drop.stop="dragDrop(idx)"
      >
        <span class="item-icon">
          <template v-if="item.type === 'project'">📁</template>
          <template v-else-if="item.data.hasNotification">🔔</template>
          <template v-else>🌐</template>
        </span>
        <span
          v-if="!editing || editingId !== item.orderKey"
          class="item-name"
          @dblclick.stop="startEdit(item)"
        >{{ itemTitle(item) }}</span>
        <input
          v-else
          ref="editInput"
          v-model="editValue"
          class="item-name-input"
          @blur="commitEdit"
          @keydown.enter="commitEdit"
          @keydown.esc="cancelEdit"
          @click.stop
        />
        <span class="item-subtitle" :title="itemSubtitle(item)">{{ itemSubtitle(item) }}</span>
      </div>
    </div>

    <!-- Add web page dialog -->
    <div v-if="showAddWebPage" class="modal-overlay" @click.self="showAddWebPage = false">
      <div class="modal">
        <div class="modal-title">{{ $t('leftPane.addWebPageTitle') }}</div>
        <div class="modal-field">
          <label class="modal-label">{{ $t('common.url') }}</label>
          <input v-model="newWebPageUrl" class="modal-input" placeholder="https://..." @keydown.enter="confirmAddWebPage" />
        </div>
        <div class="modal-field">
          <label class="modal-label">{{ $t('common.title') }}</label>
          <input v-model="newWebPageTitle" class="modal-input" :placeholder="$t('leftPane.pageTitle')" @keydown.enter="confirmAddWebPage" />
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="showAddWebPage = false">{{ $t('common.cancel') }}</button>
          <button class="btn-primary" :disabled="!newWebPageUrl.trim()" @click="confirmAddWebPage">{{ $t('common.add') }}</button>
        </div>
      </div>
    </div>

    <!-- New folder dialog -->
    <div v-if="showNewFolderModal" class="modal-overlay" @click.self="showNewFolderModal = false">
      <div class="modal">
        <div class="modal-title">{{ $t('leftPane.newFolderTitle') }}</div>
        <div class="modal-field">
          <label class="modal-label">{{ $t('leftPane.parentDirectory') }}</label>
          <div class="path-row">
            <input v-model="newFolderParentPath" class="modal-input" @keydown.enter="confirmNewFolder" />
            <button class="btn-secondary btn-small" @click="browseParentDir">{{ $t('leftPane.browse') }}</button>
          </div>
        </div>
        <div class="modal-field">
          <label class="modal-label">{{ $t('leftPane.folderName') }}</label>
          <input ref="newFolderNameInput" v-model="newFolderName" class="modal-input" placeholder="my-project" @keydown.enter="confirmNewFolder" />
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="showNewFolderModal = false">{{ $t('common.cancel') }}</button>
          <button class="btn-primary" :disabled="!newFolderName.trim()" @click="confirmNewFolder">{{ $t('leftPane.create') }}</button>
        </div>
      </div>
    </div>

    <!-- Agent commands modal -->
    <AgentCommandsModal
      v-if="agentProject"
      :project="agentProject"
      @close="agentProject = null"
    />

    <!-- Confirm remove modal -->
    <div v-if="removingItem" class="modal-overlay" @click.self="removingItem = null">
      <div class="modal">
        <div class="modal-title">{{ $t('leftPane.removeTitle', { name: removingItem.title }) }}</div>
        <p style="font-size:13px;color:var(--text-secondary)">
          {{ removingItem.hint }}
        </p>
        <div class="modal-actions">
          <button class="btn-secondary" @click="removingItem = null">{{ $t('common.cancel') }}</button>
          <button class="btn-danger" @click="confirmRemove">{{ $t('common.remove') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProjectStore, type Project } from '../../stores/projects'
import { useWebPageStore, type WebPage } from '../../stores/webPages'
import { useLayoutStore } from '../../stores/layout'
import { useTabStore } from '../../stores/tabs'
import { useContextMenu } from '../../composables/useContextMenu'
import AgentCommandsModal from './AgentCommandsModal.vue'

const { t } = useI18n()

const projectStore = useProjectStore()
const webPageStore = useWebPageStore()
const layout = useLayoutStore()
// Remember right-pane collapse state before entering webpage mode
let rightCollapsedSnapshot = false
const tabStore = useTabStore()
const { show: showMenu } = useContextMenu()

interface OrderedItem {
  type: 'project' | 'webpage'
  data: Project | WebPage
  orderKey: string
}

const orderedItems = computed<OrderedItem[]>(() => {
  return projectStore.itemOrder.map(key => {
    const [type, id] = key.split(':')
    if (type === 'project') {
      const p = projectStore.projects.find(p => p.id === id)
      return p ? { type: 'project', data: p, orderKey: key } : null
    } else if (type === 'webpage') {
      const w = webPageStore.webPages.find(w => w.id === id)
      return w ? { type: 'webpage', data: w, orderKey: key } : null
    }
    return null
  }).filter(Boolean) as OrderedItem[]
})

function isItemActive(item: OrderedItem): boolean {
  if (item.type === 'project') {
    return (item.data as Project).id === projectStore.activeProjectId
  }
  return (item.data as WebPage).id === webPageStore.selectedWebPageId
}

function itemTitle(item: OrderedItem): string {
  if (item.type === 'project') return (item.data as Project).name
  return (item.data as WebPage).title
}

function itemSubtitle(item: OrderedItem): string {
  if (item.type === 'project') {
    const p = item.data as Project
    const parts = p.path.split('/')
    if (parts.length <= 3) return p.path
    return '…/' + parts.slice(-2).join('/')
  }
  return (item.data as WebPage).url
}

function onItemClick(item: OrderedItem) {
  if (item.type === 'project') {
    // Restore right-pane state that was saved before entering webpage mode
    layout.rightCollapsed = rightCollapsedSnapshot
    projectStore.setActiveProject((item.data as Project).id)
    webPageStore.selectWebPage(null)
    layout.persist()
  } else {
    // Save current state, then collapse right pane for distraction-free browsing
    rightCollapsedSnapshot = layout.rightCollapsed
    layout.rightCollapsed = true
    layout.persist()
    webPageStore.selectWebPage((item.data as WebPage).id)
    projectStore.setActiveProject(null)
  }
}

// Drag reorder
let dragFromIdx = -1
function dragStart(e: DragEvent, idx: number) {
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', '')
  }
  dragFromIdx = idx
}
function dragOver(_idx: number) {}
function dragDrop(toIdx: number) {
  if (dragFromIdx !== -1 && dragFromIdx !== toIdx) {
    projectStore.reorderItems(dragFromIdx, toIdx)
  }
  dragFromIdx = -1
}

// Drop: folder from OS, or browser tab from pane
async function onDrop(e: DragEvent) {
  if (!e.dataTransfer) return

  // Try parsing as tab drag data first
  const raw = e.dataTransfer.getData('text/plain')
  if (raw) {
    try {
      const data = JSON.parse(raw)
      if (data.tabType === 'browser' && data.tabUrl) {
        const title = data.tabTitle || new URL(data.tabUrl).hostname
        await webPageStore.addWebPage(data.tabUrl, title)
        return
      }
    } catch { /* not a tab drag */ }
  }

  // Fallback: folder drop
  const files = e.dataTransfer.files
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as any
    const path: string = f.path
    if (path) {
      await projectStore.addProject(path)
      webPageStore.selectWebPage(null)
    }
  }
}

// Add menu
const showAddMenu = ref(false)
const addBtnRef = ref<HTMLElement | null>(null)
function toggleAddMenu() { showAddMenu.value = !showAddMenu.value }

async function addProject() {
  showAddMenu.value = false
  const path = await window.electronAPI.openFolder()
  if (path) {
    await projectStore.addProject(path)
    webPageStore.selectWebPage(null)
  }
}

// Add web page
const showAddWebPage = ref(false)
const newWebPageUrl = ref('')
const newWebPageTitle = ref('')

function startAddWebPage() {
  showAddMenu.value = false
  showAddWebPage.value = true
  newWebPageUrl.value = ''
  newWebPageTitle.value = ''
}

async function confirmAddWebPage() {
  const url = newWebPageUrl.value.trim()
  if (!url) return
  let formattedUrl = url
  if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
    formattedUrl = 'https://' + formattedUrl
  }
  const title = newWebPageTitle.value.trim() || new URL(formattedUrl).hostname
  await webPageStore.addWebPage(formattedUrl, title)
  showAddWebPage.value = false
}

// New folder
const showNewFolderModal = ref(false)
const newFolderParentPath = ref('')
const newFolderName = ref('')
const newFolderNameInput = ref<HTMLInputElement | null>(null)

async function startNewFolder() {
  showAddMenu.value = false
  // Load remembered parent path, fallback to home
  const lastPath = await window.electronAPI.storeGet('lastNewFolderParentPath')
  if (lastPath && typeof lastPath === 'string') {
    newFolderParentPath.value = lastPath
  } else {
    newFolderParentPath.value = await window.electronAPI.getPath('home')
  }
  newFolderName.value = ''
  showNewFolderModal.value = true
  nextTick(() => newFolderNameInput.value?.focus())
}

async function browseParentDir() {
  const path = await window.electronAPI.openFolderAt(newFolderParentPath.value)
  if (path) {
    newFolderParentPath.value = path
  }
}

async function confirmNewFolder() {
  const name = newFolderName.value.trim()
  if (!name) return
  const fullPath = `${newFolderParentPath.value}/${name}`
  await window.electronAPI.mkdir(fullPath)
  // Remember this parent path for next time
  await window.electronAPI.storeSet('lastNewFolderParentPath', newFolderParentPath.value)
  showNewFolderModal.value = false
  await projectStore.addProject(fullPath)
  webPageStore.selectWebPage(null)
}

// Context menu
const removingItem = ref<{ type: string; id: string; title: string; hint: string } | null>(null)
const agentProject = ref<Project | null>(null)

function showItemMenu(e: MouseEvent, item: OrderedItem, idx: number) {
  onItemClick(item)
  if (item.type === 'project') {
    const project = item.data as Project
    showMenu(e, [
      { label: t('common.rename'), action: () => startEdit(item) },
      { label: t('leftPane.agentCommands'), action: () => { agentProject.value = project } },
      { label: t('common.moveUp'), disabled: idx === 0, action: () => projectStore.moveItem(item.orderKey, -1) },
      { label: t('common.moveDown'), disabled: idx === orderedItems.value.length - 1, action: () => projectStore.moveItem(item.orderKey, 1) },
      { separator: true },
      { label: t('contextMenu.removeFromList'), danger: true, action: () => { removingItem.value = { type: 'project', id: project.id, title: project.name, hint: t('leftPane.removeProjectHint') } } }
    ])
  } else {
    const wp = item.data as WebPage
    showMenu(e, [
      { label: t('common.open'), action: () => onItemClick(item) },
      { label: t('contextMenu.copyUrl'), action: () => navigator.clipboard.writeText(wp.url) },
      { label: t('common.rename'), action: () => startEdit(item) },
      { label: t('contextMenu.markAsRead'), disabled: !wp.hasNotification, action: () => markAsRead(wp) },
      { label: t('common.moveUp'), disabled: idx === 0, action: () => projectStore.moveItem(item.orderKey, -1) },
      { label: t('common.moveDown'), disabled: idx === orderedItems.value.length - 1, action: () => projectStore.moveItem(item.orderKey, 1) },
      { separator: true },
      { label: t('common.remove'), danger: true, action: () => { removingItem.value = { type: 'webpage', id: wp.id, title: wp.title, hint: t('leftPane.removeWebPageHint') } } }
    ])
  }
}

async function markAsRead(wp: WebPage) {
  // Update baseline from any open browser tab matching this URL
  for (const p of projectStore.projects) {
    const tabs = tabStore.getAllTabs(p.id)
    for (const tab of tabs) {
      if (tab.browserUrl === wp.url) {
        await webPageStore.updateBaselineTitle(wp.id, tab.title)
        break
      }
    }
  }
  await webPageStore.markAsRead(wp.id)
}

async function confirmRemove() {
  if (!removingItem.value) return
  if (removingItem.value.type === 'project') {
    await projectStore.removeProject(removingItem.value.id)
  } else {
    await webPageStore.removeWebPage(removingItem.value.id)
  }
  removingItem.value = null
}

// Inline editing
const editing = ref(false)
const editingId = ref('')
const editValue = ref('')
const editInput = ref<HTMLInputElement | null>(null)

function startEdit(item: OrderedItem) {
  editing.value = true
  editingId.value = item.orderKey
  editValue.value = itemTitle(item)
  nextTick(() => editInput.value?.select())
}

async function commitEdit() {
  const val = editValue.value.trim()
  if (val && editingId.value) {
    const [type, id] = editingId.value.split(':')
    if (type === 'project') {
      await projectStore.renameProject(id, val)
    } else if (type === 'webpage') {
      await webPageStore.renameWebPage(id, val)
    }
  }
  editing.value = false
}

function cancelEdit() { editing.value = false }
</script>

<style scoped>
.left-pane-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-secondary);
  user-select: none;
}
.left-pane-inner.collapsed {
  padding: 4px 0;
}
.icon-bar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.icon-bar-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 4px;
  font-size: 14px;
  position: relative;
}
.icon-bar-btn:hover { background: var(--bg-hover); }
.icon-bar-btn.active { background: var(--bg-active); }

.left-header {
  display: flex;
  align-items: center;
  height: var(--tab-height);
  padding: 0 8px;
  border-bottom: 1px solid var(--border-color);
  gap: 4px;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}
.left-title {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
}

.add-wrapper { position: relative; }
.add-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 160px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  z-index: 100;
  overflow: hidden;
}
.add-dropdown-item {
  padding: 8px 12px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.add-dropdown-item:hover { background: var(--bg-hover); }

.item-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.empty-hint {
  text-align: center;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 24px 16px;
  line-height: 1.6;
}

.left-item {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: 4px;
  margin: 1px 4px;
  gap: 6px;
  min-height: 30px;
  flex-wrap: wrap;
}
.left-item:hover { background: var(--bg-hover); }
.left-item.active { background: var(--bg-active); }

.item-icon { font-size: 14px; flex-shrink: 0; }

.item-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-name-input {
  flex: 1;
  font-size: 13px;
  padding: 2px 4px;
  background: var(--bg-tertiary);
  border: 1px solid var(--text-accent);
  color: var(--text-primary);
  border-radius: 3px;
}
.item-subtitle {
  font-size: 10px;
  color: var(--text-secondary);
  width: 100%;
  padding-left: 20px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Notification blink */
@keyframes notify-pulse {
  0%, 100% { background: transparent; }
  50% { background: rgba(245, 158, 11, 0.12); }
}
.left-item.notifying {
  animation: notify-pulse 1.2s ease-in-out infinite;
}
.icon-bar-btn.notifying {
  animation: notify-pulse 1.2s ease-in-out infinite;
}

/* Modals */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.modal {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 20px;
  min-width: 360px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.25);
}
.modal-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
.modal-field { margin-bottom: 10px; }
.modal-label { display: block; font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; }
.modal-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 13px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: 4px;
  box-sizing: border-box;
}
.modal-input:focus { border-color: var(--text-accent); }
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.path-row {
  display: flex;
  gap: 6px;
}
.path-row .modal-input {
  flex: 1;
}
.btn-small {
  padding: 4px 10px;
  font-size: 12px;
  white-space: nowrap;
}
</style>