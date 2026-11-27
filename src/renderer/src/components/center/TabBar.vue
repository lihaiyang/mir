<template>
  <div
    ref="tabBarRef"
    class="tab-bar"
    role="tablist"
    :aria-label="t('tab.tabList')"
    :class="{ 'is-reordering': draggingTabIdx !== null }"
    :data-group-id="groupId"
    :data-project-id="projectId"
    @wheel.prevent="onTabScroll"
  >
    <div
      v-for="(tab, idx) in tabs"
      :key="tab.id"
      :ref="(el: unknown) => setTabEl(tab.id, el)"
      class="tab"
      role="tab"
      :aria-selected="tab.id === activeTabId"
      :tabindex="tab.id === activeTabId ? 0 : -1"
      :class="{ active: tab.id === activeTabId, modified: tab.modified }"
      :style="tabDragStyle(idx)"
      @mousedown.left="onTabMouseDown($event, idx, tab)"
      @click="onTabClick(tab.id)"
      @keydown="onTabKeydown($event, idx, tab)"
      @mousedown.middle.prevent="confirmCloseTab(tab)"
      @contextmenu.prevent="showTabMenu($event, tab, idx)"
    >
      <span class="tab-icon"><Icon :name="tabIcon(tab.type)" :size="16" /></span>
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
        @mousedown.stop
        @click.stop="confirmCloseTab(tab)"
       :aria-label="t('tab.close')"><Icon name="x" :size="12" /></button>
    </div>

    <!-- Floating drag ghost for project tab -->
    <Teleport to="body">
      <div
        v-if="dragGhost"
        class="tab-ghost"
        :class="{ active: dragGhost.active }"
        :style="{
          left: dragGhost.x + 'px',
          top: dragGhost.y + 'px',
          width: dragGhost.width + 'px'
        }"
      >
        <span class="tab-ghost-icon"><Icon :name="dragGhost.icon" :size="16" /></span>
        <span class="tab-ghost-title">{{ dragGhost.title }}</span>
      </div>
    </Teleport>
    <div class="tab-toolbar" ref="toolbarRef">
      <template v-if="!toolbarOverflow">
        <button class="tab-action-btn" :title="t('tab.terminal')" @click.stop="createTab('terminal')" :aria-label="t('tab.terminal')"><Icon name="terminal" :size="17" /></button>
        <button class="tab-action-btn" :title="t('tab.fileEditor')" @click.stop="createTab('editor')" :aria-label="t('tab.fileEditor')"><Icon name="file-text" :size="17" /></button>
        <button class="tab-action-btn" :title="t('tab.browser')" @click.stop="createTab('browser')" :aria-label="t('tab.browser')"><Icon name="globe" :size="17" /></button>
        <button class="tab-action-btn" :title="t('tab.splitDown')" @click.stop="splitPane('vertical')" :aria-label="t('tab.splitDown')"><Icon name="rows" :size="17" /></button>
        <button class="tab-action-btn" :title="t('tab.splitRight')" @click.stop="splitPane('horizontal')" :aria-label="t('tab.splitRight')"><Icon name="columns" :size="17" /></button>
        <button class="tab-action-btn" :title="t('tab.closePane')" @click.stop="closeThisPane" :aria-label="t('tab.closePane')"><Icon name="x" :size="17" /></button>
      </template>
      <button v-else ref="moreBtnRef" class="tab-action-btn" @click.stop="toggleMoreDropdown" :aria-label="t('tab.more')"><Icon name="more" :size="17" /></button>
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
        <span class="tab-dropdown-icon"><Icon name="terminal" :size="16" /></span>
        <div class="tab-dropdown-name">{{ t('tab.terminal') }}</div>
      </div>
      <div class="tab-dropdown-item" @click="createTab('editor'); showMoreDropdown = false">
        <span class="tab-dropdown-icon"><Icon name="file-text" :size="16" /></span>
        <div class="tab-dropdown-name">{{ t('tab.fileEditor') }}</div>
      </div>
      <div class="tab-dropdown-item" @click="createTab('browser'); showMoreDropdown = false">
        <span class="tab-dropdown-icon"><Icon name="globe" :size="16" /></span>
        <div class="tab-dropdown-name">{{ t('tab.browser') }}</div>
      </div>
      <div class="tab-dropdown-separator"></div>
      <div class="tab-dropdown-item" @click="splitPane('vertical'); showMoreDropdown = false">
        <span class="tab-dropdown-icon"><Icon name="rows" :size="16" /></span>
        <div class="tab-dropdown-name">{{ t('tab.splitDown') }}</div>
      </div>
      <div class="tab-dropdown-item" @click="splitPane('horizontal'); showMoreDropdown = false">
        <span class="tab-dropdown-icon"><Icon name="columns" :size="16" /></span>
        <div class="tab-dropdown-name">{{ t('tab.splitRight') }}</div>
      </div>
      <div class="tab-dropdown-item" @click="closeThisPane(); showMoreDropdown = false">
        <span class="tab-dropdown-icon"><Icon name="x" :size="16" /></span>
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

