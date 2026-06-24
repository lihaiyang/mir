import { app, shell, BrowserWindow } from 'electron'
import * as https from 'https'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { execFile, spawn } from 'child_process'
import Store from 'electron-store'

const REPO = 'lihaiyang/mir'
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`
const CHECK_INTERVAL = 60 * 60 * 1000
const INITIAL_DELAY = 10 * 1000
const UA = 'mir-updater'

const mainStore = new Store({ name: 'mir-state' })

type UpdaterStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'extracting' | 'ready' | 'error'

export interface UpdaterEvent {
  status: UpdaterStatus
  version?: string
  progress?: number
  message?: string
  manual?: boolean
}

let getMainWindow: () => BrowserWindow | null = () => null
let downloadedAppPath: string | null = null
let downloadedVersion: string | null = null
let busy = false
let activeManual = false
let stateListener: ((event: UpdaterEvent) => void) | null = null

export function setUpdaterStateListener(cb: (event: UpdaterEvent) => void): void {
  stateListener = cb
}

function emit(event: UpdaterEvent): void {
  stateListener?.(event)
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:event', event)
  }
}

function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) }
}

function isNewer(remote: string, local: string): boolean {
  const rp = parseSemver(remote)
  const lp = parseSemver(local)
  if (!rp || !lp) return false
  if (rp.major !== lp.major) return rp.major > lp.major
  if (rp.minor !== lp.minor) return rp.minor > lp.minor
  return rp.patch > lp.patch
}

// Avoid api.github.com (60 req/hr unauthenticated rate limit).
// github.com/{repo}/releases/latest returns a 302 redirect to
// .../tag/vX.Y.Z — we capture the Location header without following it.
function fetchLatestVersion(): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const req = https.get(
    `https://github.com/${REPO}/releases/latest`,
    { headers: { 'User-Agent': UA } },
    (res) => {
      const status = res.statusCode ?? 0
      const loc = res.headers.location
      res.resume()
      if ((status === 301 || status === 302) && loc) {
        const match = loc.match(/\/(?:tag|releases)\/v?([^/]+?)(?:$|[?#])/)
        if (match) {
          resolve(match[1])
          return
        }
        reject(new Error(`cannot parse version from redirect: ${loc}`))
        return
      }
      reject(new Error(`unexpected status ${status}`))
    }
  )
  req.on('error', reject)
  req.setTimeout(15000, () => {
    req.destroy(new Error('request timeout'))
  })
  return promise
}

function downloadFile(
  url: string,
  dest: string,
  onProgress: (p: number) => void,
  redirects = 0
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  if (redirects > 5) {
    reject(new Error('too many redirects'))
    return promise
  }
  const file = fs.createWriteStream(dest)
  const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
    const status = res.statusCode ?? 0
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      file.close()
      try {
        fs.unlinkSync(dest)
      } catch {
        /* ignore */
      }
      const loc = res.headers.location
      res.resume()
      if (loc) {
        downloadFile(loc, dest, onProgress, redirects + 1).then(resolve, reject)
      } else {
        reject(new Error('redirect without location'))
      }
      return
    }
    if (status !== 200) {
      file.close()
      try {
        fs.unlinkSync(dest)
      } catch {
        /* ignore */
      }
      res.resume()
      reject(new Error(`HTTP ${status}`))
      return
    }
    const total = parseInt(res.headers['content-length'] ?? '0', 10)
    let received = 0
    let lastPct = -1
    res.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (total) {
        const pct = Math.min(100, Math.round((received / total) * 100))
        if (pct !== lastPct) {
          lastPct = pct
          onProgress(pct)
        }
      }
    })
    res.pipe(file)
    file.on('finish', () => {
      file.close(() => resolve())
    })
    file.on('error', (err) => {
      try {
        fs.unlinkSync(dest)
      } catch {
        /* ignore */
      }
      reject(err)
    })
  })
  req.on('error', (err) => {
    file.close()
    try {
      fs.unlinkSync(dest)
    } catch {
      /* ignore */
    }
    reject(err)
  })
  req.setTimeout(180000, () => {
    req.destroy(new Error('download timeout'))
  })
  return promise
}

// Unzip using the system `unzip` utility (always available on macOS).
// Extracts the .app bundle into the destination directory.
function extractZip(zipPath: string, destDir: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  // -o overwrite without prompting, -q quiet
  const child = execFile('unzip', ['-o', '-q', zipPath, '-d', destDir], (err) => {
    if (err) {
      reject(err)
      return
    }
    resolve()
  })
  child.on('error', reject)
  return promise
}

// Recursively remove a directory if it exists. Errors are swallowed for
// non-fatal cleanup of stale extraction dirs.
function safeRemoveDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// Resolve the .app bundle inside the extraction directory. electron-builder
// mac zips contain a single top-level `MIR.app/` directory.
function findAppBundle(extractDir: string): string | null {
  const entries = fs.readdirSync(extractDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) {
      return path.join(extractDir, entry.name)
    }
  }
  return null
}

