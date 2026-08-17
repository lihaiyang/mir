import { defineStore } from 'pinia'
import { ref } from 'vue'
import { debounce, toPlainObject } from '../utils'

export interface TerminalSession {
  scrollback: string
  cwd: string
}

// Cap stored scrollback so a chatty terminal doesn't bloat mir-state.json.
const MAX_SCROLLBACK_CHARS = 256 * 1024

export const useTerminalStore = defineStore('terminal', () => {
  const sessions = ref<Record<string, TerminalSession>>({})

  async function load() {
    const stored = await window.electronAPI.storeGet('terminalSessions')
    if (stored && typeof stored === 'object') {
      sessions.value = stored as Record<string, TerminalSession>
    }
  }

  async function doPersist() {
    await window.electronAPI.storeSet('terminalSessions', toPlainObject(sessions.value))
  }

  const persist = debounce(doPersist, 800)

  function saveSession(id: string, scrollback: string, cwd: string) {
    sessions.value[id] = {
      scrollback: scrollback.slice(-MAX_SCROLLBACK_CHARS),
      cwd
    }
    persist()
  }

  function getSession(id: string): TerminalSession | undefined {
    return sessions.value[id]
  }

  function removeSession(id: string) {
    if (sessions.value[id]) {
      delete sessions.value[id]
      persist()
    }
  }

  async function persistNow() {
    await doPersist()
  }

  // Drop sessions whose terminal tab no longer exists (e.g. closed tabs).
  function prune(validIds: Set<string>) {
    let changed = false
    for (const id of Object.keys(sessions.value)) {
      if (!validIds.has(id)) {
        delete sessions.value[id]
        changed = true
      }
    }
    if (changed) persist()
  }

  return {
    sessions, load, saveSession, getSession, removeSession, persistNow, prune
  }
})
