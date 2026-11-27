<template>
  <div class="settings-tab">
    <div class="settings-layout">
      <!-- Left sidebar navigation -->
      <aside class="settings-nav">
        <div class="settings-nav-search">
          <Icon name="search" :size="13" class="nav-search-icon" />
          <input
            v-model="navQuery"
            type="text"
            class="nav-search-input"
            :placeholder="t('settings.searchPlaceholder', 'Search settings…')"
          />
          <button v-if="navQuery" class="nav-search-clear" type="button" @click="navQuery = ''" :aria-label="t('settings.clearSearch')">
            <Icon name="x" :size="11" />
          </button>
        </div>

        <div class="settings-nav-groups">
          <div v-for="group in filteredNavGroups" :key="group.title" class="nav-group">
            <div class="nav-group-title">{{ group.title }}</div>
            <button
              v-for="sec in group.items"
              :key="sec.id"
              type="button"
              class="settings-nav-item"
              :class="{ active: activeSection === sec.id }"
              @click="activeSection = sec.id"
             :aria-label="sec.label">
              <Icon :name="sec.icon" :size="15" class="nav-item-icon" />
              <span class="nav-item-label">{{ sec.label }}</span>
            </button>
          </div>
        </div>

        <div class="settings-nav-footer">
          <span v-if="saved" class="settings-saved">
            <Icon name="check-circle" :size="12" />
            <span>{{ t('common.saved') }}</span>
          </span>
          <button class="st-reset" type="button" @click="resetDefaults" :aria-label="t('common.reset')">
            <Icon name="rotate" :size="12" />
            <span>{{ t('common.reset') }}</span>
          </button>
        </div>
      </aside>

      <!-- Right content area -->
      <main class="settings-content" :class="{ 'settings-content-flush': activeSection === 'plugins' }">
        <div v-if="activeSection !== 'plugins'" class="settings-container">
          <!-- Section header -->
          <header v-if="activeSection !== 'acp' && activeSection !== 'userscripts'" class="section-header">
            <h2 class="section-title">{{ currentSection?.label }}</h2>
          </header>

          <!-- Appearance -->
          <template v-if="activeSection === 'appearance'">
            <div class="settings-card">
              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.language') }}</div>
                </div>
                <select v-model="draft.language" class="settings-select control-w-md">
                  <option value="en">English</option>
                  <option value="zh-CN">中文（简体）</option>
                </select>
              </div>

              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.theme') }}</div>
                </div>
                <div class="segmented">
                  <button
                    type="button"
                    class="seg-btn"
                    :class="{ active: draft.theme === 'dark' }"
                    @click="draft.theme = 'dark'"
                  >{{ $t('settings.dark') }}</button>
                  <button
                    type="button"
                    class="seg-btn"
                    :class="{ active: draft.theme === 'light' }"
                    @click="draft.theme = 'light'"
                  >{{ $t('settings.light') }}</button>
                </div>
              </div>

              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.accentColor', 'Accent Color') }}</div>
                </div>
                <div class="accent-swatches">
                  <button
                    v-for="sw in ACCENT_SWATCHES"
                    :key="sw.id"
                    type="button"
                    class="accent-swatch"
                    :class="{ active: (draft.accentColor || 'default') === sw.id }"
                    :style="{ '--swatch-color': sw.color }"
                    :title="sw.label"
                    :aria-label="sw.label"
                    @click="draft.accentColor = sw.id"
                  />
                </div>
              </div>

              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.uiFontSize') }}</div>
                </div>
                <input
                  type="number"
                  v-model.number="draft.fontSize"
                  min="10"
                  max="24"
                  class="settings-input control-w-sm"
                />
              </div>
            </div>

            <div class="settings-card">
              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.autoUpdate') }}</div>
                </div>
                <label class="toggle">
            <input role="switch" type="checkbox" v-model="draft.autoUpdate" />
                  <span class="toggle-track" />
                </label>
              </div>
              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.showPanelIcons') }}</div>
                </div>
                <label class="toggle">
            <input role="switch" type="checkbox" v-model="draft.showPanelIcons" />
                  <span class="toggle-track" />
                </label>
              </div>
              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.markdownPreview') }}</div>
                </div>
                <label class="toggle">
            <input role="switch" type="checkbox" v-model="draft.markdownPreview" />
                  <span class="toggle-track" />
                </label>
              </div>
            </div>
          </template>

          <!-- Terminal -->
          <template v-if="activeSection === 'terminal'">
            <div class="settings-card">
              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.shellPath') }}</div>
                </div>
                <input
                  v-model="draft.terminalShell"
                  placeholder="/bin/zsh"
                  class="settings-input control-w-lg"
                />
              </div>
              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.terminalFontSize') }}</div>
                </div>
                <input
                  type="number"
                  v-model.number="draft.terminalFontSize"
                  min="8"
                  max="24"
                  class="settings-input control-w-sm"
                />
              </div>
            </div>
          </template>

          <!-- Editor -->
          <template v-if="activeSection === 'editor'">
            <div class="settings-card">
              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.autoSave') }}</div>
                </div>
                <input
                  type="number"
                  v-model.number="draft.autoSaveInterval"
                  min="0"
                  max="60"
                  class="settings-input control-w-sm"
                />
              </div>
              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.wordWrap') }}</div>
                </div>
                <select v-model="draft.editorWordWrap" class="settings-select control-w-md">
                  <option value="off">{{ $t('settings.wordWrapOff') }}</option>
                  <option value="on">{{ $t('settings.wordWrapOn') }}</option>
                  <option value="wordWrapColumn">{{ $t('settings.wordWrapColumn') }}</option>
                  <option value="bounded">{{ $t('settings.wordWrapBounded') }}</option>
                </select>
              </div>
              <div
                v-if="draft.editorWordWrap === 'wordWrapColumn' || draft.editorWordWrap === 'bounded'"
                class="settings-row"
              >
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.wordWrapColumn') }}</div>
                </div>
                <input
                  type="number"
                  v-model.number="draft.editorWordWrapColumn"
                  min="20"
                  max="500"
                  class="settings-input control-w-sm"
                />
              </div>
            </div>
          </template>

          <!-- Git -->
          <template v-if="activeSection === 'git'">
            <div class="settings-card">
              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.gitExecutablePath') }}</div>
                </div>
                <input
                  v-model="draft.gitExecutable"
                  placeholder="git"
                  class="settings-input control-w-lg"
                />
              </div>
            </div>
          </template>

          <!-- Browser -->
          <template v-if="activeSection === 'browser'">
            <div class="settings-card">
              <div class="settings-row settings-row-col">
                <div class="row-label">{{ $t('settings.browserHomeUrl') }}</div>
                <input
                  v-model="draft.browserHomeUrl"
                  :placeholder="$t('settings.browserHomeUrlPlaceholder')"
                  class="settings-input"
                />
                <div class="settings-presets">
                  <button
                    type="button"
                    class="settings-preset-btn"
                    :class="{ active: !draft.browserHomeUrl }"
                    @click="draft.browserHomeUrl = ''"
                  >{{ $t('settings.builtinStartPage') }}</button>
                  <button
                    type="button"
                    class="settings-preset-btn"
                    :class="{ active: draft.browserHomeUrl === 'https://www.google.com' }"
                    @click="draft.browserHomeUrl = 'https://www.google.com'"
                  >Google</button>
                  <button
                    type="button"
                    class="settings-preset-btn"
                    :class="{ active: draft.browserHomeUrl === 'https://www.baidu.com' }"
                    @click="draft.browserHomeUrl = 'https://www.baidu.com'"
                  >Baidu</button>
                  <button
                    type="button"
                    class="settings-preset-btn"
                    :class="{ active: draft.browserHomeUrl === 'https://www.bing.com' }"
                    @click="draft.browserHomeUrl = 'https://www.bing.com'"
                  >Bing</button>
                  <button
                    type="button"
                    class="settings-preset-btn"
                    :class="{ active: draft.browserHomeUrl === 'https://github.com' }"
                    @click="draft.browserHomeUrl = 'https://github.com'"
                  >GitHub</button>
                </div>
              </div>

              <div class="settings-row settings-row-col">
                <div class="row-label">{{ $t('settings.searchEngine') }}</div>
                <input v-model="draft.defaultSearchEngine" class="settings-input" />
                <div class="settings-presets">
                  <button
                    type="button"
                    class="settings-preset-btn"
                    :class="{ active: draft.defaultSearchEngine === 'https://www.google.com/search?q=' }"
                    @click="draft.defaultSearchEngine = 'https://www.google.com/search?q='"
                  >Google</button>
                  <button
                    type="button"
                    class="settings-preset-btn"
                    :class="{ active: draft.defaultSearchEngine === 'https://www.baidu.com/s?wd=' }"
                    @click="draft.defaultSearchEngine = 'https://www.baidu.com/s?wd='"
                  >Baidu</button>
                  <button
                    type="button"
                    class="settings-preset-btn"
                    :class="{ active: draft.defaultSearchEngine === 'https://www.bing.com/search?q=' }"
                    @click="draft.defaultSearchEngine = 'https://www.bing.com/search?q='"
                  >Bing</button>
                  <button
                    type="button"
                    class="settings-preset-btn"
                    :class="{ active: draft.defaultSearchEngine === 'https://duckduckgo.com/?q=' }"
                    @click="draft.defaultSearchEngine = 'https://duckduckgo.com/?q='"
                  >DuckDuckGo</button>
                </div>
              </div>

              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.showBookmarksBar') }}</div>
                </div>
                <label class="toggle">
            <input role="switch" type="checkbox" v-model="draft.showBookmarksBar" />
                  <span class="toggle-track" />
                </label>
              </div>
              <div class="settings-row">
                <div class="row-info">
                  <div class="row-label">{{ $t('settings.openBookmarksInNewTab') }}</div>
                </div>
                <label class="toggle">
            <input role="switch" type="checkbox" v-model="draft.openBookmarksInNewTab" />
                  <span class="toggle-track" />
                </label>
              </div>
            </div>
          </template>

          <!-- Userscripts -->
          <template v-if="activeSection === 'userscripts'">
            <UserscriptsSettingsSection />
          </template>

          <!-- Shortcuts -->
          <template v-if="activeSection === 'shortcuts'">
            <div class="settings-card">
              <div
                v-for="(_value, key) in draft.shortcuts"
                :key="key"
                class="settings-row"
              >
                <div class="row-info">
                  <div class="row-label">{{ shortcutLabel(key) }}</div>
                </div>
                <input
                  v-model="draft.shortcuts[key]"
                  class="settings-input shortcut-input control-w-md"
                />
              </div>
            </div>
          </template>

          <!-- ACP agents -->
          <template v-if="activeSection === 'acp'">
            <AcpSettingsSection />
          </template>
        </div>

        <!-- Plugins (full-bleed) -->
        <template v-if="activeSection === 'plugins'">
          <PluginManager class="settings-plugin-manager" />
        </template>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore, type Settings } from '../stores/settings'