// Chrome-style live pointer drag reorder (plus cross-pane move)
const tabEls = new Map<string, HTMLElement>()
function setTabEl(tabId: string, el: unknown) {
  if (el instanceof HTMLElement) tabEls.set(tabId, el)
  else tabEls.delete(tabId)
}

const draggingTabIdx = ref<number | null>(null)
const dragTargetIdx = ref<number | null>(null)
const dragStride = ref(0)
const dragGhost = ref<{
  title: string
  icon: string
  active: boolean
  x: number
  y: number
  width: number
} | null>(null)

let pendingDrag: {
  idx: number
  tab: Tab
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  top: number
  width: number
  stride: number
  slotCenters: number[]
  minX: number
  maxX: number
  moved: boolean
} | null = null
let targetDropBar: HTMLElement | null = null
let suppressNextTabClick = false

function tabDragStyle(idx: number): Record<string, string> | undefined {
  const from = draggingTabIdx.value
  const to = dragTargetIdx.value
  if (from === null || to === null) return undefined
  if (idx === from) return { opacity: '0', pointerEvents: 'none' }
  const stride = dragStride.value
  if (from < to && idx > from && idx <= to) {
    return { transform: `translateX(${-stride}px)` }
  }
  if (from > to && idx >= to && idx < from) {
    return { transform: `translateX(${stride}px)` }
  }
  return { transform: 'translateX(0px)' }
}

function computeTargetSlot(ghostCenterX: number, slotCenters: number[]): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < slotCenters.length; i++) {
    const d = Math.abs(ghostCenterX - slotCenters[i])
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return best
}

function clearTargetDropBar() {
  if (targetDropBar) {
    targetDropBar.classList.remove('tab-bar-drop-target')
    targetDropBar = null
  }
}

function onTabMouseDown(e: MouseEvent, idx: number, tab: Tab) {
  if (e.button !== 0 || editingTabId.value === tab.id) return
  const target = e.target as HTMLElement | null
  if (target?.closest('.tab-close')) return
  const el = tabEls.get(tab.id)
  const rect = el?.getBoundingClientRect()
  const slotRects = tabs.value.map(t => tabEls.get(t.id)?.getBoundingClientRect())
  const slotCenters = slotRects.map((r, i) => (r ? r.left + r.width / 2 : i * 140))
  const firstLeft = slotRects[0]?.left ?? (rect?.left ?? 0)
  const lastRect = slotRects[slotRects.length - 1]
  const width = rect ? rect.width : 140
  const maxX = lastRect ? lastRect.right - width : firstLeft + 400
  pendingDrag = {
    idx,
    tab,
    startX: e.clientX,
    startY: e.clientY,
    offsetX: rect ? e.clientX - rect.left : 60,
    offsetY: rect ? e.clientY - rect.top : 15,
    top: rect ? rect.top : 4,
    width,
    stride: width + 4,
    slotCenters,
    minX: firstLeft - 8,
    maxX: maxX + 8,
    moved: false
  }
  window.addEventListener('mousemove', onTabPointerMove)
  window.addEventListener('mouseup', onTabPointerUp)
  window.addEventListener('keydown', onTabDragKeyDown)
  window.addEventListener('blur', cleanupTabDrag)
}

function onTabDragKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && pendingDrag?.moved) {
    e.preventDefault()
    e.stopPropagation()
    cleanupTabDrag()
  }
}

