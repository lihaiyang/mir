<template>
  <div class="browser-tab">
    <!-- Toolbar: hidden in standalone mode (toolbar lives in TitleBar instead) -->
    <div v-if="!isStandalone" class="browser-toolbar">
      <button class="icon-btn" :disabled="!canGoBack" @click="goBack">◀</button>
      <button class="icon-btn" :disabled="!canGoForward" @click="goForward">▶</button>
      <button class="icon-btn" @click="reload">↺</button>
      <input
        ref="urlInput"
        v-model="urlBar"
        class="url-input"
        :placeholder="$t('browser.placeholder')"
        @keydown.enter="navigateTo"
        @focus="$event.target.select()"
      />
      <button class="icon-btn" :class="{ bookmarked: isBookmarked }" @click="toggleBookmark" :title="$t('browser.bookmark')">
        {{ isBookmarked ? '★' : '☆' }}
      </button>
      <button class="icon-btn" @click="openDevTools" :title="$t('browser.devTools')">⚙</button>
    </div>

    <!-- Bookmarks bar -->
    <div v-if="bookmarks.length > 0" class="bookmarks-bar">
      <span
        v-for="bm in bookmarks"
        :key="bm.url"
        class="bookmark-item"
        @click="navigate(bm.url)"
        @contextmenu.prevent="showBmMenu($event, bm)"
      >{{ bm.title }}</span>
    </div>

    <webview
      ref="wv"
      class="browser-webview"
      :src="initialUrl"
      allowpopups
      webpreferences="contextIsolation=yes"
      partition="persist:browser"
      @did-navigate="onNavigated"
      @did-navigate-in-page="onNavigated"
      @did-start-loading="onStartLoading"
      @did-stop-loading="onStopLoading"
      @dom-ready="onDomReady"
      @console-message="onConsole"
      @did-fail-load="onFailLoad"
      @page-title-updated="onTitleUpdate"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTabStore } from '../../stores/tabs'
import { useProjectStore } from '../../stores/projects'
import { useWebPageStore, standaloneNavBus } from '../../stores/webPages'
import { useSettingsStore } from '../../stores/settings'
import { useContextMenu } from '../../composables/useContextMenu'
import type { Tab } from '../../stores/tabs'

const { t } = useI18n()

const props = defineProps<{ tab: Tab }>()

const tabStore = useTabStore()
const projectStore = useProjectStore()
const webPageStore = useWebPageStore()
const settingsStore = useSettingsStore()
const { show: showMenu } = useContextMenu()

// Standalone = this tab is a left-panel webpage browser (tab IDs start with "standalone-browser-")
const isStandalone = computed(() => props.tab.id.startsWith('standalone-browser-'))

const wv = ref<Electron.WebviewTag | null>(null)
const urlBar = ref(props.tab.browserUrl || 'https://www.google.com')
const initialUrl = ref(props.tab.browserUrl || 'https://www.google.com')
const canGoBack = ref(false)
const canGoForward = ref(false)

interface Bookmark { title: string; url: string }
const bookmarks = ref<Bookmark[]>([])

const isBookmarked = computed(() => bookmarks.value.some(b => b.url === urlBar.value))

onMounted(async () => {
  const bms = await window.electronAPI.storeGet('bookmarks') as Bookmark[] | null
  if (Array.isArray(bms)) bookmarks.value = bms

  // Sync initial state to navBus for standalone mode
  if (isStandalone.value) {
    standaloneNavBus.url = urlBar.value
    standaloneNavBus.canGoBack = false
    standaloneNavBus.canGoForward = false
  }
})

onUnmounted(() => {
  if (isStandalone.value) {
    standaloneNavBus.url = ''
    standaloneNavBus.canGoBack = false
    standaloneNavBus.canGoForward = false
  }
})

// When switching between web pages in sidebar, sync URL and navigate
watch(() => props.tab.browserUrl, (newUrl) => {
  if (newUrl && newUrl !== urlBar.value) {
    urlBar.value = newUrl
    navigate(newUrl)
  }
})

// Watch navBus commands (TitleBar → BrowserTab)
watch(() => standaloneNavBus.cmd, (cmd) => {
  if (!isStandalone.value || !cmd) return
  if (cmd === 'back') { wv.value?.goBack() }
  else if (cmd === 'forward') { wv.value?.goForward() }
  else if (cmd === 'reload') { wv.value?.reload() }
  else if (cmd === 'navigate') { navigate(standaloneNavBus.cmdUrl) }
  else if (cmd === 'devtools') { wv.value?.openDevTools() }
  // Clear command after handling
  standaloneNavBus.cmd = null
})