import AcpSettingsSection from './AcpSettingsSection.vue'
import PluginManager from './PluginManager.vue'
import UserscriptsSettingsSection from './UserscriptsSettingsSection.vue'
import Icon from './ui/Icon.vue'

const { t } = useI18n()
const settingsStore = useSettingsStore()

const draft = reactive<Settings>(JSON.parse(JSON.stringify(settingsStore.settings)))
const saved = ref(false)
const navQuery = ref('')
let saveTimer: ReturnType<typeof setTimeout> | null = null

const ACCENT_SWATCHES: Array<{ id: NonNullable<Settings['accentColor']>; label: string; color: string }> = [
  { id: 'default', label: 'Default', color: '#0b6da9' },
  { id: 'indigo', label: 'Indigo', color: '#4f46e5' },
  { id: 'emerald', label: 'Emerald', color: '#047857' },
  { id: 'rose', label: 'Rose', color: '#be123c' },
  { id: 'amber', label: 'Amber', color: '#b45309' }
]

interface NavItem {
  id: string
  label: string
  icon: string
}

const navGroups = computed<Array<{ title: string; items: NavItem[] }>>(() => [
  {
    title: t('settings.groupGeneral', 'General'),
    items: [
      { id: 'appearance', label: t('settings.appearance'), icon: 'sun' },
      { id: 'shortcuts', label: t('settings.shortcuts'), icon: 'command' }
    ]
  },
  {
    title: t('settings.groupWorkspace', 'Workspace'),
    items: [
      { id: 'editor', label: t('settings.editor'), icon: 'file-text' },
      { id: 'terminal', label: t('settings.terminal'), icon: 'terminal' },
      { id: 'git', label: t('settings.git'), icon: 'git-branch' },
      { id: 'browser', label: t('settings.browser'), icon: 'globe' }
    ]
  },
  {
    title: t('settings.groupExtensions', 'AI & Extensions'),
    items: [
      { id: 'acp', label: t('settings.acp'), icon: 'robot' },
      { id: 'userscripts', label: t('userscripts.title'), icon: 'code' },
      { id: 'plugins', label: t('plugins.title'), icon: 'plugin' }
    ]
  }
])

