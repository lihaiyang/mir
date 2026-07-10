import * as Vue from 'vue'
import i18n from '../i18n'
import { useTabStore } from '../stores/tabs'
import { useProjectStore } from '../stores/projects'
import { useSettingsStore } from '../stores/settings'
import { useLayoutStore } from '../stores/layout'
import {
  registerTabType,
  unregisterTabType,
  registerRightPanel,
  unregisterRightPanel,
  type TabTypeRegistration,
  type RightPanelRegistration
} from './registries'
import { registerCommand, unregisterCommand } from '../composables/useCommandPalette'

interface PluginManifest {
  id: string
  name: string
  version: string
  main?: string
  mainMain?: string
}

interface LoadedPlugin {
  id: string
  deactivate?: (api: unknown) => void
}

const loaded: LoadedPlugin[] = []

function createContext(pluginId: string) {
  return {
    commands: {
      register: registerCommand,
      unregister: unregisterCommand
    },
    tabs: {
      registerType: (reg: TabTypeRegistration) => registerTabType(reg),
      unregisterType: (type: string) => unregisterTabType(type),
      add: (projectId: string, type: string, extra?: Record<string, unknown>) =>
        useTabStore().addTab(projectId, type as any, extra as any)
    },
    panels: {
      registerRight: (reg: RightPanelRegistration) => registerRightPanel(reg),
      unregisterRight: (id: string) => unregisterRightPanel(id)
    },
    ipc: {
      invoke: (channel: string, ...args: unknown[]) =>
        window.electronAPI.pluginInvoke(pluginId, channel, ...args),
      send: (channel: string, ...args: unknown[]) =>
        window.electronAPI.pluginSend(pluginId, channel, ...args),
      on: (channel: string, cb: (...args: unknown[]) => void) =>
        window.electronAPI.pluginOn(pluginId, channel, cb)
    },
    app: {
      vue: Vue,
      i18n: { t: i18n.global.t.bind(i18n.global) },
      stores: {
        tabs: useTabStore(),
        projects: useProjectStore(),
        settings: useSettingsStore(),
        layout: useLayoutStore()
      }
    },
    logger: {
      info: (...args: unknown[]) => console.log(`[plugin:${pluginId}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[plugin:${pluginId}]`, ...args),
      error: (...args: unknown[]) => console.error(`[plugin:${pluginId}]`, ...args)
    }
  }
}

export async function initRendererPlugins(): Promise<void> {
  const plugins = (await window.electronAPI.pluginList()) as Array<{
    manifest: PluginManifest
    enabled: boolean
  }>

  for (const { manifest, enabled } of plugins) {
    if (!enabled || !manifest.main) continue
    try {
      const url = `mir-plugin://${manifest.id}/${manifest.main}`
      const mod = await import(/* @vite-ignore */ url)
      if (typeof mod.activate === 'function') {
        const ctx = createContext(manifest.id)
        await mod.activate(ctx)
        loaded.push({
          id: manifest.id,
          deactivate: typeof mod.deactivate === 'function' ? mod.deactivate : undefined
        })
        console.log(`[plugins] Loaded renderer entry: ${manifest.id}`)
      }

      // Inject CSS if present (Vite library mode outputs a separate .css file)
      try {
        const cssUrl = `mir-plugin://${manifest.id}/mir.css`
        const cssRes = await fetch(cssUrl)
        if (cssRes.ok) {
          const css = await cssRes.text()
          const style = document.createElement('style')
          style.setAttribute('data-plugin', manifest.id)
          style.textContent = css
          document.head.appendChild(style)
        }
      } catch { /* no CSS — fine */ }
    } catch (e) {
      console.error(`[plugins] Failed to load renderer ${manifest.id}:`, e)
    }
  }
}
