<template>
  <div ref="tabBarRef" class="tab-bar" @wheel.prevent="onTabScroll" @dragover.prevent @dragenter="onDragEnter" @dragleave="onDragLeave" @drop="onDrop">
    <div
      v-for="(tab, idx) in tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === activeTabId, modified: tab.modified }"
      draggable="true"
      @click="tabStore.setActiveTab(projectId, tab.id)"
      @mousedown.middle.prevent="confirmCloseTab(tab)"
      @contextmenu.prevent="showTabMenu($event, tab, idx)"
      @dragstart="onTabDragStart($event, tab, idx)"
      @dragover.prevent
      @drop="dragDrop(idx)"
    >
      <span class="tab-icon"><Icon :name="tabIcon(tab.type)" :size="12" /></span>
      <span
        v-if="!editingTabId || editingTabId !== tab.id"
        class="tab-title"
      >{{ tab.title }}</span>
      <input
        v-else
        ref="tabTitleInput"
        v-model="editTabTitle"
        class="tab-title-input"
        @blur="commitTabRename"
        @keydown.enter="commitTabRename"
        @keydown.esc="cancelTabRename"
        @click.stop
      />
      <span v-if="tab.modified" class="tab-modified-dot"></span>
      <button
        class="tab-close"
        @click.stop="confirmCloseTab(tab)"
      ><Icon name="x" :size="10" /></button>
    </div>
    <div class="tab-toolbar" ref="toolbarRef">
      <template v-if="!toolbarOverflow">
        <button class="tab-action-btn" :title="t('tab.terminal')" @click.stop="createTab('terminal')"><Icon name="terminal" :size="13" /></button>
        <button class="tab-action-btn" :title="t('tab.fileEditor')" @click.stop="createTab('editor')"><Icon name="file-text" :size="13" /></button>
        <button class="tab-action-btn" :title="t('tab.browser')" @click.stop="createTab('browser')"><Icon name="globe" :size="13" /></button>
        <button class="tab-action-btn" :title="t('tab.splitDown')" @click.stop="splitPane('vertical')"><Icon name="rows" :size="13" /></button>
        <button class="tab-action-btn" :title="t('tab.splitRight')" @click.stop="splitPane('horizontal')"><Icon name="columns" :size="13" /></button>
        <button class="tab-action-btn" :title="t('tab.closePane')" @click.stop="closeThisPane"><Icon name="x" :size="13" /></button>
      </template>
      <button v-else ref="moreBtnRef" class="tab-action-btn" @click.stop="toggleMoreDropdown"><Icon name="more" :size="13" /></button>
    </div>

    <!-- Overflow dropdown -->
    <div
      v-if="showMoreDropdown"
      ref="moreDropdownRef"
      class="tab-dropdown"
      :style="moreDropdownStyle"
      @click.stop
      @mouseleave="showMoreDropdown = false"
    >
      <div class="tab-dropdown-item" @click="createTab('terminal'); showMoreDropdown = false">
        <span class="tab-dropdown-icon"><Icon name="terminal" :size="14" /></span>
        <div class="tab-dropdown-name">{{ t('tab.terminal') }}</div>
      </div>
      <div class="tab-dropdown-item" @click="createTab('editor'); showMoreDropdown = false">
        <span class="tab-dropdown-icon"><Icon name="file-text" :size="14" /></span>
        <div class="tab-dropdown-name">{{ t('tab.fileEditor') }}</div>
      </div>
      <div class="tab-dropdown-item" @click="createTab('browser'); showMoreDropdown = false">
        <span class="tab-dropdown-icon"><Icon name="globe" :size="14" /></span>
        <div class="tab-dropdown-name">{{ t('tab.browser') }}</div>
      </div>
      <div class="tab-dropdown-separator"></div>
      <div class="tab-dropdown-item" @click="splitPane('vertical'); showMoreDropdown = false">
        <span class="tab-dropdown-icon"><Icon name="rows" :size="14" /></span>
        <div class="tab-dropdown-name">{{ t('tab.splitDown') }}</div>
      </div>
      <div class="tab-dropdown-item" @click="splitPane('horizontal'); showMoreDropdown = false">
        <span class="tab-dropdown-icon"><Icon name="columns" :size="14" /></span>
        <div class="tab-dropdown-name">{{ t('tab.splitRight') }}</div>
      </div>
      <div class="tab-dropdown-item" @click="closeThisPane(); showMoreDropdown = false">
        <span class="tab-dropdown-icon"><Icon name="x" :size="14" /></span>
        <div class="tab-dropdown-name">{{ t('tab.closePane') }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTabStore, type Tab, type TabType } from '../../stores/tabs'
import { useProjectStore } from '../../stores/projects'
import { useContextMenu } from '../../composables/useContextMenu'
import { resolveTabIcon, resolveTabTitle } from '../../plugins/registries'
import Icon from '../ui/Icon.vue'

const props = defineProps<{
  projectId: string
  groupId: string
}>()

const { t } = useI18n()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const { show: showMenu } = useContextMenu()

