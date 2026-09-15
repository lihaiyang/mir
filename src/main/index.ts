import { app, BrowserWindow, session, nativeImage, Menu, MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

// Dev builds must use a separate userData directory so they do NOT share the
// same mir-state.json as an installed (release) instance running at the same
// time. electron-store (ipc.ts / updater.ts) persists to app.getPath('userData'),
// so redirecting it here — before any Store is instantiated — fully isolates
// the two instances. Without this, the release instance overwrites itemOrder
// (and all other state) with its stale in-memory copy, making drag-reorder
// appear to have no effect after a restart.
//
// NOTE: installed apps derive userData from the package.json "name" field
// (app.getName()), which is "mir" for BOTH the stable build (MIR.app) and the
// dev-channel build (MIR Dev.app) — so without this redirect the two installed
// versions would share ~/Library/Application Support/mir, including the
// webview partition storage (Service Workers, cookies, IndexedDB). Concurrent
// or alternating use corrupts the shared partition (e.g. SW registration
// fails with "The document is in an invalid state" and pages won't open).
// Redirect every dev-channel build (version contains "-dev") to mir-dev.
if (process.env.ELECTRON_RENDERER_URL || app.getVersion().includes('-dev')) {
  app.setPath('userData', join(app.getPath('appData'), 'mir-dev'))
}

import { setupIpcHandlers } from './ipc'
import { killAllPtyProcesses } from './pty'
import { initUpdater, checkForUpdateNow, setUpdaterStateListener, performPendingUpdate, hasPendingUpdate, openReleasesPage, UpdaterEvent } from './updater'
import { registerPluginScheme, registerPluginProtocol, initMainPlugins } from './plugins'

// Prevent "Error: write EIO/EPIPE" uncaught exceptions: when the app is launched
// from a terminal that later closes (or its stdout/stderr pipe breaks), any
// console.* write in the main process would otherwise crash the whole app.
// Swallowing stream errors is safe — a failed log write is never worth crashing.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {})
}

const ICON_PATH = join(__dirname, '../../build/icon.png')


// Linux: Chrome sandbox requires user namespaces; disable for broader compatibility
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox')
}

// Register the mir-plugin:// scheme before app ready so the protocol is available
registerPluginScheme()

function setupBrowserSession(): void {
  // Pre-create the partition session to ensure service worker storage works
  session.fromPartition('persist:browser', { cache: true })
}

// Updater menu state — tracked in variables so buildAppMenu always uses
// the latest label. We rebuild the menu on each state change (reliable for
// closed menus) AND try to mutate the item in place (for open menus).
  let updaterLabel = `检查更新… (v${app.getVersion()}) ✓`
  let updaterEnabled = true
  let appMenu: Electron.Menu | null = null

// Reload keys (Cmd/Ctrl+R, Cmd/Ctrl+Shift+R, F5) must NOT reload the whole
// window — that would wipe all renderer state. We intercept them at the input
// level and forward a targeted "reload active browser tab" signal instead.
function isReloadShortcut(input: Electron.Input): boolean {
  if (input.type !== 'keyDown') return false
  if (input.key === 'F5') return true
  const mod = process.platform === 'darwin' ? input.meta : input.control
  if (!mod) return false
  return input.key.toLowerCase() === 'r'
}

// View submenu WITHOUT the default reload / forceReload accelerators.
function buildViewSubmenu(): MenuItemConstructorOptions {
  return {
    label: '视图',
    submenu: [
      { role: 'toggleDevTools', label: '开发者工具' },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' }
    ]
  }
}

// Windows/Linux: no app-name submenu, but still need an explicit menu so the
// Electron default (which includes Ctrl+R reload) is not used.
function buildDefaultMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { label: '文件', submenu: [{ role: 'quit' }] },
    { role: 'editMenu' },
    buildViewSubmenu()
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function buildAppMenu(): void {
  if (process.platform !== 'darwin') return
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          id: 'updater',
          label: updaterLabel,
          enabled: updaterEnabled,
          click: () => { checkForUpdateNow(true).catch(() => {}) }
        },
        { label: '打开下载页面…', click: () => { openReleasesPage() } },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    buildViewSubmenu(),
    { role: 'windowMenu' }
  ]
  appMenu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(appMenu)
}

function setupMenu(): void {
  if (process.platform === 'darwin') buildAppMenu()
  else buildDefaultMenu()
}

