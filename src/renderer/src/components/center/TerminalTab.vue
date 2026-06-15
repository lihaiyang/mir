<template>
  <div class="terminal-wrap" @contextmenu.prevent="showTerminalMenu">
    <div ref="terminalEl" class="terminal-container" />
    <div v-if="exited" class="terminal-exited">
      <span>{{ $t('terminal.processExited') }}</span>
      <button class="btn-primary" style="margin-left:12px" @click="restartTerminal">{{ $t('terminal.restart') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import { useProjectStore } from '../../stores/projects'
import { useContextMenu } from '../../composables/useContextMenu'
import type { Tab } from '../../stores/tabs'

const { t } = useI18n()

const props = defineProps<{ tab: Tab }>()

const settingsStore = useSettingsStore()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const { show: showMenu } = useContextMenu()

const terminalEl = ref<HTMLDivElement | null>(null)
const exited = ref(false)
let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let unsubData: (() => void) | null = null
let unsubExit: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null
let isUnmounting = false
const cleanupRef: { current: (() => void) | null } = { current: null }

onMounted(async () => {
  await initTerminal()
})

onActivated(() => {
  nextTick(() => {
    fitAddon?.fit()
    term?.focus()
  })
})

onDeactivated(() => {
  // no-op: KeepAlive deactivation does not require cleanup
})

async function initTerminal() {
  if (!terminalEl.value) return
  exited.value = false
  isUnmounting = false

  term = new Terminal({
    theme: terminalTheme(),
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: settingsStore.settings.terminalFontSize,
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true
  })

  fitAddon = new FitAddon()
  searchAddon = new SearchAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(searchAddon)
  term.loadAddon(new WebLinksAddon())
  term.open(terminalEl.value)

  // Wire pty — create before fit so ptyResize has a target
  const homeDir = await window.electronAPI.getPath('home')
  const cwd = props.tab.terminalCwd || projectStore.activeProject?.path || homeDir || '/'

  unsubData = window.electronAPI.onPtyData(props.tab.id, (data) => {
    term?.write(data)
  })
  unsubExit = window.electronAPI.onPtyExit(props.tab.id, () => {
    if (!isUnmounting) exited.value = true
  })

  term.onData((data) => {
    window.electronAPI.ptyWrite(props.tab.id, data)
  })

  // Register before initial fit so PTY gets the correct size
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  term.onResize(({ cols, rows }) => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      window.electronAPI.ptyResize(props.tab.id, cols, rows)
    }, 50)
  })

  await window.electronAPI.ptyCreate(props.tab.id, cwd, settingsStore.settings.terminalShell || undefined)

  // Fit after PTY created + layout settled
  await nextTick()
  await new Promise(r => requestAnimationFrame(r))
  fitAddon.fit()

  // Handle agent launch events
  const agentHandler = (e: Event) => {
    const ev = e as CustomEvent<{ tabId: string; command: string; cwd: string }>
    if (ev.detail.tabId === props.tab.id) {
      setTimeout(() => {
        window.electronAPI.ptyWrite(props.tab.id, ev.detail.command + '\n')
      }, 500)
    }
  }
  window.addEventListener('agent-launch', agentHandler)
  ;(window as any)[`_agentHandler_${props.tab.id}`] = agentHandler

  // Respond to container resize (throttled to avoid jitter during drag)
  let rafPending = false
  resizeObserver = new ResizeObserver(() => {
    if (!rafPending) {
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        fitAddon?.fit()
      })
    }
  })
  if (terminalEl.value) resizeObserver.observe(terminalEl.value)

  cleanupRef.current = () => {
    isUnmounting = true
    exited.value = false
    unsubData?.()
    unsubExit?.()
    window.electronAPI.ptyClose(props.tab.id).catch(() => {})
    resizeObserver?.disconnect()
    term?.dispose()
    term = null
    const handler = (window as any)[`_agentHandler_${props.tab.id}`]
    if (handler) {
      window.removeEventListener('agent-launch', handler)
      delete (window as any)[`_agentHandler_${props.tab.id}`]
    }
  }
}

function terminalTheme() {
  const dark = settingsStore.settings.theme === 'dark'
  return dark ? {
    background: '#1e1e1e', foreground: '#d4d4d4',
    cursor: '#d4d4d4', selectionBackground: '#264f78',
    black: '#1e1e1e', red: '#f44747', green: '#4ec9b0',
    yellow: '#dcdcaa', blue: '#569cd6', magenta: '#c678dd',
    cyan: '#9cdcfe', white: '#d4d4d4'
  } : {
    background: '#ffffff', foreground: '#1e1e1e',
    cursor: '#1e1e1e', selectionBackground: '#add6ff',
    black: '#1e1e1e', red: '#d32f2f', green: '#007462',
    yellow: '#7b5900', blue: '#0070c1', magenta: '#7c3aed',
    cyan: '#007462', white: '#f3f3f3'
  }
}

function clearTerminal() {
  term?.clear()
}

async function restartTerminal() {
  cleanupRef.current?.()
  if (terminalEl.value) terminalEl.value.innerHTML = ''
  await initTerminal()
}

function showTerminalMenu(e: MouseEvent) {
  showMenu(e, [
    { label: t('terminal.copy'), action: () => term?.getSelection() && navigator.clipboard.writeText(term.getSelection()) },
    { label: t('terminal.paste'), action: async () => { const c = await navigator.clipboard.readText(); window.electronAPI.ptyWrite(props.tab.id, c) } },
    { separator: true },
    { label: t('terminal.clear'), action: clearTerminal },
    { label: t('terminal.restart'), action: restartTerminal }
  ])
}

watch(() => settingsStore.settings.theme, () => {
  term?.options.theme && (term.options.theme = terminalTheme())
})

watch(() => settingsStore.settings.terminalFontSize, (size) => {
  if (term) term.options.fontSize = size
  fitAddon?.fit()
})

onBeforeUnmount(() => {
  console.log('[TerminalTab] onBeforeUnmount: tabId=' + props.tab.id.slice(0,8))
  cleanupRef.current?.()
})
</script>

<style scoped>
.terminal-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #1e1e1e;
}
.terminal-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.terminal-exited {
  padding: 8px 12px;
  background: var(--bg-tertiary);
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
}
</style>