const tabs = computed(() => tabStore.getGroupTabs(props.projectId, props.groupId))
const activeTabId = computed(() => tabStore.getGroupActiveTabId(props.projectId, props.groupId))

// Toolbar overflow detection
const tabBarRef = ref<HTMLElement | null>(null)
const toolbarRef = ref<HTMLElement | null>(null)
const toolbarOverflow = ref(false)
let resizeObserver: ResizeObserver | null = null

function checkOverflow() {
  if (!tabBarRef.value) return
  const barWidth = tabBarRef.value.clientWidth
  let tabsWidth = 0
  tabBarRef.value.querySelectorAll('.tab').forEach(tab => {
    tabsWidth += (tab as HTMLElement).offsetWidth
  })
  const padding = 24
  const toolbarNeeded = 195
  toolbarOverflow.value = tabsWidth > 0 && (barWidth - tabsWidth - padding) < toolbarNeeded
}

// More dropdown (overflow)
const showMoreDropdown = ref(false)
const moreBtnRef = ref<HTMLElement | null>(null)
const moreDropdownRef = ref<HTMLElement | null>(null)
const moreDropdownPos = ref({ top: 0, left: 0 })
const moreDropdownStyle = computed(() => ({
  top: moreDropdownPos.value.top + 'px',
  left: moreDropdownPos.value.left + 'px'
}))

function toggleMoreDropdown() {
  if (showMoreDropdown.value) {
    showMoreDropdown.value = false
    return
  }
  if (moreBtnRef.value) {
    const rect = moreBtnRef.value.getBoundingClientRect()
    const parent = moreBtnRef.value.closest('.tab-bar')
    if (parent) {
      const parentRect = parent.getBoundingClientRect()
      moreDropdownPos.value = {
        top: rect.bottom - parentRect.top + 2,
        left: Math.max(0, rect.right - parentRect.left - 200)
      }
    }
  }
  showMoreDropdown.value = true
}

// Tab rename
const editingTabId = ref<string | null>(null)
const editTabTitle = ref('')
const tabTitleInput = ref<HTMLInputElement | null>(null)

// Drag reorder (within same pane)
let dragFromIdx = -1
function onTabDragStart(e: DragEvent, tab: Tab, idx: number) {
  dragFromIdx = idx
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', JSON.stringify({
      tabId: tab.id,
      fromGroupId: props.groupId,
      tabType: tab.type,
      tabUrl: tab.browserUrl || '',
      tabTitle: tab.title
    }))
  }
}
function dragDrop(toIdx: number) {
  if (dragFromIdx !== toIdx && dragFromIdx !== -1) {
    tabStore.reorderTabs(props.projectId, props.groupId, dragFromIdx, toIdx)
  }
  dragFromIdx = -1
}

// Cross-pane drag
let dragOverCount = 0

function onDragEnter(e: DragEvent) {
  dragOverCount++
  if (e.dataTransfer?.types.includes('text/plain')) {
    // dragOver handled by parent via class
  }
}

function onDragLeave(_e: DragEvent) {
  dragOverCount--
}

function onDrop(e: DragEvent) {
  dragOverCount = 0
  dragFromIdx = -1

  const raw = e.dataTransfer?.getData('text/plain')
  if (!raw) return

  try {
    const data = JSON.parse(raw)
    if (data.tabId && data.fromGroupId && data.fromGroupId !== props.groupId) {
      tabStore.moveTab(props.projectId, data.tabId, props.groupId)
    }
  } catch { /* ignore */ }
}

function tabIcon(type: TabType): string {
  return resolveTabIcon(type)
}

async function createTab(type: TabType) {
  const extra: Partial<Tab> = {}
  if (type === 'terminal') extra.terminalCwd = projectStore.activeProject?.path
  if (type === 'browser') extra.browserUrl = 'https://www.google.com'
  extra.title = resolveTabTitle(type)
  await tabStore.addTab(props.projectId, type, extra)
}

function splitPane(direction: 'horizontal' | 'vertical') {
  const activeTab = tabStore.getGroupActiveTab(props.projectId, props.groupId)
  tabStore.splitPane(props.projectId, direction, activeTab || undefined)
}

function closeThisPane() {
  tabStore.closePane(props.projectId, props.groupId)
}

function showTabMenu(e: MouseEvent, tab: Tab, _idx: number) {
  showMenu(e, [
    { label: t('tab.splitRight'), icon: 'columns', action: () => tabStore.splitPane(props.projectId, 'horizontal', tab) },
    { label: t('tab.splitDown'), icon: 'rows', action: () => tabStore.splitPane(props.projectId, 'vertical', tab) },
    { separator: true },
    { label: t('tab.rename'), icon: 'file-text', action: () => startTabRename(tab) },
    { label: t('tab.duplicate'), icon: 'copy', action: () => tabStore.duplicateTab(props.projectId, tab.id) },
    { separator: true },
    { label: t('tab.close'), icon: 'x', action: () => confirmCloseTab(tab) },
    { label: t('tab.closeOthers'), icon: 'x-circle', action: () => confirmCloseOtherTabs(tab.id) },
    { label: t('tab.closeToRight'), icon: 'chevrons-right', action: () => confirmCloseTabsToRight(tab.id) },
    { separator: true },
    {
      label: t('tab.closePane'),
      icon: 'x',
      danger: true,
      action: () => tabStore.closePane(props.projectId, props.groupId)
    }
  ])
}

