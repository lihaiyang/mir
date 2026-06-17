<template>
  <div class="app" :data-theme="settingsStore.settings.theme">
    <TitleBar />

    <div class="main-layout">
      <!-- Left pane -->
      <div class="left-pane" :style="layout.leftCollapsed ? { width: '40px' } : { width: layout.leftWidth + 'px' }">
        <LeftPane />
      </div>

      <!-- Splitter L -->
      <div class="splitter" @mousedown="startResize('left', $event)" />

      <!-- Center pane -->
      <div class="center-pane" style="flex:1;min-width:0">
        <CenterPane />
      </div>

      <!-- Splitter R -->
      <div class="splitter" @mousedown="startResize('right', $event)" />

      <!-- Right pane -->
      <div
        class="right-pane"
        :style="layout.rightCollapsed ? { width: '40px' } : { width: layout.rightWidth + 'px' }"
      >
        <RightPane />
      </div>
    </div>

    <!-- Global modals -->
    <SettingsModal v-if="showSettings" @close="showSettings = false" />
    <CommandPalette v-if="showPalette" @close="showPalette = false" />
    <ContextMenuHost />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLayoutStore } from './stores/layout'
import { useProjectStore } from './stores/projects'
import { useSettingsStore } from './stores/settings'
import { useTabStore } from './stores/tabs'
import { useWebPageStore } from './stores/webPages'
import TitleBar from './components/TitleBar.vue'
import LeftPane from './components/left/LeftPane.vue'
import CenterPane from './components/center/CenterPane.vue'
import RightPane from './components/right/RightPane.vue'
import SettingsModal from './components/SettingsModal.vue'
import ContextMenuHost from './components/ContextMenuHost.vue'
import CommandPalette from './components/CommandPalette.vue'
import { registerCommand } from './composables/useCommandPalette'

const { locale, t } = useI18n()
const layout = useLayoutStore()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()
const tabStore = useTabStore()
const webPageStore = useWebPageStore()
const showSettings = ref(false)
const showPalette = ref(false)

provide('showSettings', showSettings)
provide('showPalette', showPalette)

onMounted(async () => {
  await settingsStore.load()
  locale.value = settingsStore.settings.language
  await layout.load()
  await projectStore.load()
  await tabStore.load()
  await webPageStore.load()
  settingsStore.applyTheme()
  setupShortcuts()
  registerBuiltinCommands()

  watch(() => settingsStore.settings.language, (lang) => {
    locale.value = lang
  })

  // Flush any pending debounced persists when window is closing
  window.addEventListener('beforeunload', () => {
    layout.doPersist()
    tabStore.doPersist()
  })

  // Listen for editor asking to open the global command palette
  window.addEventListener('open-command-palette', onOpenCommandPalette)
})

// Splitter drag
let resizing: 'left' | 'right' | null = null
let startX = 0
let startVal = 0

function startResize(side: 'left' | 'right', e: MouseEvent) {
  resizing = side
  startX = e.clientX
  startVal = side === 'left' ? layout.leftWidth : layout.rightWidth
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function onMouseMove(e: MouseEvent) {
  if (!resizing) return
  const delta = e.clientX - startX
  if (resizing === 'left') {
    layout.leftWidth = Math.max(150, Math.min(400, startVal + delta))
  } else {
    layout.rightWidth = Math.max(240, Math.min(600, startVal - delta))
  }
}

function onMouseUp() {
  resizing = null
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  layout.persist()
}

function registerBuiltinCommands() {
  registerCommand({
    id: 'mir.settings',
    label: t('commandPalette.openSettings'),
    keybinding: 'Ctrl+,',
    run: () => { showSettings.value = true }
  })
  registerCommand({
    id: 'editor.toggleWordWrap',
    label: t('commandPalette.toggleWordWrap'),
    run: () => {
      // Toggle the global setting so every open editor updates via its watcher.
      const cur = settingsStore.settings.editorWordWrap
      settingsStore.update({ editorWordWrap: cur === 'off' ? 'on' : 'off' })
    }
  })
}

function onOpenCommandPalette() {
  showPalette.value = true
}

function setupShortcuts() {
  window.addEventListener('keydown', handleGlobalKey)
}

function handleGlobalKey(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key === ',') { e.preventDefault(); showSettings.value = true }
  if (mod && e.shiftKey && e.key === 'P') { e.preventDefault(); showPalette.value = true }
}

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKey)
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('open-command-palette', onOpenCommandPalette)
})
</script>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-primary);
  color: var(--text-primary);
}
.main-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.left-pane {
  flex-shrink: 0;
  overflow: hidden;
  border-right: 1px solid var(--border-color);
}
.right-pane {
  flex-shrink: 0;
  overflow: hidden;
  border-left: 1px solid var(--border-color);
  transition: width 0.15s ease;
}
.splitter {
  width: 1px;
  cursor: col-resize;
  background: var(--border-color);
  flex-shrink: 0;
}
.splitter:hover { background: var(--text-accent); width: 3px; }
</style>
