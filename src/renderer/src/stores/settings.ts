import { defineStore } from 'pinia'
import { ref } from 'vue'
import { toPlainObject } from '../utils'

export interface Settings {
  theme: 'dark' | 'light'
  accentColor?: 'default' | 'indigo' | 'emerald' | 'rose' | 'amber'
  fontSize: number
  terminalShell: string
  terminalFontSize: number
  gitExecutable: string
  defaultSearchEngine: string
  browserHomeUrl: string
  showBookmarksBar: boolean
  openBookmarksInNewTab: boolean
  autoSaveInterval: number
  language: 'en' | 'zh-CN'
  shortcuts: Record<string, string>
  editorWordWrap: 'off' | 'on' | 'wordWrapColumn' | 'bounded'
  editorWordWrapColumn: number
  autoUpdate: boolean
  showPanelIcons: boolean
  markdownPreview: boolean
}

const defaults: Settings = {
  theme: 'dark',
  accentColor: 'default',
  fontSize: 15,
  terminalShell: '',
  terminalFontSize: 13,
  gitExecutable: 'git',
  defaultSearchEngine: 'https://www.google.com/search?q=',
  browserHomeUrl: '',
  showBookmarksBar: true,
  openBookmarksInNewTab: false,
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
  editorWordWrapColumn: 80,
  autoUpdate: true,
  showPanelIcons: true,
  markdownPreview: true
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
      // Font size was inert while the type scale was absolute px, so a stored
      // 14 is just the old default and would now shrink the whole UI. Treat it
      // as unset; any deliberate value the user re-picks is applied verbatim.
      if ((cleaned as any).fontSize === 14) (cleaned as any).fontSize = 15
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

  interface AccentTokens {
    /** Fill colour: always readable under white text (>= 4.5:1). */
    accent: string
    /** Text / icon colour for the current theme's canvas. */
    strong: string
    soft: string
    ring: string
    activeBg: string
    selectedBg: string
    onAccent: string
  }

  function hexToRgba(hex: string, alpha: number): string {
    const h = hex.replace('#', '')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  function tokens(accent: string, strong: string, onAccent = '#ffffff'): AccentTokens {
    return {
      accent,
      strong,
      onAccent,
      soft: hexToRgba(accent, 0.16),
      ring: hexToRgba(strong, 0.55),
      activeBg: hexToRgba(accent, 0.18),
      selectedBg: hexToRgba(accent, 0.12)
    }
  }

  // One entry per theme: the fill is dark enough for white text in both
  // themes, while --strong is tuned to read as text on that theme's canvas.
  const ACCENT_MAP: Record<string, Record<'dark' | 'light', AccentTokens>> = {
    indigo: {
      dark: tokens('#4f46e5', '#a5b4fc'),
      light: tokens('#4f46e5', '#4338ca')
    },
    emerald: {
      dark: tokens('#047857', '#34d399'),
      light: tokens('#047857', '#065f46')
    },
    rose: {
      dark: tokens('#be123c', '#fb7185'),
      light: tokens('#be123c', '#9f1239')
    },
    amber: {
      dark: tokens('#b45309', '#fbbf24'),
      light: tokens('#b45309', '#92400e')
    }
  }

  function applyTheme() {
    const root = document.documentElement
    root.setAttribute('data-theme', settings.value.theme)
    // Screen readers and hyphenation need the document language to follow the UI.
    root.setAttribute('lang', settings.value.language)
    root.style.setProperty('--base-font-size', `${settings.value.fontSize}px`)

    const preset = settings.value.accentColor ? ACCENT_MAP[settings.value.accentColor] : undefined
    const set = preset ? preset[settings.value.theme] : undefined
    const overrides: Record<string, string | undefined> = {
      '--accent': set?.accent,
      '--accent-strong': set?.strong,
      '--accent-soft': set?.soft,
      '--accent-ring': set?.ring,
      '--text-accent': set?.strong,
      '--text-on-accent': set?.onAccent,
      '--bg-active': set?.activeBg,
      '--bg-selected': set?.selectedBg
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (value) root.style.setProperty(name, value)
      else root.style.removeProperty(name)
    }
  }

  return { settings, defaults, load, save, update, applyTheme }
})