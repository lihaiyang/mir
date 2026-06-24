import { app, BrowserWindow, session, nativeImage, Menu, MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { setupIpcHandlers } from './ipc'
import { initUpdater, checkForUpdateNow, setUpdaterStateListener, performPendingUpdate, hasPendingUpdate, openReleasesPage, UpdaterEvent } from './updater'

const ICON_PATH = join(__dirname, '../../build/icon.png')


// Linux: Chrome sandbox requires user namespaces; disable for broader compatibility
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox')
}

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
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  appMenu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(appMenu)
}

function setupMenu(): void {
  buildAppMenu()
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
  }
})

app.whenReady().then(() => {
  if (process.platform === 'darwin' && existsSync(ICON_PATH)) {
    app.dock.setIcon(nativeImage.createFromPath(ICON_PATH))
  }

  setupBrowserSession()
  setupMenu()
  setupIpcHandlers()
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
  if (isApplyingUpdate) return
  if (process.platform !== 'darwin') return
  if (!hasPendingUpdate()) return
  event.preventDefault()
  isApplyingUpdate = true
  performPendingUpdate(false)
  app.quit()
})
