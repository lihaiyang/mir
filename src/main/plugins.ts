import { app, ipcMain, BrowserWindow, protocol } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, cpSync, rmSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import Store from 'electron-store'

const execAsync = promisify(execFile)

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  main?: string
  mainMain?: string
  engines?: { mir?: string }
}

interface PluginRecord {
  manifest: PluginManifest
  dir: string
  enabled: boolean
}

interface MainPluginContext {
  ipc: {
    registerHandler: (channel: string, fn: (...args: any[]) => any) => void
    registerOn: (channel: string, fn: (...args: any[]) => void) => void
  }
  store: {
    get: (key: string) => unknown
    set: (key: string, value: unknown) => void
    delete: (key: string) => void
  }
  paths: {
    userData: string
    home: string
    pluginsDir: string
  }
  app: Electron.App
  getWindow: () => BrowserWindow | null
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

const loadedPlugins: Map<string, { deactivate?: () => void; channels: string[] }> = new Map()

// Shared module key lists, populated by the renderer via IPC before any plugin loads.
// The renderer owns the actual Vue/Pinia/vue-i18n instances (globalThis.__MIR_SHARED__);
// the main process only needs the export names to generate ESM re-export shims.
const sharedModuleKeys: Map<string, string[]> = new Map()

export function setSharedModuleKeys(moduleName: string, keys: string[]): void {
  sharedModuleKeys.set(moduleName, keys)
}

export function getPluginsDir(): string {
  return join(app.getPath('userData'), 'plugins')
}

// Lazy singleton (mirrors ipc.ts) — a `new Store` per call re-reads the JSON
// file, builds a fresh object graph and races other instances' caches.
let _store: Store | null = null
function getStore(): Store {
  if (!_store) _store = new Store({ name: 'mir-state' })
  return _store
}

function readPluginState(): Record<string, { enabled?: boolean; version?: string; installedAt?: string }> {
  return (getStore().get('plugins') as Record<string, any>) ?? {}
}

export function discoverPlugins(): PluginRecord[] {
  const dir = getPluginsDir()
  if (!existsSync(dir)) return []
  const state = readPluginState()
  const records: PluginRecord[] = []

  for (const entry of readdirSync(dir)) {
    const pluginDir = join(dir, entry)
    if (!statSync(pluginDir).isDirectory()) continue
    const manifestPath = join(pluginDir, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
      const pluginState = state[manifest.id]
      records.push({
        manifest,
        dir: pluginDir,
        enabled: pluginState?.enabled !== false
      })
    } catch (e) {
      console.error(`[plugins] Failed to parse manifest for ${entry}:`, e)
    }
  }
  return records
}

function createMainContext(pluginId: string): { ctx: MainPluginContext; channels: string[] } {
  const store = getStore()
  const log = (...args: unknown[]) => console.log(`[plugin:${pluginId}]`, ...args)
  // Track every ipcMain channel this plugin registers so disable/uninstall
  // can remove them — otherwise the module's closures stay reachable through
  // ipcMain's listener registry (and stay callable) for the process lifetime.
  const channels: string[] = []
  return {
    ctx: {
      ipc: {
        registerHandler(channel: string, fn: (...args: any[]) => any) {
          const full = `plugin:${pluginId}:${channel}`
          ipcMain.handle(full, (_e, ...args) => fn(...args))
          channels.push(full)
        },
        registerOn(channel: string, fn: (...args: any[]) => void) {
          const full = `plugin:${pluginId}:${channel}`
          ipcMain.on(full, (_e, ...args) => fn(...args))
          channels.push(full)
        }
      },
      store: {
        get(key: string) { return store.get(`plugin:${pluginId}:${key}`) },
        set(key: string, value: unknown) { store.set(`plugin:${pluginId}:${key}`, value) },
        delete(key: string) { store.delete(`plugin:${pluginId}:${key}`) }
      },
      paths: {
        userData: app.getPath('userData'),
        home: app.getPath('home'),
        pluginsDir: getPluginsDir()
      },
      app,
      getWindow: () => BrowserWindow.getFocusedWindow(),
      logger: {
        info: log,
        warn: (...args: unknown[]) => console.warn(`[plugin:${pluginId}]`, ...args),
        error: (...args: unknown[]) => console.error(`[plugin:${pluginId}]`, ...args)
      }
    },
    channels
  }
}

// Tear down a loaded main-process plugin: run its deactivate hook, remove all
// its IPC handlers/listeners and drop it from the registry.
function teardownPlugin(pluginId: string): void {
  const rec = loadedPlugins.get(pluginId)
  if (!rec) return
  try { rec.deactivate?.() } catch (e) {
    console.error(`[plugins] deactivate() threw for ${pluginId}:`, e)
  }
  for (const ch of rec.channels) {
    try { ipcMain.removeHandler(ch) } catch { /* not a handler */ }
    try { ipcMain.removeAllListeners(ch) } catch { /* no listeners */ }
  }
  loadedPlugins.delete(pluginId)
  console.log(`[plugins] Unloaded main entry: ${pluginId}`)
}

// Activate a plugin's main entry (used at startup and when re-enabling at
// runtime without a restart). No-op if already loaded.
async function activatePluginMain(record: PluginRecord): Promise<void> {
  if (!record.manifest.mainMain || loadedPlugins.has(record.manifest.id)) return
  const entryPath = join(record.dir, record.manifest.mainMain)
  const entryUrl = pathToFileURL(entryPath).href
  const mod = await import(entryUrl)
  if (typeof mod.activate !== 'function') return
  const { ctx, channels } = createMainContext(record.manifest.id)
  await mod.activate(ctx)
  loadedPlugins.set(record.manifest.id, {
    deactivate: typeof mod.deactivate === 'function' ? () => mod.deactivate(ctx) : undefined,
    channels
  })
  console.log(`[plugins] Loaded main entry: ${record.manifest.id}`)
}

export async function initMainPlugins(): Promise<void> {
  const records = discoverPlugins()
  for (const record of records) {
    if (!record.enabled) continue
    if (!record.manifest.mainMain) continue
    try {
      await activatePluginMain(record)
    } catch (e) {
      console.error(`[plugins] Failed to load ${record.manifest.id}:`, e)
    }
  }
}

export function registerPluginProtocol(): void {
  protocol.handle('mir-plugin', (request) => {
    const url = new URL(request.url)
    const pluginId = url.hostname

    // Shared modules: serve re-export shims that bridge globalThis.__MIR_SHARED__
    // to ESM imports. This lets plugins `import { ref } from 'vue'` and get MIR's
    // actual Vue instance (same reactivity, same component registry, same Pinia).
    if (pluginId === '__shared') {
      const modName = url.pathname.replace(/^\//, '').replace(/\.js$/, '')
      const keys = sharedModuleKeys.get(modName) ?? []
      const lines = keys.map(k => `export const ${k} = m.${k}`)
      lines.push('export default m.default || m')
      const body = `const m = globalThis.__MIR_SHARED__?.['${modName}']\n` +
        `if (!m) throw new Error('[mir-plugin] Shared module "${modName}" not initialized')\n` +
        lines.join('\n')
      return new Response(body, {
        headers: { 'Content-Type': 'application/javascript' }
      })
    }

    // Plugin file serving
    const filePath = decodeURIComponent(url.pathname)
    const fullPath = join(getPluginsDir(), pluginId, filePath)
    try {
      const content = readFileSync(fullPath)
      const ext = filePath.split('.').pop()?.toLowerCase()
      const mime = ext === 'js' ? 'application/javascript'
        : ext === 'css' ? 'text/css'
        : ext === 'json' ? 'application/json'
        : 'application/octet-stream'
      return new Response(content, {
        headers: { 'Content-Type': mime }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'mir-plugin',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ])
}

export function getLoadedPlugins(): string[] {
  return Array.from(loadedPlugins.keys())
}

export function listPluginsForRenderer(): Array<{ manifest: PluginManifest; enabled: boolean }> {
  return discoverPlugins().map(r => ({ manifest: r.manifest, enabled: r.enabled }))
}

export function setPluginEnabled(pluginId: string, enabled: boolean): void {
  const state = readPluginState()
  if (!state[pluginId]) state[pluginId] = {}
  state[pluginId].enabled = enabled
  getStore().set('plugins', state)
  if (!enabled) {
    // Unload the main-process side immediately so its IPC handlers and module
    // closures don't stay resident (and callable) after disabling.
    teardownPlugin(pluginId)
  } else {
    // Best-effort re-activation without a restart. Note the ESM module cache
    // returns the already-imported module — fine for idempotent activate()s.
    const record = discoverPlugins().find(r => r.manifest.id === pluginId)
    if (record) {
      activatePluginMain(record).catch(e => {
        console.error(`[plugins] Failed to re-enable ${pluginId}:`, e)
      })
    }
  }
}

export function installPluginFromDir(srcDir: string): { success: boolean; error?: string; pluginId?: string } {
  // Validate source dir has plugin.json
  const manifestPath = join(srcDir, 'plugin.json')
  if (!existsSync(manifestPath)) {
    return { success: false, error: 'plugin.json not found in selected directory' }
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
    if (!manifest.id) return { success: false, error: 'plugin.json missing "id" field' }

    const pluginsDir = getPluginsDir()
    const destDir = join(pluginsDir, manifest.id)

    // Remove existing installation if any (also tears down its IPC handlers
    // so a later activate() won't hit "second handler" registration errors).
    if (existsSync(destDir)) {
      teardownPlugin(manifest.id)
      rmSync(destDir, { recursive: true, force: true })
    }

    // Copy entire directory
    cpSync(srcDir, destDir, { recursive: true })

    // Initialize plugin state as enabled
    const state = readPluginState()
    if (!state[manifest.id]) state[manifest.id] = {}
    state[manifest.id].enabled = true
    state[manifest.id].installedAt = new Date().toISOString()
    state[manifest.id].version = manifest.version
    getStore().set('plugins', state)

    return { success: true, pluginId: manifest.id }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export function uninstallPlugin(pluginId: string): { success: boolean; error?: string } {
  const pluginsDir = getPluginsDir()
  // Find the plugin directory (it may be named after the id, or we search by manifest)
  const records = discoverPlugins()
  const record = records.find(r => r.manifest.id === pluginId)
  if (!record) return { success: false, error: 'Plugin not found' }

  // Tear down the main-process side BEFORE removing files.
  teardownPlugin(pluginId)

  try {
    rmSync(record.dir, { recursive: true, force: true })
    // Remove from state
    const state = readPluginState()
    delete state[pluginId]
    getStore().set('plugins', state)
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export function getPluginsDirForRenderer(): string {
  return getPluginsDir()
}

export async function installPluginFromGit(
  gitUrl: string,
  subPath: string
): Promise<{ success: boolean; error?: string; pluginId?: string }> {
  const tmpDir = join(app.getPath('temp'), `mir-plugin-git-${Date.now()}`)
  try {
    // Shallow clone
    await execAsync('git', ['clone', '--depth', '1', gitUrl, tmpDir])

    // Resolve the plugin directory inside the cloned repo
    const pluginSrcDir = subPath.trim() ? join(tmpDir, subPath.trim()) : tmpDir
    if (!existsSync(pluginSrcDir)) {
      return { success: false, error: `Path "${subPath}" not found in repository` }
    }

    // Validate plugin.json
    const manifestPath = join(pluginSrcDir, 'plugin.json')
    if (!existsSync(manifestPath)) {
      return { success: false, error: `plugin.json not found at "${subPath || '/'}"` }
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
    if (!manifest.id) return { success: false, error: 'plugin.json missing "id" field' }

    // Install: copy to plugins dir
    const pluginsDir = getPluginsDir()
    const destDir = join(pluginsDir, manifest.id)
    if (existsSync(destDir)) {
      teardownPlugin(manifest.id)
      rmSync(destDir, { recursive: true, force: true })
    }
    cpSync(pluginSrcDir, destDir, { recursive: true })

    // Record state
    const state = readPluginState()
    if (!state[manifest.id]) state[manifest.id] = {}
    state[manifest.id].enabled = true
    state[manifest.id].installedAt = new Date().toISOString()
    state[manifest.id].version = manifest.version
    state[manifest.id].source = { type: 'git', url: gitUrl, subPath: subPath || '' }
    getStore().set('plugins', state)

    return { success: true, pluginId: manifest.id }
  } catch (e: any) {
    return { success: false, error: e?.message ? String(e.message) : String(e) }
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  }
}