const filteredNavGroups = computed(() => {
  const q = navQuery.value.trim().toLowerCase()
  if (!q) return navGroups.value
  return navGroups.value
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => i.label.toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
    }))
    .filter((g) => g.items.length > 0)
})

const activeSection = ref('appearance')

const currentSection = computed(() => {
  for (const g of navGroups.value) {
    const found = g.items.find((i) => i.id === activeSection.value)
    if (found) return found
  }
  return null
})

let suppressWatch = false

watch(draft, () => {
  if (suppressWatch) return
  scheduleSave()
}, { deep: true })

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(doSave, 300)
}

onBeforeUnmount(() => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
})

async function doSave() {
  const prevAutoUpdate = settingsStore.settings.autoUpdate
  await settingsStore.update({ ...JSON.parse(JSON.stringify(draft)) })
  if (draft.autoUpdate !== prevAutoUpdate) {
    window.electronAPI.setAutoUpdate(draft.autoUpdate).catch(() => {})
  }
  saved.value = true
  setTimeout(() => { saved.value = false }, 2000)
}

function resetDefaults() {
  suppressWatch = true
  Object.assign(draft, JSON.parse(JSON.stringify(settingsStore.defaults)))
  setTimeout(() => { suppressWatch = false }, 50)
  scheduleSave()
}