function findOtherTabBarAt(clientX: number, clientY: number): HTMLElement | null {
  const els = document.elementsFromPoint(clientX, clientY)
  for (const el of els) {
    const bar = (el as HTMLElement).closest?.('.tab-bar[data-group-id]') as HTMLElement | null
    if (bar && bar.dataset.projectId === props.projectId && bar.dataset.groupId !== props.groupId) {
      return bar
    }
  }
  return null
}

function onTabPointerMove(e: MouseEvent) {
  if (!pendingDrag) return
  const dx = e.clientX - pendingDrag.startX
  const dy = e.clientY - pendingDrag.startY
  if (!pendingDrag.moved) {
    if (Math.hypot(dx, dy) < 5) return
    pendingDrag.moved = true
    draggingTabIdx.value = pendingDrag.idx
    dragTargetIdx.value = pendingDrag.idx
    dragStride.value = pendingDrag.stride
    document.body.classList.add('mir-dragging')
    document.body.style.cursor = 'grabbing'
  }

  const otherBar = findOtherTabBarAt(e.clientX, e.clientY)
  if (otherBar) {
    if (targetDropBar !== otherBar) {
      clearTargetDropBar()
      targetDropBar = otherBar
      targetDropBar.classList.add('tab-bar-drop-target')
    }
    dragTargetIdx.value = null
    dragGhost.value = {
      title: pendingDrag.tab.title,
      icon: tabIcon(pendingDrag.tab.type),
      active: pendingDrag.tab.id === activeTabId.value,
      x: e.clientX - pendingDrag.offsetX,
      y: e.clientY - pendingDrag.offsetY,
      width: pendingDrag.width
    }
    return
  }

  clearTargetDropBar()
  const rawX = e.clientX - pendingDrag.offsetX
  const clampedX = Math.max(pendingDrag.minX, Math.min(pendingDrag.maxX, rawX))
  dragGhost.value = {
    title: pendingDrag.tab.title,
    icon: tabIcon(pendingDrag.tab.type),
    active: pendingDrag.tab.id === activeTabId.value,
    x: clampedX,
    y: pendingDrag.top,
    width: pendingDrag.width
  }
  dragTargetIdx.value = computeTargetSlot(clampedX + pendingDrag.width / 2, pendingDrag.slotCenters)
}

function cleanupTabDrag() {
  window.removeEventListener('mousemove', onTabPointerMove)
  window.removeEventListener('mouseup', onTabPointerUp)
  window.removeEventListener('keydown', onTabDragKeyDown)
  window.removeEventListener('blur', cleanupTabDrag)
  document.body.classList.remove('mir-dragging')
  document.body.style.cursor = ''
  clearTargetDropBar()
  pendingDrag = null
  draggingTabIdx.value = null
  dragTargetIdx.value = null
  dragStride.value = 0
  dragGhost.value = null
}

function onTabPointerUp() {
  if (!pendingDrag) return
  const wasMoved = pendingDrag.moved
  const fromIdx = pendingDrag.idx
  const tabId = pendingDrag.tab.id
  const toIdx = dragTargetIdx.value
  const dropGroupId = targetDropBar?.dataset.groupId || null
  cleanupTabDrag()
  if (wasMoved) {
    suppressNextTabClick = true
    setTimeout(() => { suppressNextTabClick = false }, 0)
    if (dropGroupId && dropGroupId !== props.groupId) {
      tabStore.moveTab(props.projectId, tabId, dropGroupId)
    } else if (toIdx !== null && toIdx !== fromIdx) {
      tabStore.reorderTabs(props.projectId, props.groupId, fromIdx, toIdx)
    }
  }
}

function onTabClick(tabId: string) {
  if (suppressNextTabClick) return
  tabStore.setActiveTab(props.projectId, tabId)
}

