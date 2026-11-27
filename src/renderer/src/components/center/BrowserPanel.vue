<template>
  <div class="browser-panel">
    <!-- Tab bar (teleported into the title bar) -->
    <Teleport :to="`#mir-browser-tabs-${projectId}`">
      <div ref="tabbarRef" class="bp-tabbar" :class="{ 'is-reordering': draggingTabIdx !== null }" @wheel="onTabbarWheel">
        <div
          v-for="(tab, idx) in tabs"
          :key="tab.id"
          :ref="(el: unknown) => setTabEl(tab.id, el)"
          class="bp-tab"
          :class="{ active: tab.id === activeTabId, 'is-dragging': draggingTabIdx === idx }"
          :style="tabDragStyle(idx)"
          @mousedown.left="onTabMouseDown($event, idx, tab)"
          @click="onTabClick(tab.id)"
          @mousedown.middle="browserStore.closeTab(tab.id, projectId)"
          @contextmenu.prevent="showTabMenu($event, tab)"
        >
          <span v-if="state(tab.id).isLoading" class="bp-tab-spinner" />
          <img
            v-else-if="tab.favicon"
            :src="tab.favicon"
            class="bp-tab-favicon"
            alt=""
            @error="browserStore.updateTab(tab.id, { favicon: undefined }, projectId)"
          />
          <Icon v-else name="globe" :size="13" class="bp-tab-globe" />
          <span class="bp-tab-title">{{ tab.title || tab.url || $t('browser.newTab') }}</span>
          <button class="bp-tab-close" @mousedown.stop @click.stop="browserStore.closeTab(tab.id, projectId)" :aria-label="$t('tab.close')"><Icon name="x" :size="12" /></button>
        </div>
        <button class="bp-new-tab" :title="$t('browser.newTab')" @click="openNewTabAndFocus" :aria-label="$t('browser.newTab')"><Icon name="plus" :size="16" /></button>
      </div>
    </Teleport>

    <!-- Floating drag ghost for browser tab -->
    <Teleport to="body">
      <div
        v-if="dragGhost"
        class="bp-tab-ghost"
        :class="{ active: dragGhost.active }"
        :style="{
          left: dragGhost.x + 'px',
          top: dragGhost.y + 'px',
          width: dragGhost.width + 'px'
        }"
      >
        <img v-if="dragGhost.favicon" :src="dragGhost.favicon" class="bp-tab-favicon" alt="" />
        <Icon v-else name="globe" :size="13" class="bp-tab-globe" />
        <span class="bp-tab-title">{{ dragGhost.title }}</span>
      </div>
    </Teleport>

    <!-- Toolbar: nav + address bar -->
    <div class="bp-toolbar">
      <button class="icon-btn" :disabled="!activeState.canGoBack" @click="goBack" :title="$t('browser.back')" :aria-label="$t('browser.back')"><Icon name="chevron-left" :size="13" /></button>
      <button class="icon-btn" :disabled="!activeState.canGoForward" @click="goForward" :title="$t('browser.forward')" :aria-label="$t('browser.forward')"><Icon name="chevron-right" :size="13" /></button>
      <button
        class="icon-btn"
        @click="activeState.isLoading ? stopLoading() : reload()"
        :title="activeState.isLoading ? $t('browser.stop') : $t('browser.reload')"
       :aria-label="activeState.isLoading ? $t('browser.stop') : $t('browser.reload')"><Icon :name="activeState.isLoading ? 'x' : 'refresh'" :size="13" /></button>
      <button class="icon-btn" @click="goHome" :title="$t('browser.home')" :aria-label="$t('browser.home')"><Icon name="home" :size="13" /></button>
      <input
        ref="addrInput"
        v-model="addrBar"
        class="bp-url-input"
        :placeholder="$t('browser.placeholder')"
        @keydown.enter="navigateTo"
        @focus="($event.target as HTMLInputElement).select()"
      />
      <button
        v-if="Math.round(activeState.zoomFactor * 100) !== 100"
        class="bp-zoom-pill"
        :title="$t('browser.zoomReset')"
        @click="resetZoom"
       :aria-label="$t('browser.zoomReset')">{{ Math.round(activeState.zoomFactor * 100) }}%</button>
      <button
        class="icon-btn"
        :class="{ bookmarked: isBookmarked }"
        :disabled="!canBookmarkActive"
        :title="$t('browser.bookmark')"
        @click="onBookmarkButtonClick"
       :aria-label="$t('browser.bookmark')"><Icon name="star" :size="13" /></button>
      <button
        class="icon-btn"
        :class="{ active: managerOpen }"
        :title="$t('browser.bookmarks')"
        @click="toggleManager()"
       :aria-label="$t('browser.bookmarks')"><Icon name="bookmark" :size="13" /></button>
      <button class="icon-btn" @click="openDevTools" :title="$t('browser.devTools')" :aria-label="$t('browser.devTools')"><Icon name="wrench" :size="13" /></button>
      <button
        v-if="activeUserScriptCommands.length > 0"
        class="icon-btn"
        :title="t('userscripts.menuTitle')"
        @click="showUserScriptMenu"
      ><Icon name="zap" :size="13" /></button>
    </div>

    <!-- Bookmark edit popover (Cmd/Ctrl+D or star click) -->
    <div v-if="popoverOpen" class="bp-bookmark-popover">
      <div class="bp-pop-title">{{ $t('browser.editBookmark') }}</div>
      <div class="bp-pop-field">
        <label>{{ $t('browser.bookmarkTitle') }}</label>
        <input ref="popoverTitleInput" v-model="popoverForm.title" @keydown.enter.prevent="savePopover" @keydown.esc.prevent="popoverOpen = false" />
      </div>
      <div class="bp-pop-field">
        <label>{{ $t('browser.bookmarkUrl') }}</label>
        <input v-model="popoverForm.url" @keydown.enter.prevent="savePopover" @keydown.esc.prevent="popoverOpen = false" />
      </div>
      <div class="bp-pop-field">
        <label>{{ $t('browser.bookmarkFolder') }}</label>
        <input
          v-model="popoverForm.folder"
          list="mir-bookmark-folders"
          :placeholder="$t('browser.bookmarkFolderPlaceholder')"
          @keydown.enter.prevent="savePopover"
          @keydown.esc.prevent="popoverOpen = false"
        />
        <datalist id="mir-bookmark-folders">
          <option v-for="f in bookmarkStore.folders" :key="f" :value="f" />
        </datalist>
      </div>
      <div class="bp-pop-actions">
        <button class="btn-secondary bp-pop-btn" @click="removePopoverBookmark">{{ $t('browser.removeBookmark') }}</button>
        <button class="btn-primary bp-pop-btn" @click="savePopover">{{ $t('common.save') }}</button>
      </div>
    </div>

    <!-- Bookmarks bar -->
    <div v-if="settingsStore.settings.showBookmarksBar && bookmarkStore.bookmarks.length > 0" class="bp-bookmarks-bar">
      <button
        v-for="f in bookmarkStore.folders"
        :key="'folder-' + f"
        class="bp-bookmark-item bp-bookmark-folder"
        @click="openFolderMenu($event, f)"
       :aria-label="f">
        <Icon name="folder" :size="12" />
        <span>{{ f }}</span>
      </button>
      <span
        v-for="bm in rootBookmarks"
        :key="bm.id"
        class="bp-bookmark-item"
        draggable="true"
        @dragstart="onBmDragStart($event, bm.id)"
        @dragover.prevent
        @drop.prevent="onBmDrop(bm.id)"
        @click="openBookmark(bm.url)"
        @mousedown.middle.prevent="browserStore.openTab(bm.url, projectId)"
        @contextmenu.prevent="showBmMenu($event, bm)"
      >
        <img v-if="bm.favicon" :src="bm.favicon" class="bp-bm-favicon" alt="" @error="bookmarkStore.updateBookmark(bm.id, { favicon: undefined })" />
        <Icon v-else name="globe" :size="12" class="bp-bm-globe" />
        <span>{{ bm.title }}</span>
      </span>
    </div>

    <!-- Webviews: one per tab, hidden ones keep compositor state -->
    <div class="bp-webviews">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="bp-webview-slot"
        :class="{ hidden: tab.id !== activeTabId }"
      >
        <webview
          v-if="tab.url !== NEWTAB_URL"
          :ref="(el: unknown) => setWebview(tab.id, el)"
          class="bp-webview"
          :src="getInitialSrc(tab.id)"
          allowpopups
          webpreferences="contextIsolation=yes"
          partition="persist:browser"
          @will-navigate="(e: WillNavigateEvent) => onWillNavigate(tab.id, e)"
          @did-redirect-navigation="(e: DidRedirectNavigationEvent) => onRedirectNavigation(tab.id, e)"
          @did-navigate="(e: DidNavigateEvent) => onNavigated(tab.id, e)"
          @did-navigate-in-page="(e: DidNavigateInPageEvent) => onNavigatedInPage(tab.id, e)"
          @did-start-loading="() => onStartLoading(tab.id)"
          @did-stop-loading="() => onStopLoading(tab.id)"
          @dom-ready="() => onDomReady(tab.id)"
          @page-title-updated="(e: PageTitleUpdatedEvent) => onTitleUpdated(tab.id, e)"
          @page-favicon-updated="(e: PageFaviconUpdatedEvent) => onFaviconUpdated(tab.id, e)"
          @found-in-page="(e: FoundInPageEvent) => onFoundInPage(tab.id, e)"
          @update-target-url="(e: UpdateTargetUrlEvent) => onUpdateTargetUrl(tab.id, e)"
          @ipc-message="(e: any) => onIpcMessage(tab.id, e)"
        />
        <div v-else class="bp-newtab">
          <div class="bp-newtab-inner">
            <div class="bp-newtab-brand">MIR</div>
            <div class="bp-newtab-search">
              <Icon name="search" :size="16" class="bp-newtab-search-icon" />
              <input
                v-model="startPageQuery"
                class="bp-newtab-input"
                :placeholder="$t('browser.startPagePlaceholder')"
                @keydown.enter="submitStartPageSearch(tab.id)"
              />
            </div>
            <div class="bp-newtab-section-head">
              <span>{{ $t('browser.bookmarks') }}</span>
            </div>
            <div class="bp-speed-dial">
              <div
                v-for="bm in bookmarkStore.bookmarks"
                :key="bm.id"
                class="bp-dial-item"
                @click="openBookmark(bm.url, tab.id)"
                @mousedown.middle.prevent="browserStore.openTab(bm.url, projectId)"
                @contextmenu.prevent="showBmMenu($event, bm)"
              >
                <div class="bp-dial-icon">
                  <img v-if="bm.favicon" :src="bm.favicon" class="bp-dial-favicon" alt="" @error="bookmarkStore.updateBookmark(bm.id, { favicon: undefined })" />
                  <span v-else class="bp-dial-letter">{{ bookmarkMonogram(bm) }}</span>
                </div>
                <span class="bp-dial-title">{{ bm.title }}</span>
              </div>
              <div class="bp-dial-item bp-dial-add" @click="openManagerForAdd">
                <div class="bp-dial-icon"><Icon name="plus" :size="18" /></div>
                <span class="bp-dial-title">{{ $t('browser.addBookmark') }}</span>
              </div>
            </div>
            <button class="bp-newtab-settings-link" @click="openSettings" :aria-label="$t('browser.customizeHomepage')">
              <Icon name="settings" :size="12" />
              <span>{{ $t('browser.customizeHomepage') }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Bookmarks Manager Drawer -->
      <div v-if="managerOpen" class="bp-bookmarks-drawer">
        <div class="bp-drawer-head">
          <span class="bp-drawer-title">{{ $t('browser.bookmarks') }}</span>
          <div class="bp-drawer-actions">
            <button class="btn-secondary bp-drawer-add-btn" @click="startNewBookmarkForm" :aria-label="$t('browser.addBookmark')">
              <Icon name="plus" :size="12" /> {{ $t('browser.addBookmark') }}
            </button>
            <button class="icon-btn" @click="managerOpen = false" :aria-label="$t('common.close')"><Icon name="x" :size="13" /></button>
          </div>
        </div>

        <div class="bp-drawer-filter">
          <input
            v-model="bmSearchQuery"
            class="bp-drawer-search"
            :placeholder="$t('browser.searchBookmarks')"
          />
          <div v-if="bookmarkStore.folders.length > 0" class="bp-drawer-folders">
            <button
              class="bp-folder-pill"
              :class="{ active: bmFolderFilter === '' }"
              @click="bmFolderFilter = ''"
            >{{ $t('browser.allBookmarks') }}</button>
            <button
              v-for="f in bookmarkStore.folders"
              :key="f"
              class="bp-folder-pill"
              :class="{ active: bmFolderFilter === f }"
              @click="bmFolderFilter = f"
            >{{ f }}</button>
          </div>
        </div>

        <div v-if="bmFormOpen" class="bp-drawer-form">
          <input v-model="bmForm.title" :placeholder="$t('browser.bookmarkTitle')" />
          <input v-model="bmForm.url" :placeholder="$t('browser.bookmarkUrl')" />
          <input v-model="bmForm.folder" list="mir-bookmark-folders" :placeholder="$t('browser.bookmarkFolderPlaceholder')" />
          <div class="bp-drawer-form-actions">
            <button class="btn-secondary bp-pop-btn" @click="bmFormOpen = false">{{ $t('common.cancel') }}</button>
            <button class="btn-primary bp-pop-btn" @click="saveManagerForm">{{ $t('common.save') }}</button>
          </div>
        </div>

        <div class="bp-drawer-list">
          <div v-if="filteredBookmarks.length === 0" class="bp-drawer-empty">
            {{ $t('browser.noBookmarks') }}
          </div>
          <div
            v-for="bm in filteredBookmarks"
            :key="bm.id"
            class="bp-drawer-item"
            @click="openBookmark(bm.url)"
            @mousedown.middle.prevent="browserStore.openTab(bm.url, projectId)"
          >
            <img v-if="bm.favicon" :src="bm.favicon" class="bp-bm-favicon" alt="" />
            <Icon v-else name="globe" :size="13" class="bp-bm-globe" />
            <div class="bp-drawer-item-info">
              <div class="bp-drawer-item-title">{{ bm.title }}</div>
              <div class="bp-drawer-item-url">{{ bm.url }}</div>
            </div>
            <span v-if="bm.folder" class="bp-drawer-item-folder">{{ bm.folder }}</span>
            <div class="bp-drawer-item-btns" @click.stop>
              <button class="icon-btn" :title="$t('browser.openInNewTab')" @click="browserStore.openTab(bm.url, projectId)" :aria-label="$t('browser.openInNewTab')"><Icon name="external-link" :size="12" /></button>
              <button class="icon-btn" :title="$t('browser.editBookmark')" @click="startEditBookmarkForm(bm)" :aria-label="$t('browser.editBookmark')"><Icon name="edit" :size="12" /></button>
              <button class="icon-btn" :title="$t('browser.removeBookmark')" @click="bookmarkStore.removeBookmark(bm.id)" :aria-label="$t('browser.removeBookmark')"><Icon name="trash" :size="12" /></button>
            </div>
          </div>
        </div>
      </div>

      <!-- In-page find bar (Cmd/Ctrl+F) -->
      <div v-if="findOpen" class="bp-find-bar">
        <input
          ref="findInput"
          v-model="findQuery"
          class="bp-find-input"
          :placeholder="$t('browser.findInPage')"
          @input="runFind(true, false)"
          @keydown.enter.prevent="runFind(!$event.shiftKey, true)"
          @keydown.esc.prevent="closeFind"
        />
        <span class="bp-find-count">
          <template v-if="findQuery">{{ findTotal > 0 ? `${findActive}/${findTotal}` : $t('browser.findNoMatch') }}</template>
        </span>
        <button class="icon-btn" @click="runFind(false, true)" :aria-label="$t('browser.findPrev')"><Icon name="chevron-left" :size="13" /></button>
        <button class="icon-btn" @click="runFind(true, true)" :aria-label="$t('browser.findNext')"><Icon name="chevron-right" :size="13" /></button>
        <button class="icon-btn" @click="closeFind" :aria-label="$t('common.close')"><Icon name="x" :size="13" /></button>
      </div>

      <!-- Hover link preview pill -->
      <div v-if="hoverUrl" class="bp-hover-url">{{ hoverUrl }}</div>

      <div v-if="tabs.length === 0" class="bp-empty">
        <div class="empty-icon"><Icon name="globe" :size="28" /></div>
        <p>{{ $t('browser.noTabs') }}</p>
        <button class="btn-primary" @click="openNewTabAndFocus" :aria-label="$t('browser.newTab')"><Icon name="plus" :size="13" /> {{ $t('browser.newTab') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, reactive, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBrowserStore, browserReloadBus, browserActionBus, PINNED_BROWSER_PROJECT_ID, NEWTAB_URL, type BrowserTabState } from '../../stores/browser'
import { useBookmarkStore, type BookmarkItem } from '../../stores/bookmarks'
import { useSettingsStore } from '../../stores/settings'
import { openSettings } from '../../composables/useGlobalActions'
import type {
  WebviewTag,
  WillNavigateEvent,
  DidRedirectNavigationEvent,
  DidNavigateEvent,
  DidNavigateInPageEvent,
  PageTitleUpdatedEvent,
  PageFaviconUpdatedEvent,
  FoundInPageEvent,
  UpdateTargetUrlEvent
} from 'electron'
import Icon from '../ui/Icon.vue'
import { injectSlimScrollbar } from '../../utils/webviewScrollbar'
import { useContextMenu } from '../../composables/useContextMenu'
import {
  USERSCRIPT_HOST_CHANNEL,
  type UserScriptHostMessage,
  type UserScriptMenuCommand
} from '@shared/userscripts'

const props = withDefaults(defineProps<{ projectId?: string }>(), {
  projectId: PINNED_BROWSER_PROJECT_ID
})

const { t } = useI18n()
const browserStore = useBrowserStore()
const bookmarkStore = useBookmarkStore()
const settingsStore = useSettingsStore()

const tabs = computed(() => browserStore.getTabs(props.projectId))

/** 每个标签页各自维护脚本菜单项（页面切换会重新注册） */
const userScriptCommandsByTab = reactive<Record<string, UserScriptMenuCommand[]>>({})
const { show: showMenu } = useContextMenu()
const activeTabId = computed(() => browserStore.getActiveTabId(props.projectId))
const activeTab = computed(() => tabs.value.find(t => t.id === activeTabId.value) ?? null)

// Webview registry: tabId → webview element
const webviews = reactive<Record<string, WebviewTag | null>>({})
function setWebview(id: string, el: unknown) {
  if (el) webviews[id] = el as WebviewTag
  else delete webviews[id]
}

// Frozen per-tab initial src. Unlike BrowserTab, we must NOT bind :src to the
// live `tab.url` — updating tab.url on every navigation would change :src and
// make the webview re-navigate, causing redirects to bounce back and forth.
const initialSrcs = reactive<Record<string, string>>({})
function getInitialSrc(id: string): string {
  if (!initialSrcs[id]) {
    initialSrcs[id] = tabs.value.find(t => t.id === id)?.url ?? ''
  }
  return initialSrcs[id]
}

// Transient per-tab state (not persisted)
const tabState = reactive<Record<string, { canGoBack: boolean; canGoForward: boolean; isLoading: boolean; zoomFactor: number }>>({})
function state(id: string) {
  if (!tabState[id]) tabState[id] = { canGoBack: false, canGoForward: false, isLoading: false, zoomFactor: 1 }
  return tabState[id]
}
// Prune per-tab bookkeeping when browser tabs close, so long panel lifetimes
// don't accumulate entries for dead tab ids.
watch(() => tabs.value.map(t => t.id).join(','), () => {
  const alive = new Set(tabs.value.map(t => t.id))
  for (const id of Object.keys(initialSrcs)) {
    if (!alive.has(id)) delete initialSrcs[id]
  }
  for (const id of Object.keys(tabState)) {
    if (!alive.has(id)) delete tabState[id]
  }
  for (const id of Array.from(redirecting)) {
    if (!alive.has(id)) redirecting.delete(id)
  }
})
const activeState = computed(() => activeTab.value ? state(activeTab.value.id) : { canGoBack: false, canGoForward: false, isLoading: false, zoomFactor: 1 })

const addrInput = ref<HTMLInputElement | null>(null)
const addrBar = ref('')
const startPageQuery = ref('')
watch(() => activeTab.value?.url, (u) => {
  addrBar.value = u && u !== NEWTAB_URL ? u : ''
}, { immediate: true })
watch(activeTabId, () => {
  hoverUrl.value = ''
  popoverOpen.value = false
  if (findOpen.value) closeFind()
})

// Bookmarks
const canBookmarkActive = computed(() => {
  const u = activeTab.value?.url
  return !!u && u !== NEWTAB_URL
})
const isBookmarked = computed(() => {
  const u = activeTab.value?.url
  return !!u && u !== NEWTAB_URL && bookmarkStore.isBookmarked(u)
})
const rootBookmarks = computed(() => bookmarkStore.bookmarks.filter(b => !b.folder))

onMounted(async () => {
  await bookmarkStore.load()
})

// Bookmark edit popover (star click / Cmd+D)
const popoverOpen = ref(false)
const popoverTitleInput = ref<HTMLInputElement | null>(null)
const popoverForm = reactive<{ id: string; title: string; url: string; folder: string }>({
  id: '',
  title: '',
  url: '',
  folder: ''
})

function onBookmarkButtonClick() {
  const tab = activeTab.value
  if (!tab || !tab.url || tab.url === NEWTAB_URL) return
  if (popoverOpen.value) {
    popoverOpen.value = false
    return
  }
  const existing = bookmarkStore.findByUrl(tab.url)
  const item = existing ?? bookmarkStore.addBookmark({
    title: tab.title || tab.url,
    url: tab.url,
    favicon: tab.favicon
  })
  popoverForm.id = item.id
  popoverForm.title = item.title
  popoverForm.url = item.url
  popoverForm.folder = item.folder || ''
  popoverOpen.value = true
  void nextTick(() => {
    popoverTitleInput.value?.focus()
    popoverTitleInput.value?.select()
  })
}

function savePopover() {
  if (!popoverForm.id) return
  bookmarkStore.updateBookmark(popoverForm.id, {
    title: popoverForm.title,
    url: popoverForm.url,
    folder: popoverForm.folder
  })
  popoverOpen.value = false
}

function removePopoverBookmark() {
  if (popoverForm.id) bookmarkStore.removeBookmark(popoverForm.id)
  popoverOpen.value = false
}

// Bookmarks Manager Drawer
const managerOpen = ref(false)
const bmSearchQuery = ref('')
const bmFolderFilter = ref('')
const bmFormOpen = ref(false)
const bmForm = reactive<{ id: string; title: string; url: string; folder: string }>({
  id: '',
  title: '',
  url: '',
  folder: ''
})

const filteredBookmarks = computed(() => {
  const q = bmSearchQuery.value.trim().toLowerCase()
  return bookmarkStore.bookmarks.filter(b => {
    if (bmFolderFilter.value && (b.folder || '') !== bmFolderFilter.value) return false
    if (!q) return true
    return (
      b.title.toLowerCase().includes(q) ||
      b.url.toLowerCase().includes(q) ||
      (b.folder || '').toLowerCase().includes(q)
    )
  })
})

function toggleManager() {
  managerOpen.value = !managerOpen.value
  if (!managerOpen.value) bmFormOpen.value = false
}

function openManagerForAdd() {
  managerOpen.value = true
  startNewBookmarkForm()
}

function startNewBookmarkForm() {
  const tab = activeTab.value
  bmForm.id = ''
  bmForm.title = tab && tab.url !== NEWTAB_URL ? (tab.title || '') : ''
  bmForm.url = tab && tab.url !== NEWTAB_URL ? tab.url : ''
  bmForm.folder = bmFolderFilter.value || ''
  bmFormOpen.value = true
}

function startEditBookmarkForm(bm: BookmarkItem) {
  managerOpen.value = true
  bmForm.id = bm.id
  bmForm.title = bm.title
  bmForm.url = bm.url
  bmForm.folder = bm.folder || ''
  bmFormOpen.value = true
}

function saveManagerForm() {
  const rawUrl = bmForm.url.trim()
  if (!rawUrl) return
  const normalized = normalizeUrl(rawUrl)
  if (bmForm.id) {
    bookmarkStore.updateBookmark(bmForm.id, {
      title: bmForm.title,
      url: normalized,
      folder: bmForm.folder
    })
  } else {
    bookmarkStore.addBookmark({
      title: bmForm.title,
      url: normalized,
      folder: bmForm.folder
    })
  }
  bmFormOpen.value = false
}

// Drag-to-reorder bookmarks on bar
let dragBmId: string | null = null
function onBmDragStart(e: DragEvent, id: string) {
  dragBmId = id
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onBmDrop(targetId: string) {
  if (dragBmId && dragBmId !== targetId) {
    bookmarkStore.reorderBookmarks(dragBmId, targetId)
  }
  dragBmId = null
}

function openBookmark(url: string, targetTabId?: string) {
  if (settingsStore.settings.openBookmarksInNewTab) {
    browserStore.openTab(url, props.projectId)
  } else if (targetTabId) {
    navigate(targetTabId, url)
  } else {
    navigateActive(url)
  }
}

function openFolderMenu(e: MouseEvent, folder: string) {
  const items = bookmarkStore.bookmarks
    .filter(b => b.folder === folder)
    .map(b => ({
      label: b.title,
      action: () => openBookmark(b.url)
    }))
  if (items.length > 0) showMenu(e, items)
}

function showBmMenu(e: MouseEvent, bm: BookmarkItem) {
  showMenu(e, [
    { label: t('common.open'), action: () => navigateActive(bm.url) },
    { label: t('browser.openInNewTab'), action: () => browserStore.openTab(bm.url, props.projectId) },
    { label: t('browser.editBookmark'), action: () => startEditBookmarkForm(bm) },
    { label: t('contextMenu.copyUrl'), action: () => navigator.clipboard.writeText(bm.url) },
    { separator: true },
    { label: t('browser.removeBookmark'), danger: true, action: () => {
      bookmarkStore.removeBookmark(bm.id)
    }}
  ])
}

function bookmarkMonogram(bm: BookmarkItem): string {
  const s = (bm.title || bm.url || '?').trim()
  return s.charAt(0).toUpperCase()
}

function submitStartPageSearch(tabId: string) {
  const q = startPageQuery.value.trim()
  if (!q) return
  startPageQuery.value = ''
  navigate(tabId, q)
}

// Pointer-based drag-to-reorder tabs (works smoothly inside frameless titlebar
// and over <webview> guests via body.mir-dragging)
const tabbarRef = ref<HTMLElement | null>(null)
const tabEls = new Map<string, HTMLElement>()
function setTabEl(id: string, el: unknown) {
  if (el instanceof HTMLElement) tabEls.set(id, el)
  else tabEls.delete(id)
}

const draggingTabIdx = ref<number | null>(null)
const dragTargetIdx = ref<number | null>(null)
const dragStride = ref(0)
const dragGhost = ref<{
  title: string
  favicon?: string
  active: boolean
  x: number
  y: number
  width: number
} | null>(null)

let pendingDrag: {
  idx: number
  tab: BrowserTabState
  startX: number
  startY: number
  offsetX: number
  top: number
  width: number
  stride: number
  slotCenters: number[]
  minX: number
  maxX: number
  moved: boolean
} | null = null
let suppressNextTabClick = false

function onTabbarWheel(e: WheelEvent) {
  if (!tabbarRef.value) return
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    tabbarRef.value.scrollLeft += e.deltaY
  }
}

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

function onTabMouseDown(e: MouseEvent, idx: number, tab: BrowserTabState) {
  if (e.button !== 0) return
  const target = e.target as HTMLElement | null
  if (target?.closest('.bp-tab-close')) return
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
  const rawX = e.clientX - pendingDrag.offsetX
  const clampedX = Math.max(pendingDrag.minX, Math.min(pendingDrag.maxX, rawX))
  dragGhost.value = {
    title: pendingDrag.tab.title || pendingDrag.tab.url || t('browser.newTab'),
    favicon: pendingDrag.tab.favicon,
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
  const toIdx = dragTargetIdx.value
  cleanupTabDrag()
  if (wasMoved) {
    suppressNextTabClick = true
    setTimeout(() => { suppressNextTabClick = false }, 0)
    if (toIdx !== null && toIdx !== fromIdx) {
      browserStore.reorderTabs(fromIdx, toIdx, props.projectId)
    }
  }
}

function onTabClick(tabId: string) {
  if (suppressNextTabClick) return
  browserStore.setActiveTab(tabId, props.projectId)
}

function showTabMenu(e: MouseEvent, tab: BrowserTabState) {
  showMenu(e, [
    { label: t('browser.reload'), action: () => {
      if (tab.url) webviews[tab.id]?.loadURL(tab.url)
      else webviews[tab.id]?.reload()
    }},
    { label: t('browser.duplicateTab'), action: () => browserStore.duplicateTab(tab.id, props.projectId) },
    { label: t('browser.copyUrl'), action: () => navigator.clipboard.writeText(tab.url || '') },
    { separator: true },
    { label: t('browser.closeOthers'), action: () => browserStore.closeOtherTabs(tab.id, props.projectId) },
    { label: t('browser.closeToRight'), action: () => browserStore.closeTabsToRight(tab.id, props.projectId) },
    { label: t('tab.close'), danger: true, action: () => browserStore.closeTab(tab.id, props.projectId) }
  ])
}

function openNewTabAndFocus() {
  browserStore.openTab(undefined, props.projectId)
  void nextTick(() => addrInput.value?.focus())
}

// Tabs currently mid server-redirect: their `did-navigate` must NOT overwrite the
// intended (pre-redirect) URL — otherwise SSO/host wrappers like
// oa.neixin.cn/task-new?hostdomain=… would hijack the address bar.
const redirecting = new Set<string>()

function normalizeUrl(raw: string): string {
  let u = raw.trim()
  if (!u.startsWith('http://') && !u.startsWith('https://') && !u.startsWith('file://')) {
    if (u.includes('.') && !u.includes(' ')) u = 'https://' + u
    else u = settingsStore.settings.defaultSearchEngine + encodeURIComponent(u)
  }
  return u
}

function navigate(tabId: string, url: string) {
  const trimmed = url.trim()
  if (trimmed === NEWTAB_URL) {
    browserStore.updateTab(tabId, { url: NEWTAB_URL, title: '' }, props.projectId)
    return
  }
  const u = normalizeUrl(url)
  const curTab = tabs.value.find(t => t.id === tabId)
  // If transitioning out of the built-in Start Page, seed initialSrcs before
  // updating tab.url so the newly mounted <webview> loads `u` immediately.
  if (curTab?.url === NEWTAB_URL || !initialSrcs[tabId]) {
    initialSrcs[tabId] = u
  }
  // Record the URL the user asked for as the display/persisted URL before loading;
  // redirects will not overwrite it.
  browserStore.updateTab(tabId, { url: u }, props.projectId)
  webviews[tabId]?.loadURL(u)
}

function goHome() {
  if (!activeTab.value) return
  navigate(activeTab.value.id, browserStore.resolveHomeUrl())
}

function navigateTo() {
  if (!activeTab.value) return
  navigate(activeTab.value.id, addrBar.value)
}

function navigateActive(url: string) {
  if (!activeTab.value) return
  navigate(activeTab.value.id, url)
}

function goBack() { webviews[activeTabId.value ?? '']?.goBack() }
function goForward() { webviews[activeTabId.value ?? '']?.goForward() }
function stopLoading() { webviews[activeTabId.value ?? '']?.stop() }
function reload() {
  const id = activeTabId.value
  if (!id) return
  const t = tabs.value.find(t => t.id === id)
  // Reload the intended URL (not the current redirect target) so SSO wrappers
  // re-run their redirect chain instead of breaking.
  if (t?.url) webviews[id]?.loadURL(t.url)
  else webviews[id]?.reload()
}
function hardReload() {
  const id = activeTabId.value
  if (!id) return
  webviews[id]?.reloadIgnoringCache()
}

function setZoom(next: number) {
  const id = activeTabId.value
  if (!id) return
  const clamped = Math.round(Math.max(0.25, Math.min(3.0, next)) * 100) / 100
  state(id).zoomFactor = clamped
  webviews[id]?.setZoomFactor(clamped)
}
function zoomIn() { setZoom(activeState.value.zoomFactor + 0.1) }
function zoomOut() { setZoom(activeState.value.zoomFactor - 0.1) }
function resetZoom() { setZoom(1) }

// In-page find
const findOpen = ref(false)
const findQuery = ref('')
const findActive = ref(0)
const findTotal = ref(0)
const findInput = ref<HTMLInputElement | null>(null)

function openFind() {
  findOpen.value = true
  void nextTick(() => {
    findInput.value?.focus()
    findInput.value?.select()
  })
}
function runFind(forward: boolean, findNext: boolean) {
  const id = activeTabId.value
  const wv = id ? webviews[id] : null
  if (!wv) return
  if (!findQuery.value) {
    findActive.value = 0
    findTotal.value = 0
    wv.stopFindInPage('clearSelection')
    return
  }
  wv.findInPage(findQuery.value, { forward, findNext })
}
function closeFind() {
  findOpen.value = false
  findActive.value = 0
  findTotal.value = 0
  const id = activeTabId.value
  if (id) webviews[id]?.stopFindInPage('clearSelection')
}
function onFoundInPage(id: string, e: FoundInPageEvent) {
  if (id !== activeTabId.value) return
  findActive.value = e.result.activeMatchOrdinal ?? 0
  findTotal.value = e.result.matches ?? 0
}

// Hover link preview
const hoverUrl = ref('')
function onUpdateTargetUrl(id: string, e: UpdateTargetUrlEvent) {
  if (id !== activeTabId.value) return
  hoverUrl.value = e.url || ''
}
function onIpcMessage(tabId: string, e: any) {
  if (e?.channel !== USERSCRIPT_HOST_CHANNEL) return
  const msg = e.args?.[0] as UserScriptHostMessage | undefined
  if (msg?.type === 'menu') {
    userScriptCommandsByTab[tabId] = Array.isArray(msg.commands) ? msg.commands : []
  }
}

const activeUserScriptCommands = computed(() => {
  const id = activeTabId.value
  if (!id) return [] as UserScriptMenuCommand[]
  return userScriptCommandsByTab[id] ?? []
})

function runUserScriptCommand(tabId: string, cmd: UserScriptMenuCommand) {
  const key = `${cmd.scriptId}::${cmd.id}`
  const code =
    `(function(){try{var f=window.__mirUserScriptMenu&&window.__mirUserScriptMenu[${JSON.stringify(key)}];` +
    `if(typeof f==='function')f()}catch(err){console.error('[userscript] 菜单命令执行失败',err)}})()`
  void webviews[tabId]?.executeJavaScript(code).catch(() => {})
}

function showUserScriptMenu(e: MouseEvent) {
  const tabId = activeTabId.value
  if (!tabId) return
  const items = activeUserScriptCommands.value.map(cmd => ({
    label: `${cmd.scriptName} · ${cmd.title}`,
    action: () => runUserScriptCommand(tabId, cmd)
  }))
  if (items.length > 0) showMenu(e, items)
}

function openDevTools() { webviews[activeTabId.value ?? '']?.openDevTools() }

function onStartLoading(id: string) {
  state(id).isLoading = true
  // 新文档开始加载：上一页的脚本菜单作废，等本页脚本重新注册
  userScriptCommandsByTab[id] = []
}
function onStopLoading(id: string) { state(id).isLoading = false }
function onDomReady(id: string) { injectSlimScrollbar(webviews[id]) }

// Link click / location.href change — this is the user-visible intended URL.
function onWillNavigate(id: string, e: WillNavigateEvent) {
  const url = e?.url
  if (url) browserStore.updateTab(id, { url }, props.projectId)
}

// A server-side redirect happened; mark the tab so did-navigate keeps the URL.
function onRedirectNavigation(id: string, e: DidRedirectNavigationEvent) {
  if (e?.isMainFrame) redirecting.add(id)
}

function onNavigated(id: string, e: DidNavigateEvent) {
  const url = e?.url
  if (url) {
    if (redirecting.has(id)) {
      redirecting.delete(id)
      // Intended URL already recorded (via navigate/will-navigate); do not
      // overwrite it with the redirect target.
    } else {
      browserStore.updateTab(id, { url }, props.projectId)
    }
  }
  const st = state(id)
  st.canGoBack = webviews[id]?.canGoBack() ?? false
  st.canGoForward = webviews[id]?.canGoForward() ?? false
}

// In-page navigation (hash change / history.pushState) — keep address bar in sync.
function onNavigatedInPage(id: string, e: DidNavigateInPageEvent) {
  const url = e?.url
  if (url && e?.isMainFrame) browserStore.updateTab(id, { url }, props.projectId)
}

function onTitleUpdated(id: string, e: PageTitleUpdatedEvent) {
  const title = e?.title
  if (title) browserStore.updateTab(id, { title }, props.projectId)
}

function onFaviconUpdated(id: string, e: PageFaviconUpdatedEvent) {
  const favicon = e?.favicons?.[0]
  if (favicon) browserStore.updateTab(id, { favicon }, props.projectId)
}

// Ctrl/Cmd+R / F5 → reload the active tab only (signal from main process).
watch(() => browserReloadBus.nonce, () => {
  if (browserStore.activeProjectId === props.projectId) reload()
})

// Standard browser shortcut bus (dispatched by App.vue)
watch(() => browserActionBus.nonce, () => {
  if (browserStore.activeProjectId !== props.projectId) return
  switch (browserActionBus.action) {
    case 'reload': reload(); break
    case 'hard-reload': hardReload(); break
    case 'focus-address': void nextTick(() => { addrInput.value?.focus(); addrInput.value?.select() }); break
    case 'back': goBack(); break
    case 'forward': goForward(); break
    case 'find': openFind(); break
    case 'bookmark': onBookmarkButtonClick(); break
    case 'zoom-in': zoomIn(); break
    case 'zoom-out': zoomOut(); break
    case 'zoom-reset': resetZoom(); break
  }
})

onUnmounted(() => {
  cleanupTabDrag()
  for (const id of Object.keys(webviews)) delete webviews[id]
})
</script>

<style scoped>
.browser-panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}
.bp-tabbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  height: 100%;
  background: transparent;
  overflow-x: auto;
  flex-shrink: 0;
  -webkit-app-region: drag;
}
/* Same sizing/alignment as project TabBar tabs */
.bp-tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  height: 30px;
  margin: 4px 0;
  min-width: 100px;
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  max-width: 200px;
  white-space: nowrap;
  flex-shrink: 0;
  user-select: none;
  -webkit-app-region: no-drag;
  transition: background var(--transition-fast) ease, color var(--transition-fast) ease, border-color var(--transition-fast) ease, opacity var(--transition-fast) ease, transform var(--transition-fast) ease;
}
.bp-tab:hover { background: var(--bg-hover); color: var(--text-primary); }
.bp-tabbar.is-reordering .bp-tab {
  transition: transform 160ms cubic-bezier(0.2, 0, 0, 1);
}
.bp-tab.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-weight: 500;
  border-color: var(--border-hairline);
  box-shadow: var(--shadow-1);
}
.bp-tab-favicon {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  flex-shrink: 0;
  object-fit: contain;
}
.bp-tab-globe {
  color: var(--text-faint);
  flex-shrink: 0;
}
.bp-tab.active .bp-tab-globe { color: var(--accent-strong); }
.bp-tab-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  animation: bp-spin 0.7s linear infinite;
  flex-shrink: 0;
}
.bp-tab.active .bp-tab-spinner {
  border-color: var(--border-strong);
  border-top-color: var(--accent-strong);
}
@keyframes bp-spin {
  to { transform: rotate(360deg); }
}
.bp-tab-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bp-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-xs);
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  -webkit-app-region: no-drag;
  transition: opacity var(--transition-fast) ease, background var(--transition-fast) ease, color var(--transition-fast) ease;
}
.bp-tab:hover .bp-tab-close,
.bp-tab.active .bp-tab-close { opacity: 1; }
.bp-tab.active .bp-tab-close { color: var(--text-secondary); opacity: 0.8; }
.bp-tab.active .bp-tab-close:hover { background: var(--bg-hover); color: var(--text-danger); opacity: 1; }
.bp-tab-close:hover { background: var(--bg-hover); color: var(--text-danger); }
.bp-new-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
  transition: background var(--transition-fast) ease, color var(--transition-fast) ease;
}
.bp-new-tab:hover { background: var(--bg-hover); color: var(--text-primary); }
.bp-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 40px;
  padding: 0 10px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-hairline);
  flex-shrink: 0;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--transition-fast) ease, color var(--transition-fast) ease;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.icon-btn:disabled { opacity: 0.35; cursor: default; }
