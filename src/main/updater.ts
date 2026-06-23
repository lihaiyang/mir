import { app, shell, BrowserWindow } from 'electron'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const REPO = 'lihaiyang/mir'
const CHECK_INTERVAL = 60 * 60 * 1000
const INITIAL_DELAY = 10 * 1000
const UA = 'mir-updater'

type UpdaterStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'ready' | 'error'

export interface UpdaterEvent {
  status: UpdaterStatus
  version?: string
  progress?: number
  message?: string
  manual?: boolean
}

let getMainWindow: () => BrowserWindow | null = () => null
let downloadedFilePath: string | null = null
let downloadedVersion: string | null = null

function emit(event: UpdaterEvent): void {
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
  return new Promise((resolve, reject) => {
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
  })
}

function downloadFile(
  url: string,
  dest: string,
  onProgress: (p: number) => void,
  redirects = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects'))
      return
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
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total) onProgress(Math.min(100, Math.round((received / total) * 100)))
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
  })
}

async function checkForUpdate(manual: boolean): Promise<void> {
  emit({ status: 'checking', manual })
  try {
    const remoteVersion = await fetchLatestVersion()
    const localVersion = app.getVersion()

    if (!isNewer(remoteVersion, localVersion)) {
      emit({ status: 'not-available', manual })
      return
    }

    // Already downloaded this version — just re-open.
    if (downloadedVersion === remoteVersion && downloadedFilePath && fs.existsSync(downloadedFilePath)) {
      emit({ status: 'ready', version: remoteVersion, manual })
      return
    }

    // Construct the dmg download URL from the known electron-builder naming pattern.
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const assetName = `MIR-${remoteVersion}-${arch}.dmg`
    const assetUrl = `https://github.com/${REPO}/releases/download/v${remoteVersion}/${assetName}`

    emit({ status: 'available', version: remoteVersion, manual })

    const dest = path.join(os.tmpdir(), assetName)
    emit({ status: 'downloading', version: remoteVersion, progress: 0, manual })
    await downloadFile(assetUrl, dest, (p) => {
      emit({ status: 'downloading', version: remoteVersion, progress: p, manual })
    })

    downloadedFilePath = dest
    downloadedVersion = remoteVersion
    emit({ status: 'ready', version: remoteVersion, manual })

    // Auto-open the dmg so the user can drag to Applications.
    const openErr = await shell.openPath(dest)
    if (openErr) {
      emit({ status: 'error', version: remoteVersion, message: openErr, manual })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[updater] check failed:', message)
    emit({ status: 'error', message, manual })
  }
}

export function initUpdater(getWin: () => BrowserWindow | null): void {
  getMainWindow = getWin
  if (process.platform !== 'darwin') return
  if (!app.isPackaged) return

  setTimeout(() => {
    checkForUpdate(false).catch(() => {})
  }, INITIAL_DELAY)
  setInterval(() => {
    checkForUpdate(false).catch(() => {})
  }, CHECK_INTERVAL)
}

export async function checkForUpdateNow(manual = false): Promise<void> {
  if (process.platform !== 'darwin') return
  await checkForUpdate(manual)
}

export async function applyUpdate(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
    await shell.openPath(downloadedFilePath)
  }
}