function onTabKeydown(e: KeyboardEvent, idx: number, tab: Tab) {
  // Only handle keys aimed at the tab itself, not at the rename input or close button
  if (e.target !== e.currentTarget) return
  const list = tabs.value
  if (!list.length) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    onTabClick(tab.id)
    return
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const next = list[(idx + dir + list.length) % list.length]
    if (!next) return
    tabStore.setActiveTab(props.projectId, next.id)
    tabEls.get(next.id)?.focus()
  }
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
  cleanupTabDrag()
  document.removeEventListener('click', handleClickOutside)
  resizeObserver?.disconnect()
})
</script>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  height: var(--tab-height, 40px);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-hairline);
  overflow-x: auto;
  overflow-y: hidden;
  flex-shrink: 0;
  gap: 4px;
  padding: 0 10px;
  -webkit-app-region: drag;
  cursor: default;
}
.tab-bar::-webkit-scrollbar { height: 0; }

.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 28px;
  margin: 0;
  min-width: 90px;
  max-width: 200px;
  cursor: pointer;
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  color: var(--text-secondary);
  user-select: none;
  flex-shrink: 0;
  border-radius: var(--radius-md, 8px);
  border: 1px solid transparent;
  background: transparent;
  -webkit-app-region: no-drag;
  transition: background var(--transition-fast) ease, color var(--transition-fast) ease, border-color var(--transition-fast) ease, box-shadow var(--transition-fast) ease, opacity var(--transition-fast) ease, transform var(--transition-fast) ease;
}
.tab-bar.is-reordering .tab {
  transition: transform 160ms cubic-bezier(0.2, 0, 0, 1);
}
.tab-bar.tab-bar-drop-target {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.tab:hover { background: var(--bg-hover); color: var(--text-primary); }
.tab.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-weight: 500;
  border-color: var(--border-hairline);
  box-shadow: var(--shadow-1);
}
/* Keep the keyboard focus ring visible even on the active tab (its shadow-1 would win otherwise) */
.tab:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.tab-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  transition: color var(--transition-fast) ease;
}
.tab.active .tab-icon { color: var(--accent-strong); }
.tab-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab-title-input {
  flex: 1;
  font-size: var(--text-sm);
  padding: 2px 6px;
  background: var(--bg-tertiary);
  border: 1px solid var(--accent);
  color: var(--text-primary);
  border-radius: var(--radius-xs);
}
.tab-modified-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-warning);
  flex-shrink: 0;
}
.tab.active .tab-modified-dot { background: var(--text-warning); }
.tab-close {
  color: var(--text-faint);
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xs);
  opacity: 0;
  transition: opacity var(--transition-fast) ease, background var(--transition-fast) ease, color var(--transition-fast) ease;
}
.tab:hover .tab-close,
.tab.active .tab-close { opacity: 1; }
.tab.active .tab-close { color: var(--text-secondary); opacity: 0.8; }
.tab.active .tab-close:hover { background: var(--bg-hover); color: var(--text-danger); opacity: 1; }
.tab-close:hover { background: var(--bg-hover); color: var(--text-danger); }

.tab-toolbar {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  height: 100%;
  margin-left: auto;
  gap: 4px;
  -webkit-app-region: no-drag;
}
.tab-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  padding: 0;
  height: 28px;
  border-radius: var(--radius-xs);
  color: var(--text-faint);
}
.tab-action-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

.tab-dropdown {
  position: absolute;
  margin-top: 4px;
  min-width: 168px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-panel);
  padding: 6px;
  z-index: 100;
  overflow: hidden;
  -webkit-app-region: no-drag;
}
.tab-dropdown-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: background var(--transition-fast) ease;
}
.tab-dropdown-item:hover { background: var(--bg-hover); }
.tab-dropdown-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  color: var(--text-secondary);
}
.tab-dropdown-name { font-size: var(--text-md); line-height: var(--leading-md); font-weight: 500; }
.tab-dropdown-separator {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 6px;
}
.tab-dropdown-desc { font-size: var(--text-xs); color: var(--text-secondary); }
</style>

<style>
.tab-ghost {
  position: fixed;
  z-index: 9500;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--accent);
  color: var(--text-primary);
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  box-shadow: var(--shadow-2);
  pointer-events: none;
  user-select: none;
  opacity: 0.96;
  transform: scale(1.03);
}
.tab-ghost.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-weight: 500;
}
.tab-ghost-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  flex-shrink: 0;
}
.tab-ghost.active .tab-ghost-icon {
  color: var(--accent-strong);
}
.tab-ghost-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>