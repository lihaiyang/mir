import { app, BrowserWindow, session, nativeImage, Menu, MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { setupIpcHandlers } from './ipc'
import { initUpdater, checkForUpdateNow } from './updater'

const ICON_PATH = join(__dirname, '../../build/icon.png')


// Linux: Chrome sandbox requires user namespaces; disable for broader compatibility
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox')
}

function setupBrowserSession(): void {
  // Pre-create the partition session to ensure service worker storage works
  session.fromPartition('persist:browser', { cache: true })
}

function setupMenu(): void {
  if (process.platform !== 'darwin') return
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '检查更新…', click: () => { checkForUpdateNow(true).catch(() => {}) } },
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