function confirmCloseTab(tab: Tab): void {
  if (tab.modified && !confirm(t('editor.unsavedCloseConfirm', { name: tab.title }))) return
  tabStore.closeTab(props.projectId, tab.id)
}

function confirmCloseOtherTabs(keepTabId: string): void {
  const group = tabStore.getGroup(props.projectId, props.groupId)
  if (!group) return
  const modified = group.tabs.filter(t => t.id !== keepTabId && t.modified)
  if (modified.length > 0 && !confirm(t('editor.unsavedCloseOthers', { count: String(modified.length) }))) return
  tabStore.closeOtherTabs(props.projectId, keepTabId)
}

function confirmCloseTabsToRight(fromTabId: string): void {
  const group = tabStore.getGroup(props.projectId, props.groupId)
  if (!group) return
  const idx = group.tabs.findIndex(t => t.id === fromTabId)
  if (idx === -1) return
  const modified = group.tabs.slice(idx + 1).filter(t => t.modified)
  if (modified.length > 0 && !confirm(t('editor.unsavedCloseRight', { count: String(modified.length) }))) return
  tabStore.closeTabsToRight(props.projectId, props.groupId, fromTabId)
}

function startTabRename(tab: Tab) {
  editingTabId.value = tab.id
  editTabTitle.value = tab.title
  nextTick(() => tabTitleInput.value?.select())
}

async function commitTabRename() {
  if (editTabTitle.value.trim() && editingTabId.value) {
    await tabStore.renameTab(props.projectId, editingTabId.value, editTabTitle.value.trim())
  }
  editingTabId.value = null
}

function cancelTabRename() {
  editingTabId.value = null
}

function onTabScroll(e: WheelEvent) {
  const bar = e.currentTarget as HTMLElement
  bar.scrollLeft += e.deltaY
}

function handleClickOutside(e: MouseEvent) {
  if (!showMoreDropdown.value) return
  const target = e.target as Node
  if (!moreBtnRef.value?.contains(target) && !moreDropdownRef.value?.contains(target)) {
    showMoreDropdown.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  resizeObserver = new ResizeObserver(() => checkOverflow())
  if (tabBarRef.value) resizeObserver.observe(tabBarRef.value)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  resizeObserver?.disconnect()
})
</script>

<style scoped>
.tab-bar {
  display: flex;
  align-items: flex-end;
  height: var(--tab-height, 30px);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
  overflow-y: hidden;
  flex-shrink: 0;
  gap: 0;
  padding: 0 6px;
  -webkit-app-region: drag;
  cursor: default;
}
.tab-bar::-webkit-scrollbar { height: 0; }

.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  height: 26px;
  min-width: 90px;
  max-width: 180px;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-secondary);
  user-select: none;
  flex-shrink: 0;
  border-radius: 6px 6px 0 0;
  background: transparent;
  border-top: 1px solid transparent;
  -webkit-app-region: no-drag;
  transition: background var(--transition-fast) ease, color var(--transition-fast) ease;
}
.tab:hover { background: var(--bg-hover); color: var(--text-primary); }
.tab.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  height: calc(var(--tab-height, 30px) - 2px);
  border-top: 1px solid var(--text-accent);
}

.tab-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}
.tab.active .tab-icon { color: var(--text-accent); }
.tab-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab-title-input {
  flex: 1;
  font-size: 11px;
  padding: 1px 4px;
  background: var(--bg-tertiary);
  border: 1px solid var(--text-accent);
  color: var(--text-primary);
  border-radius: 2px;
}
.tab-modified-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d97706;
  flex-shrink: 0;
}
.tab-close {
  color: var(--text-secondary);
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  opacity: 0;
}
.tab:hover .tab-close,
.tab.active .tab-close { opacity: 1; }
.tab-close:hover { background: var(--bg-hover); color: var(--text-primary); }

.tab-toolbar {
  display: flex;
  align-items: flex-end;
  flex-shrink: 0;
  height: 100%;
  margin-left: auto;
  -webkit-app-region: no-drag;
}
.tab-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  height: 100%;
  color: var(--text-secondary);
}
.tab-action-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

.tab-dropdown {
  position: absolute;
  margin-top: 2px;
  min-width: 160px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  z-index: 100;
  overflow: hidden;
  -webkit-app-region: no-drag;
}
.tab-dropdown-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  cursor: pointer;
  transition: background 0.15s;
}
.tab-dropdown-item:hover { background: var(--bg-hover); }
.tab-dropdown-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  color: var(--text-secondary);
}
.tab-dropdown-name { font-size: 13px; font-weight: 500; }
.tab-dropdown-separator {
  height: 1px;
  background: var(--border-color);
  margin: 4px 8px;
}
.tab-dropdown-desc { font-size: 11px; color: var(--text-secondary); }
</style>