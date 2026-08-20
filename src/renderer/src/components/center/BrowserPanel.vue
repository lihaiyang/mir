<template>
  <div class="browser-panel">
    <!-- Tab bar (teleported into the title bar) -->
    <Teleport :to="`#mir-browser-tabs-${projectId}`">
      <div class="bp-tabbar">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="bp-tab"
          :class="{ active: tab.id === activeTabId }"
          @click="browserStore.setActiveTab(tab.id, projectId)"
          @mousedown.middle="browserStore.closeTab(tab.id, projectId)"
        >
          <span class="bp-tab-title">{{ tab.title || tab.url || $t('browser.newTab') }}</span>
          <button class="bp-tab-close" @click.stop="browserStore.closeTab(tab.id, projectId)"><Icon name="x" :size="10" /></button>
        </div>
        <button class="bp-new-tab" :title="$t('browser.newTab')" @click="browserStore.openTab(undefined, projectId)"><Icon name="plus" :size="13" /></button>
      </div>
    </Teleport>

    <!-- Toolbar: nav + address bar -->
    <div class="bp-toolbar">
      <button class="icon-btn" :disabled="!activeState.canGoBack" @click="goBack" :title="$t('browser.back')"><Icon name="chevron-left" :size="13" /></button>
      <button class="icon-btn" :disabled="!activeState.canGoForward" @click="goForward" :title="$t('browser.forward')"><Icon name="chevron-right" :size="13" /></button>
      <button class="icon-btn" @click="reload" :title="$t('browser.reload')"><Icon :name="activeState.isLoading ? 'x' : 'refresh'" :size="13" /></button>
      <input
        v-model="addrBar"
        class="bp-url-input"
        :placeholder="$t('browser.placeholder')"
        @keydown.enter="navigateTo"
        @focus="($event.target as HTMLInputElement).select()"
      />
      <button class="icon-btn" @click="openDevTools" :title="$t('browser.devTools')"><Icon name="wrench" :size="13" /></button>
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
          :ref="(el) => setWebview(tab.id, el)"
          class="bp-webview"
          :src="getInitialSrc(tab.id)"
          allowpopups
          webpreferences="contextIsolation=yes"
          partition="persist:browser"
          @will-navigate="(e) => onWillNavigate(tab.id, e)"
          @did-redirect-navigation="(e) => onRedirectNavigation(tab.id, e)"
          @did-navigate="(e) => onNavigated(tab.id, e)"
          @did-navigate-in-page="(e) => onNavigatedInPage(tab.id, e)"
          @did-start-loading="() => onStartLoading(tab.id)"
          @did-stop-loading="() => onStopLoading(tab.id)"
          @page-title-updated="(e) => onTitleUpdated(tab.id, e)"
        />
      </div>

      <div v-if="tabs.length === 0" class="bp-empty">
        <div class="empty-icon"><Icon name="globe" :size="28" /></div>
        <p>{{ $t('browser.noTabs') }}</p>
        <button class="btn-primary" @click="browserStore.openTab(undefined, projectId)"><Icon name="plus" :size="13" /> {{ $t('browser.newTab') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, reactive, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBrowserStore, browserReloadBus, PINNED_BROWSER_PROJECT_ID } from '../../stores/browser'
import { useSettingsStore } from '../../stores/settings'
import Icon from '../ui/Icon.vue'

const props = withDefaults(defineProps<{ projectId?: string }>(), {
  projectId: PINNED_BROWSER_PROJECT_ID
})

const { t } = useI18n()
const browserStore = useBrowserStore()
const settingsStore = useSettingsStore()

const tabs = computed(() => browserStore.getTabs(props.projectId))
const activeTabId = computed(() => browserStore.getActiveTabId(props.projectId))
const activeTab = computed(() => tabs.value.find(t => t.id === activeTabId.value) ?? null)

// Webview registry: tabId → webview element
const webviews = reactive<Record<string, Electron.WebviewTag | null>>({})
function setWebview(id: string, el: unknown) {
  if (el) webviews[id] = el as Electron.WebviewTag
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
const tabState = reactive<Record<string, { canGoBack: boolean; canGoForward: boolean; isLoading: boolean }>>({})
function state(id: string) {
  if (!tabState[id]) tabState[id] = { canGoBack: false, canGoForward: false, isLoading: false }
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
const activeState = computed(() => activeTab.value ? state(activeTab.value.id) : { canGoBack: false, canGoForward: false, isLoading: false })

const addrBar = ref('')
watch(() => activeTab.value?.url, (u) => { addrBar.value = u ?? '' })

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
  const u = normalizeUrl(url)
  // Record the URL the user asked for as the display/persisted URL before loading;
  // redirects will not overwrite it.
  browserStore.updateTab(tabId, { url: u }, props.projectId)
  webviews[tabId]?.loadURL(u)
}

function navigateTo() {
  if (!activeTab.value) return
  navigate(activeTab.value.id, addrBar.value)
}

function goBack() { webviews[activeTabId.value ?? '']?.goBack() }
function goForward() { webviews[activeTabId.value ?? '']?.goForward() }
function reload() {
  const id = activeTabId.value
  if (!id) return
  const t = tabs.value.find(t => t.id === id)
  // Reload the intended URL (not the current redirect target) so SSO wrappers
  // re-run their redirect chain instead of breaking.
  if (t?.url) webviews[id]?.loadURL(t.url)
  else webviews[id]?.reload()
}
function openDevTools() { webviews[activeTabId.value ?? '']?.openDevTools() }

function onStartLoading(id: string) { state(id).isLoading = true }
function onStopLoading(id: string) { state(id).isLoading = false }

// Link click / location.href change — this is the user-visible intended URL.
function onWillNavigate(id: string, e: any) {
  const url = e?.url
  if (url) browserStore.updateTab(id, { url }, props.projectId)
}

// A server-side redirect happened; mark the tab so did-navigate keeps the URL.
function onRedirectNavigation(id: string, e: any) {
  if (e?.isMainFrame) redirecting.add(id)
}

function onNavigated(id: string, e: any) {
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
function onNavigatedInPage(id: string, e: any) {
  const url = e?.url
  if (url && e?.isMainFrame) browserStore.updateTab(id, { url }, props.projectId)
}

function onTitleUpdated(id: string, e: any) {
  const title = e?.title
  if (title) browserStore.updateTab(id, { title }, props.projectId)
}

// Ctrl/Cmd+R / F5 → reload the active tab only (signal from main process).
watch(() => browserReloadBus.nonce, () => {
  if (browserStore.activeProjectId === props.projectId) reload()
})

onUnmounted(() => {
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
  align-items: flex-end;
  gap: 2px;
  padding: 0 6px;
  height: 100%;
  background: transparent;
  overflow-x: auto;
  flex-shrink: 0;
  -webkit-app-region: drag;
}
/* Same sizing/alignment as project TabBar tabs */
.bp-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  height: 26px;
  min-width: 90px;
  font-size: 11px;
  border-radius: 6px 6px 0 0;
  border-top: 2px solid transparent;
  color: var(--text-secondary);
  cursor: pointer;
  max-width: 200px;
  white-space: nowrap;
  flex-shrink: 0;
  user-select: none;
  -webkit-app-region: no-drag;
  transition: background var(--transition-fast) ease, color var(--transition-fast) ease;
}
.bp-tab:hover { background: var(--bg-hover); color: var(--text-primary); }
/* Same active highlight as project TabBar tabs: taller + top accent line */
.bp-tab.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  border-top: 2px solid var(--text-accent);
  height: calc(var(--tab-height, 30px) - 1px);
}
.bp-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}
.bp-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  color: var(--text-faint);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.bp-tab-close:hover { background: var(--bg-hover); color: var(--text-danger); }
.bp-new-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}
.bp-new-tab:hover { background: var(--bg-hover); color: var(--text-primary); }
.bp-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: var(--titlebar-height);
  padding: 0 6px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 4px; color: var(--text-secondary); cursor: pointer; flex-shrink: 0; }
.icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.icon-btn:disabled { opacity: 0.35; cursor: default; }
.icon-btn:disabled:hover { background: none; }
.bp-url-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  color: var(--text-primary);
  outline: none;
}
.bp-url-input:focus { border-color: var(--text-accent); }
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