// Detect macOS App Translocation: when an app is launched directly from a dmg
// or quarantine-marked download, macOS runs it from a randomized /private/var/folders
// path instead of its real install location. Updates cannot be applied there.
function isTranslocated(): boolean {
  const exePath = app.getPath('exe')
  // Translocated paths live under a randomized /private/var/folders/.../AppTranslocation/ dir
  return /AppTranslocation/.test(exePath)
}

async function checkForUpdate(manual: boolean): Promise<void> {
  if (busy) {
    // A check is already in flight. If this is a manual request, upgrade
    // the running check so its result events are treated as manual.
    if (manual) activeManual = true
    return
  }
  busy = true
  activeManual = manual
  try {
    if (isTranslocated()) {
      emit({
        status: 'error',
        message: 'App is running from a translocated location. Move MIR.app to /Applications and relaunch.',
        manual: activeManual
      })
      return
    }

    // Fail fast if we cannot locate the install location or lack write
    // permission to apply the update. Surfaced as an error event (shown for
    // manual checks, silent for automatic polls).
    const installedPath = findInstalledAppPath()
    if (!installedPath) {
      emit({
        status: 'error',
        message: '无法定位 MIR.app 安装位置，请确保已安装到「应用程序」文件夹。',
        manual: activeManual
      })
      return
    }
    try {
      fs.accessSync(path.dirname(installedPath), fs.constants.W_OK)
    } catch {
      emit({
        status: 'error',
        message: '无应用程序目录写入权限，请手动下载更新。',
        manual: activeManual
      })
      return
    }

    emit({ status: 'checking', manual: activeManual })
    const remoteVersion = await fetchLatestVersion()
    const localVersion = app.getVersion()

    if (!isNewer(remoteVersion, localVersion)) {
      emit({ status: 'not-available', manual: activeManual })
      return
    }

    // Already extracted this version — ready to apply on quit.
    if (
      downloadedVersion === remoteVersion &&
      downloadedAppPath &&
      fs.existsSync(downloadedAppPath)
    ) {
      emit({ status: 'ready', version: remoteVersion, manual: activeManual })
      return
    }

    // electron-builder mac zip naming: MIR-{version}-arm64-mac.zip
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const assetName = `MIR-${remoteVersion}-${arch}-mac.zip`
    const assetUrl = `https://github.com/${REPO}/releases/download/v${remoteVersion}/${assetName}`

    emit({ status: 'available', version: remoteVersion, manual: activeManual })

    const tmpDir = path.join(os.tmpdir(), `mir-update-${remoteVersion}`)
    safeRemoveDir(tmpDir)
    await fsp.mkdir(tmpDir, { recursive: true })

    const zipPath = path.join(tmpDir, assetName)
    emit({ status: 'downloading', version: remoteVersion, progress: 0, manual: activeManual })
    await downloadFile(assetUrl, zipPath, (p) => {
      emit({ status: 'downloading', version: remoteVersion, progress: p, manual: activeManual })
    })

    emit({ status: 'extracting', version: remoteVersion, progress: 0, manual: activeManual })
    const extractDir = path.join(tmpDir, 'extracted')
    await fsp.mkdir(extractDir, { recursive: true })
    await extractZip(zipPath, extractDir)

    const appPath = findAppBundle(extractDir)
    if (!appPath) {
      throw new Error('extracted archive does not contain an .app bundle')
    }

    // Remove the zip to free space; keep the extracted .app for the apply step.
    try {
      await fsp.unlink(zipPath)
    } catch {
      /* ignore */
    }

    downloadedAppPath = appPath
    downloadedVersion = remoteVersion
    emit({ status: 'ready', version: remoteVersion, manual: activeManual })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[updater] check failed:', message)
    emit({ status: 'error', message, manual: activeManual })
  } finally {
    busy = false
  }
}

let autoUpdateEnabled = true
let initialTimer: ReturnType<typeof setTimeout> | null = null
let intervalTimer: ReturnType<typeof setInterval> | null = null

function readAutoUpdateSetting(): boolean {
  const stored = mainStore.get('settings') as { autoUpdate?: boolean } | undefined
  return stored?.autoUpdate !== false
}

function clearTimers(): void {
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
  }
  if (intervalTimer) {
    clearInterval(intervalTimer)
    intervalTimer = null
  }
}

function startTimers(): void {
  clearTimers()
  initialTimer = setTimeout(() => {
    checkForUpdate(false).catch(() => {})
  }, INITIAL_DELAY)
  intervalTimer = setInterval(() => {
    checkForUpdate(false).catch(() => {})
  }, CHECK_INTERVAL)
}