function navigate(url: string) {
  let u = url.trim()
  if (!u.startsWith('http://') && !u.startsWith('https://') && !u.startsWith('file://')) {
    if (u.includes('.') && !u.includes(' ')) u = 'https://' + u
    else u = settingsStore.settings.defaultSearchEngine + encodeURIComponent(u)
  }
  wv.value?.loadURL(u)
}

function navigateTo() { navigate(urlBar.value) }
function goBack() { wv.value?.goBack() }
function goForward() { wv.value?.goForward() }
function reload() { wv.value?.reload() }
function openDevTools() { wv.value?.openDevTools() }

const LOG_PREFIX = '[BrowserTab]'

function log(msg: string, ...args: any[]) {
  console.log(`${LOG_PREFIX} ${msg}`, ...args)
}

function onStartLoading() {
  log('start-loading')
  if (isStandalone.value) standaloneNavBus.isLoading = true
}

function onStopLoading() {
  log('stop-loading', wv.value?.getURL())
  if (isStandalone.value) standaloneNavBus.isLoading = false
}

function onDomReady() {
  // Service worker registration is patched via the webview preload
  // (src/preload/webview.ts) which runs before any page script.
}

function onConsole(e: any) {
  const msg = e.message || ''
  // Suppress known-harmless ServiceWorker registration errors from
  // pages inside the webview (Electron/Chromium document state races).
  if (msg.includes('ServiceWorker') && msg.includes('invalid state')) return
  log('console [' + e.level + ']', msg)
}

function onFailLoad(e: any) {
  log('fail-load', {
    url: wv.value?.getURL(),
    errorCode: e.errorCode,
    errorDescription: e.errorDescription,
    validatedURL: e.validatedURL,
    isMainFrame: e.isMainFrame
  })
}

function onNavigated(e: any) {
  const url = e.url || e.detail?.url
  if (url) {
    urlBar.value = url
    updateTabState(url)
    // Push to navBus so TitleBar address bar stays in sync
    if (isStandalone.value) {
      standaloneNavBus.url = url
    }
  }
  canGoBack.value = wv.value?.canGoBack() ?? false
  canGoForward.value = wv.value?.canGoForward() ?? false
  if (isStandalone.value) {
    standaloneNavBus.canGoBack = canGoBack.value
    standaloneNavBus.canGoForward = canGoForward.value
  }
}

function onTitleUpdate(e: any) {
  const title = e.title || e.detail?.title
  if (!title) return

  if (projectStore.activeProject) {
    tabStore.renameTab(projectStore.activeProject.id, props.tab.id, title)
  }

  const currentUrl = wv.value?.getURL()
  if (currentUrl) {
    for (const wp of webPageStore.webPages) {
      if (wp.url === currentUrl && title !== wp.baselineTitle) {
        webPageStore.setNotification(wp.id, true)
      }
    }
  }
}

function updateTabState(url: string) {
  if (!projectStore.activeProject) return
  tabStore.updateTab(projectStore.activeProject.id, props.tab.id, { browserUrl: url })
}

async function toggleBookmark() {
  const url = urlBar.value
  const idx = bookmarks.value.findIndex(b => b.url === url)
  if (idx !== -1) {
    bookmarks.value.splice(idx, 1)
  } else {
    bookmarks.value.push({ title: new URL(url).hostname, url })
  }
  await window.electronAPI.storeSet('bookmarks', bookmarks.value)
}

function showBmMenu(e: MouseEvent, bm: Bookmark) {
  showMenu(e, [
    { label: t('common.open'), action: () => navigate(bm.url) },
    { label: t('contextMenu.copyUrl'), action: () => navigator.clipboard.writeText(bm.url) },
    { separator: true },
    { label: t('browser.removeBookmark'), danger: true, action: async () => {
      bookmarks.value = bookmarks.value.filter(b => b.url !== bm.url)
      await window.electronAPI.storeSet('bookmarks', bookmarks.value)
    }}
  ])
}
</script>

<style scoped>
.browser-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  z-index: 1;
}
.browser-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.url-input {
  flex: 1;
  font-size: 12px;
  padding: 4px 8px;
}
.icon-btn:disabled { opacity: 0.4; cursor: default; }
.bookmarked { color: #f59e0b; }
.bookmarks-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
  flex-shrink: 0;
}
.bookmark-item {
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
  white-space: nowrap;
  color: var(--text-secondary);
}
.bookmark-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.browser-webview {
  flex: 1;
  min-height: 0;
}
</style>