function shortcutLabel(key: string): string {
  const labels: Record<string, string> = {
    newTab: t('settings.newTab'),
    closeTab: t('settings.closeTab'),
    nextTab: t('settings.nextTab'),
    prevTab: t('settings.prevTab'),
    commandPalette: t('settings.commandPalette'),
    settings: t('settings.title'),
    find: t('settings.find'),
    save: t('settings.save_')
  }
  return labels[key] || key
}
</script>

<style scoped>
.settings-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
}
.settings-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* Sidebar */
.settings-nav {
  width: 220px;
  background: var(--bg-secondary);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-subtle);
}
.settings-nav-search {
  position: relative;
  display: flex;
  align-items: center;
  margin: 12px 10px 6px;
}
.nav-search-icon {
  position: absolute;
  left: 9px;
  color: var(--text-faint);
  pointer-events: none;
}
.nav-search-input {
  width: 100%;
  padding: 6px 26px 6px 28px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: var(--text-xs);
}
.nav-search-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.nav-search-clear {
  position: absolute;
  right: 6px;
  color: var(--text-faint);
  padding: 2px;
  display: inline-flex;
}
.nav-search-clear:hover { color: var(--text-primary); }

.settings-nav-groups {
  flex: 1;
  overflow-y: auto;
  padding: 6px 10px;
}
.nav-group { margin-bottom: 14px; }
.nav-group-title {
  padding: 4px 10px 6px;
  font-size: var(--text-2xs);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  margin-bottom: 2px;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  text-align: left;
  transition: background var(--transition-fast) ease, color var(--transition-fast) ease;
}
.settings-nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.settings-nav-item.active {
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}
.nav-item-icon { flex-shrink: 0; opacity: 0.85; }
.nav-item-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.settings-nav-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-top: 1px solid var(--border-hairline);
  min-height: 40px;
}
.settings-saved {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--text-success);
}
.st-reset {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  border-radius: var(--radius-sm);
  cursor: pointer;
  padding: 4px 8px;
  color: var(--text-secondary);
}
.st-reset:hover { background: var(--bg-hover); color: var(--text-primary); }

/* Content area */
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}
.settings-content-flush {
  padding: 0;
  overflow: hidden;
}
.settings-container {
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.section-header {
  padding-bottom: 4px;
}
.section-title {
  margin: 0;
  font-size: calc(var(--base-font-size) * 1.2);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

/* Card & Rows */
.settings-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
}
.settings-row + .settings-row {
  border-top: 1px solid var(--border-hairline);
}
.settings-row-col {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}
.row-info {
  flex: 1;
  min-width: 0;
}
.row-label {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-primary);
}

/* Controls */
.settings-input,
.settings-select {
  font-size: var(--text-sm);
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
}
.settings-input:focus,
.settings-select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.control-w-sm { width: 88px; text-align: right; }
.control-w-md { width: 170px; }
.control-w-lg { width: 240px; }
.shortcut-input {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-align: center;
}

/* Segmented theme toggle */
.segmented {
  display: inline-flex;
  padding: 2px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}
.seg-btn {
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--text-secondary);
  transition: all var(--transition-fast) ease;
}
.seg-btn:hover { color: var(--text-primary); }
.seg-btn.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-1);
}

/* Accent swatches */
.accent-swatches {
  display: flex;
  align-items: center;
  gap: 8px;
}
.accent-swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--swatch-color);
  border: 2px solid transparent;
  transition: transform var(--transition-fast) ease, box-shadow var(--transition-fast) ease;
}
.accent-swatch:hover { transform: scale(1.1); }
.accent-swatch.active {
  box-shadow: 0 0 0 2px var(--bg-secondary), 0 0 0 4px var(--swatch-color);
}

/* Modern Toggle Switch */
.toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  flex-shrink: 0;
}
.toggle input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.toggle-track {
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  position: relative;
  transition: background var(--transition-fast) ease, border-color var(--transition-fast) ease;
}
.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-secondary);
  transition: transform var(--transition-fast) ease, background var(--transition-fast) ease;
}
.toggle input:checked + .toggle-track {
  background: var(--accent);
  border-color: var(--accent);
}
.toggle input:checked + .toggle-track::after {
  transform: translateX(16px);
  background: var(--text-on-accent);
}
.toggle input:focus-visible + .toggle-track {
  box-shadow: var(--focus-ring);
}

.settings-plugin-manager { height: 100%; }
.settings-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.settings-preset-btn {
  font-size: var(--text-xs);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.settings-preset-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.settings-preset-btn.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-strong);
  font-weight: 500;
}
</style>
