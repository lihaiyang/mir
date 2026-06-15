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
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>({ ...defaults })

  async function load() {
    const stored = await window.electronAPI.storeGet('settings')
    if (stored && typeof stored === 'object') {
      settings.value = { ...defaults, ...(stored as Partial<Settings>) }
    }
  }

  async function save() {
    await window.electronAPI.storeSet('settings', toPlainObject(settings.value))
    applyTheme()
  }

  async function update(patch: Partial<Settings>) {
    Object.assign(settings.value, patch)
    await save()
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', settings.value.theme)
    document.documentElement.style.setProperty('--base-font-size', `${settings.value.fontSize}px`)
  }

  return { settings, load, save, update, applyTheme }
})
