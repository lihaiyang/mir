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
}

interface GhAsset {
  name: string
  browser_download_url: string
  size: number
}

interface GhRelease {
  tag_name: string
  name: string | null
  body: string | null
  prerelease: boolean
  assets: GhAsset[]
  html_url: string
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

function fetchJson(url: string, redirects = 0): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects'))
      return
    }
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } },
      (res) => {
        const status = res.statusCode ?? 0
        if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
          const loc = res.headers.location
          res.resume()
          if (loc) {
            fetchJson(loc, redirects + 1).then(resolve, reject)
          } else {
            reject(new Error('redirect without location'))
          }
          return
        }
        if (status !== 200) {
          res.resume()
          reject(new Error(`HTTP ${status}`))
          return
        }
        let data = ''
        res.setEncoding('utf-8')
        res.on('data', (c: string) => {
          data += c
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
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

function pickAsset(assets: GhAsset[]): GhAsset | null {
  const dmgs = assets.filter((a) => a.name.toLowerCase().endsWith('.dmg'))
  if (dmgs.length === 0) return null
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const archMatch = dmgs.find((a) => a.name.toLowerCase().includes(arch))
  return archMatch ?? dmgs[0]
}

async function checkForUpdate(): Promise<void> {
  emit({ status: 'checking' })
  try {
    const release = (await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`)) as GhRelease
    const remoteVersion = release.tag_name.replace(/^v/, '')
    const localVersion = app.getVersion()

    if (!isNewer(remoteVersion, localVersion)) {
      emit({ status: 'not-available' })
      return
    }

    // Already downloaded this version — just re-open.
    if (downloadedVersion === remoteVersion && downloadedFilePath && fs.existsSync(downloadedFilePath)) {
      emit({ status: 'ready', version: remoteVersion })
      return
    }

    const asset = pickAsset(release.assets)
    if (!asset) {
      emit({ status: 'error', version: remoteVersion, message: 'No dmg asset found in release' })
      return
    }

    emit({ status: 'available', version: remoteVersion })

    const dest = path.join(os.tmpdir(), asset.name)
    emit({ status: 'downloading', version: remoteVersion, progress: 0 })
    await downloadFile(asset.browser_download_url, dest, (p) => {
      emit({ status: 'downloading', version: remoteVersion, progress: p })
    })

    downloadedFilePath = dest
    downloadedVersion = remoteVersion
    emit({ status: 'ready', version: remoteVersion })

    // Auto-open the dmg so the user can drag to Applications.
    const openErr = await shell.openPath(dest)
    if (openErr) {
      emit({ status: 'error', version: remoteVersion, message: openErr })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[updater] check failed:', message)
    emit({ status: 'error', message })
  }
}

export function initUpdater(getWin: () => BrowserWindow | null): void {
  getMainWindow = getWin
  if (process.platform !== 'darwin') return
  if (!app.isPackaged) return

  setTimeout(() => {
    checkForUpdate().catch(() => {})
  }, INITIAL_DELAY)
  setInterval(() => {
    checkForUpdate().catch(() => {})
  }, CHECK_INTERVAL)
}

export async function checkForUpdateNow(): Promise<void> {
  if (process.platform !== 'darwin') return
  await checkForUpdate()
}

export async function applyUpdate(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
    await shell.openPath(downloadedFilePath)
  }
}