.icon-btn:disabled:hover { background: none; }
.bp-url-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  font-size: var(--text-sm);
  padding: 0 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  color: var(--text-primary);
  outline: none;
  transition: border-color var(--transition-fast) ease, background var(--transition-fast) ease, box-shadow var(--transition-fast) ease;
}
.bp-url-input:focus {
  background: var(--bg-secondary);
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.bp-zoom-pill {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-accent);
  background: var(--accent-soft);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  padding: 1px 8px;
  flex-shrink: 0;
}
.bp-zoom-pill:hover { background: var(--bg-hover); color: var(--text-primary); }
.bookmarked { color: var(--text-warning); }
.icon-btn.active { background: var(--accent-soft); color: var(--text-accent); }
.bp-bookmarks-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-hairline);
  overflow-x: auto;
  flex-shrink: 0;
}
.bp-bookmark-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-size: var(--text-xs);
  cursor: pointer;
  border-radius: var(--radius-xs);
  white-space: nowrap;
  color: var(--text-secondary);
  max-width: 160px;
}
.bp-bookmark-item span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.bp-bookmark-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.bp-bookmark-folder {
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  font-weight: 500;
}
.bp-bm-favicon {
  width: 13px;
  height: 13px;
  border-radius: 2px;
  flex-shrink: 0;
  object-fit: contain;
}
.bp-bm-globe { color: var(--text-faint); flex-shrink: 0; }