export function setAutoUpdate(enabled: boolean): void {
  autoUpdateEnabled = enabled
  if (process.platform !== 'darwin') return
  if (!app.isPackaged) return
  if (enabled) {
    startTimers()
  } else {
    clearTimers()
  }
}

export function isAutoUpdateEnabled(): boolean {
  return autoUpdateEnabled
}

export function initUpdater(getWin: () => BrowserWindow | null): void {
  getMainWindow = getWin
  if (process.platform !== 'darwin') return
  if (!app.isPackaged) return
  autoUpdateEnabled = readAutoUpdateSetting()
  if (autoUpdateEnabled) startTimers()
}

export async function checkForUpdateNow(manual = false): Promise<void> {
  if (process.platform !== 'darwin') return
  await checkForUpdate(manual)
}

export function openReleasesPage(): void {
  void shell.openExternal(RELEASES_URL)
}

// Find the real installed location by walking up from the running exe path
// until we find the .app bundle root. Rejects translocated paths.
function findInstalledAppPath(): string | null {
  const exePath = app.getPath('exe')
  if (isTranslocated()) return null
  // exePath = /Applications/MIR.app/Contents/MacOS/MIR
  // Walk up to the .app directory.
  let current = path.dirname(exePath) // .../Contents/MacOS
  for (let i = 0; i < 6; i++) {
    if (path.basename(current) === 'Contents') {
      const appPath = path.dirname(current) // the .app
      if (appPath.endsWith('.app')) return appPath
      return null
    }
    current = path.dirname(current)
    if (current === '/' || current === '') return null
  }
  return null
}

// Build the detached swap script. Runs after the app exits: waits for the
// main process to go away, then atomically replaces the installed .app with
// the downloaded one (mv old aside, mv new in, rm old), rolling back on
// failure. Optionally relaunches the new app. Detached + unref'd so it
// survives the app quitting — this is what avoids the shutdown-race window
// where /Applications/MIR.app would be missing if the app were force-killed
// mid-swap.
function spawnSwapScript(installedPath: string, newAppPath: string, relaunch: boolean): void {
  const lines = [
    'APP="$1"',
    'NEW="$2"',
    'REL="$3"',
    'PROC="${APP##*/}"',
    'PROC="${PROC%.app}"',
    'i=0',
    'while [ "$i" -lt 100 ]; do',
    '  pgrep -x "$PROC" >/dev/null 2>&1 || break',
    '  sleep 0.1',
    '  i=$((i+1))',
    'done',
    'sleep 0.3',
    'DIR="$(dirname "$APP")"',
    'BACKUP="$DIR/.MIR.app.old.$$"',
    'STAGING="$DIR/.MIR.app.staging.$$"',
    'mv "$NEW" "$STAGING" || exit 1',
    'if ! mv "$APP" "$BACKUP"; then mv "$STAGING" "$NEW" 2>/dev/null; exit 1; fi',
    'if ! mv "$STAGING" "$APP"; then mv "$BACKUP" "$APP" 2>/dev/null; mv "$STAGING" "$NEW" 2>/dev/null; exit 1; fi',
    'rm -rf "$BACKUP" "$(dirname "$NEW")" 2>/dev/null',
    'rmdir "$(dirname "$(dirname "$NEW")")" 2>/dev/null',
    '[ "$REL" = "1" ] && open "$APP"',
    'exit 0'
  ]
  const script = lines.join('\n')
  const child = spawn(
    'bash',
    ['-c', script, 'mir-swap', installedPath, newAppPath, relaunch ? '1' : '0'],
    { detached: true, stdio: 'ignore' }
  )
  child.unref()
  child.on('error', () => {
    /* swallow — spawn failures are non-fatal for the quitting app */
  })
}

export function hasPendingUpdate(): boolean {
  return !!downloadedAppPath && fs.existsSync(downloadedAppPath)
}

// Spawn the detached swap script. The actual replacement happens after the
// app exits. Returns true if a swap was scheduled.
export function performPendingUpdate(relaunch = false): boolean {
  if (process.platform !== 'darwin') return false
  if (!downloadedAppPath || !fs.existsSync(downloadedAppPath)) return false
  const installedPath = findInstalledAppPath()
  if (!installedPath) return false
  spawnSwapScript(installedPath, downloadedAppPath, relaunch)
  downloadedAppPath = null
  downloadedVersion = null
  return true
}

// Manual "apply now" from the UI. Schedules the swap (with relaunch) and
// quits via app.quit() — NOT app.exit() — so window close events fire and
// App.vue's beforeunload state-flush (layout/tabs) runs before restart.
export function applyUpdate(): void {
  if (process.platform !== 'darwin') return
  if (!hasPendingUpdate()) return
  performPendingUpdate(true)
  app.quit()
}
