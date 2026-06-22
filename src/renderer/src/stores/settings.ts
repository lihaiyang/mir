import { defineStore } from 'pinia'
import { ref } from 'vue'
import { toPlainObject } from '../utils'

export interface Settings {
  theme: 'dark' | 'light'
  fontSize: number
  terminalShell: string
  terminalFontSize: number
  gitExecutable: string
  defaultSearchEngine: string
  autoSaveInterval: number
  language: 'en' | 'zh-CN'
  shortcuts: Record<string, string>
  editorWordWrap: 'off' | 'on' | 'wordWrapColumn' | 'bounded'
  editorWordWrapColumn: number
}

const defaults: Settings = {
  theme: 'dark',
  fontSize: 14,
  terminalShell: '',
  terminalFontSize: 13,
  gitExecutable: 'git',
  defaultSearchEngine: 'https://www.google.com/search?q=',
  autoSaveInterval: 0,
  language: 'en' as 'en' | 'zh-CN',
  shortcuts: {
    newTab: 'Ctrl+T',
    closeTab: 'Ctrl+W',
    nextTab: 'Ctrl+Tab',
    prevTab: 'Ctrl+Shift+Tab',
    commandPalette: 'Ctrl+Shift+P',
    settings: 'Ctrl+,',
    find: 'Ctrl+F',
    save: 'Ctrl+S'
  },
  editorWordWrap: 'on',
  editorWordWrapColumn: 80
}

function log(msg: string) {
  // Debug logging disabled — kept for quick re-enablement during troubleshooting
  // const ts = new Date().toISOString().substr(11, 12)
  // const line = `[${ts}][SettingsStore] ${msg}`
  // console.log(line)
  // try { window.electronAPI.debugLog(msg).catch(() => {}) } catch {}
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>({ ...defaults })

  async function load() {
    const stored = await window.electronAPI.storeGet('settings')
    log('load: raw stored keys=' + (stored ? Object.keys(stored).join(',') : 'null'))
    log('load: stored.editorWordWrap=' + (stored as any)?.editorWordWrap)
    log('load: stored.wordWrap=' + (stored as any)?.wordWrap)
    if (stored && typeof stored === 'object') {
      // Clean up stale 'wordWrap' key if present (from earlier buggy code)
      const cleaned = { ...stored }
      if ('wordWrap' in cleaned && !('editorWordWrap' in cleaned)) {
        log('load: migrating stale wordWrap=' + (cleaned as any).wordWrap + ' to editorWordWrap')
        ;(cleaned as any).editorWordWrap = (cleaned as any).wordWrap
      }
      delete (cleaned as any).wordWrap
      settings.value = { ...defaults, ...(cleaned as Partial<Settings>) }
    }
    log('load: after merge, settings.value.editorWordWrap=' + settings.value.editorWordWrap)
    log('load: all settings keys=' + Object.keys(settings.value).join(','))
  }

  async function save() {
    await window.electronAPI.storeSet('settings', toPlainObject(settings.value))
    applyTheme()
  }

  async function update(patch: Partial<Settings>) {
    // Remove any stale keys that might be in the patch
    const cleanPatch = { ...patch }
    delete (cleanPatch as any).wordWrap
    log('update called with patch keys=' + Object.keys(cleanPatch).join(',') + ' editorWordWrap=' + (cleanPatch as any).editorWordWrap)
    log('update: BEFORE settings.value.editorWordWrap=' + settings.value.editorWordWrap)
    settings.value = { ...settings.value, ...cleanPatch }
    log('update: AFTER settings.value.editorWordWrap=' + settings.value.editorWordWrap)
    await save()
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', settings.value.theme)
    document.documentElement.style.setProperty('--base-font-size', `${settings.value.fontSize}px`)
  }

  return { settings, load, save, update, applyTheme }
})