/* Bookmark Edit Popover */
.bp-bookmark-popover {
  position: absolute;
  top: calc(var(--titlebar-height) + 6px);
  right: 14px;
  z-index: 30;
  width: 290px;
  padding: 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-panel);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bp-pop-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
}
.bp-pop-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bp-pop-field label {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
.bp-pop-field input {
  font-size: var(--text-sm);
  padding: 5px 8px;
}
.bp-pop-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 2px;
}
.bp-pop-btn {
  padding: 5px 12px;
  font-size: var(--text-xs);
}

/* Built-in Start Page (mir://newtab) */
.bp-newtab {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  background: var(--bg-primary);
}
.bp-newtab-inner {
  width: 100%;
  max-width: 680px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
}
.bp-newtab-brand {
  font-size: calc(var(--base-font-size) * 2);
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--text-primary);
  opacity: 0.9;
}
.bp-newtab-search {
  width: 100%;
  max-width: 520px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-1);
}
.bp-newtab-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.bp-newtab-search-icon { color: var(--text-faint); flex-shrink: 0; }
.bp-newtab-input {
  flex: 1;
  border: none;
  background: transparent;
  padding: 8px 4px;
  font-size: var(--text-md);
  box-shadow: none;
}
.bp-newtab-input:focus { border: none; box-shadow: none; background: transparent; }
.bp-newtab-section-head {
  width: 100%;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.bp-speed-dial {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 12px;
}
.bp-dial-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 8px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast) ease, transform var(--transition-fast) ease;
}
.bp-dial-item:hover {
  background: var(--bg-hover);
  transform: translateY(-1px);
}
.bp-dial-icon {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-1);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}
.bp-dial-favicon {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  object-fit: contain;
}
.bp-dial-letter {
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--text-accent);
}
.bp-dial-title {
  width: 100%;
  text-align: center;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bp-dial-add .bp-dial-icon {
  border-style: dashed;
  background: transparent;
  box-shadow: none;
}
.bp-newtab-settings-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: var(--text-xs);
  color: var(--text-faint);
  border-radius: var(--radius-pill);
}
.bp-newtab-settings-link:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* Bookmarks Manager Drawer */
.bp-bookmarks-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 330px;
  max-width: 90%;
  z-index: 25;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  box-shadow: var(--shadow-2);
  display: flex;
  flex-direction: column;
}
.bp-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-hairline);
}
.bp-drawer-title {
  font-size: var(--text-sm);
  font-weight: 600;
}
.bp-drawer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.bp-drawer-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  font-size: var(--text-xs);
}
.bp-drawer-filter {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-bottom: 1px solid var(--border-hairline);
}
.bp-drawer-search {
  width: 100%;
  font-size: var(--text-sm);
  padding: 5px 10px;
}
.bp-drawer-folders {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.bp-folder-pill {
  font-size: var(--text-xs);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.bp-folder-pill.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text-accent);
}
.bp-drawer-form {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-hairline);
}
.bp-drawer-form input {
  font-size: var(--text-sm);
  padding: 5px 8px;
}
.bp-drawer-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 2px;
}
.bp-drawer-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.bp-drawer-empty {
  padding: 24px 12px;
  text-align: center;
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.bp-drawer-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--radius-xs);
  cursor: pointer;
}
.bp-drawer-item:hover { background: var(--bg-hover); }
.bp-drawer-item-info {
  flex: 1;
  min-width: 0;
}
.bp-drawer-item-title {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bp-drawer-item-url {
  font-size: var(--text-2xs);
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bp-drawer-item-folder {
  font-size: var(--text-3xs);
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  flex-shrink: 0;
}
.bp-drawer-item-btns {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
}
.bp-drawer-item:hover .bp-drawer-item-btns { opacity: 1; }
.bp-find-bar {
  position: absolute;
  top: 10px;
  right: 16px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-panel);
}
.bp-find-input {
  width: 200px;
  font-size: var(--text-sm);
  padding: 4px 8px;
}
.bp-find-count {
  font-size: var(--text-xs);
  color: var(--text-faint);
  min-width: 48px;
  text-align: center;
}
.bp-hover-url {
  position: absolute;
  left: 8px;
  bottom: 6px;
  z-index: 15;
  max-width: 60vw;
  padding: 3px 8px;
  border-radius: var(--radius-xs);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.bp-webviews {
  position: relative;
  flex: 1;
  min-height: 0;
}
.bp-webview-slot {
  position: absolute;
  inset: 0;
}
.bp-webview-slot.hidden { visibility: hidden; pointer-events: none; }
.bp-webview { width: 100%; height: 100%; }
.bp-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
}
</style>

<style>
.bp-tab-ghost {
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
.bp-tab-ghost.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-weight: 500;
}
.bp-tab-ghost .bp-tab-favicon {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  flex-shrink: 0;
  object-fit: contain;
}
.bp-tab-ghost .bp-tab-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