function updateMenuForState(e: UpdaterEvent): void {
  if (process.platform !== 'darwin') return
  let label = `检查更新… (v${app.getVersion()}) ✓`
  let enabled = true
  if (e.status === 'checking') {
    label = '正在检查更新…'
    enabled = false
  } else if (e.status === 'available' || e.status === 'downloading') {
    label = `正在下载 v${e.version ?? ''}… ${e.progress ?? 0}%`
    enabled = false
  } else if (e.status === 'extracting') {
    label = `正在解压 v${e.version ?? ''}…`
    enabled = false
  }
  if (label === updaterLabel && enabled === updaterEnabled) return
  updaterLabel = label
  updaterEnabled = enabled
  // Rebuild the whole menu — reliably updates when menu is closed.
  buildAppMenu()
  // Also try in-place mutation for when the menu is currently open.
  const item = appMenu?.getMenuItemById('updater')
  if (item) {
    item.label = label
    item.enabled = enabled
  }
}

let mainWindow: BrowserWindow | null = null

function configureWebviewSession(webContents: Electron.WebContents): void {
  const ses = webContents.session

  // Allow all permission requests (Service Worker, notifications, etc.)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(true)
  })

  // Remove headers that can interfere with Service Worker registration
  ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
    const headers: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(details.responseHeaders ?? {})) {
      const lower = k.toLowerCase()
      if (lower !== 'x-frame-options') {
        headers[k] = v
      }
    }
    callback({ responseHeaders: headers })
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    ...(existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true
    }
  })
  mainWindow = win

  // Intercept reload shortcuts (Cmd/Ctrl+R, F5) on the host so they never
  // reload the whole window — instead forward a targeted signal to the renderer.
  win.webContents.on('before-input-event', (event, input) => {
    if (isReloadShortcut(input)) {
      event.preventDefault()
      win.webContents.send('shortcut:reload-browser')
    }
  })

  // Forward renderer console to terminal for debugging plugin loading
  win.webContents.on('console-message', (_e, level, message) => {
    const tag = ['LOG', 'WARN', 'ERROR'][level] ?? 'LOG'
    console.log(`[renderer:${tag}] ${message}`)
  })

  // Inject the webview-specific preload so navigator.serviceWorker.register
  // is patched before any page script in the embedded browser runs.
  win.webContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.preload = join(__dirname, '../preload/webview.js')
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Configure webview sessions when they are created
app.on('web-contents-created', (_event, webContents) => {
  if (webContents.getType() === 'webview') {
    configureWebviewSession(webContents)
    // Same reload-shortcut interception inside embedded browser pages.
    webContents.on('before-input-event', (event, input) => {
      if (isReloadShortcut(input)) {
        event.preventDefault()
        const host = webContents.hostWebContents
        if (host) host.send('shortcut:reload-browser')
      }
    })
    // Redirect window.open / target=_blank into a new tab: deny the actual
    // popup window and forward the URL to the renderer for routing.
    webContents.setWindowOpenHandler(({ url }) => {
      const host = webContents.hostWebContents
      if (host) host.send('webview:new-window', url)
      return { action: 'deny' }
    })
  }
})

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && existsSync(ICON_PATH)) {
    app.dock.setIcon(nativeImage.createFromPath(ICON_PATH))
  }

  setupBrowserSession()
  setupMenu()
  setupIpcHandlers()
  registerPluginProtocol()
  await initMainPlugins()
  createWindow()
  initUpdater(() => mainWindow)
  setUpdaterStateListener(updateMenuForState)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// On macOS, silently apply a pending update when the user quits the app.
// before-quit fires for Cmd+Q, window close (on macOS the app stays alive),
// and explicit app.quit(). We ONLY intercept when there is a pending update
// ready to apply — otherwise every quit would be delayed by a preventDefault
// round-trip, and system logout/shutdown could think the app refused to quit.
// The isApplying flag lets the second app.quit() (after scheduling the swap)
// proceed. The actual replacement runs in a detached script after exit, so a
// force-kill during shutdown cannot leave /Applications/MIR.app missing.
let isApplyingUpdate = false
app.on('before-quit', (event) => {
  // Kill every PTY child process so no shells outlive the app.
  killAllPtyProcesses()
  if (isApplyingUpdate) return
  if (process.platform !== 'darwin') return
  if (!hasPendingUpdate()) return
  event.preventDefault()
  isApplyingUpdate = true
  performPendingUpdate(false)
  app.quit()
})
