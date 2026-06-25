import { app, shell, BrowserWindow } from 'electron'
import * as https from 'https'
import * as http from 'http'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as zlib from 'zlib'
import { execFile, spawn } from 'child_process'
import Store from 'electron-store'

const REPO = 'lihaiyang/mir'
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`
const CHECK_INTERVAL = 60 * 60 * 1000
const INITIAL_DELAY = 10 * 1000
const UA = 'mir-updater'

const mainStore = new Store({ name: 'mir-state' })

// --- Blockmap types ---

interface BlockmapFile {
  name: string
  offset: number
  checksums: string[]
  sizes: number[]
}

interface Blockmap {
  version: string
  files: BlockmapFile[]
}

// A contiguous run of blocks that need to be downloaded (checksums differ).
interface RangeRequest {
  startBlock: number
  endBlock: number // inclusive
  startOffset: number
  endOffset: number // exclusive
}

// For each new block: either copy from old zip (at a specific offset) or download.
type BlockPlanEntry =
  | { type: 'copy'; oldOffset: number; oldSize: number }
  | { type: 'download' }

// Centralized logging — writes to a file in the cache dir so we can
// debug update issues even when console output is invisible in packaged apps.
let _cacheDir: string | null = null
function getCacheDir(): string {
  if (!_cacheDir) _cacheDir = path.join(app.getPath('userData'), 'update-cache')
  return _cacheDir
}

let _logPath: string | null = null
function logToFile(msg: string): void {
  try {
    if (!_logPath) _logPath = path.join(getCacheDir(), 'updater.log')
    fs.mkdirSync(getCacheDir(), { recursive: true })
    const ts = new Date().toISOString()
    fs.appendFileSync(_logPath, `[${ts}] ${msg}\n`)
  } catch {
    /* ignore */
  }
}

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

// Parse semver from either app version (0.2.0-dev.0) or tag (dev-0.2.0).
// Strips 'dev-' prefix, 'v' prefix, and prerelease suffix for comparison.
function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  const cleaned = v.replace(/^dev-/, '').replace(/^v/, '')
  const m = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/)
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

// Channel: 'dev' if version has a prerelease tag (e.g. 0.2.0-dev.0),
// otherwise 'stable'. Dev and stable are isolated update channels —
// a dev build never updates to a stable release and vice versa.
function getChannel(version: string): 'dev' | 'stable' {
  const parsed = parseSemver(version)
  if (!parsed) return 'stable'
  // semver prerelease: 0.2.0-dev.0 has a '-dev.0' suffix
  return version.replace(/^v/, '').includes('-') ? 'dev' : 'stable'
}

// For stable channel: fetch the Atom feed and find the latest entry with
// a 'v' tag prefix (v0.2.0). For dev channel: find the latest 'dev-' tag.
// Both channels use the same releases.atom feed — GitHub serves it from
// github.com (not the API), so it has no rate limit. We filter by tag
// prefix to isolate channels.
function fetchLatestVersion(): Promise<string> {
  const localChannel = getChannel(app.getVersion())
  return fetchLatestFromAtom(localChannel)
}

// Fetch the Atom feed and find the latest release for the given channel.
// Stable: first entry with tag 'vX.Y.Z'. Dev: first entry with 'dev-X.Y.Z'.
function fetchLatestFromAtom(channel: 'dev' | 'stable'): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const req = https.get(
    `https://github.com/${REPO}/releases.atom`,
    { headers: { 'User-Agent': UA } },
    (res) => {
      const status = res.statusCode ?? 0
      if (status !== 200) {
        res.resume()
        reject(new Error(`atom feed HTTP ${status}`))
        return
      }
      let xml = ''
      res.setEncoding('utf-8')
      res.on('data', (c: string) => { xml += c })
      res.on('end', () => {
        const entries = xml.split(/<entry>/).slice(1)
        for (const entry of entries) {
          // <id>tag:github.com,2008:Repository/.../v0.2.0</id>
          // or <id>tag:github.com,2008:Repository/.../dev-0.2.0</id>
          const idMatch = entry.match(/<id>[^<]*\/(v?\d+\.\d+\.\d+|dev-\d+\.\d+\.\d+)<\/id>/)
          const linkMatch = entry.match(/<link[^>]*href="[^"]*\/releases\/tag\/(v?\d+\.\d+\.\d+|dev-\d+\.\d+\.\d+)"/)
          const tag = idMatch?.[1] || linkMatch?.[1]
          if (!tag) continue

          if (channel === 'dev' && tag.startsWith('dev-')) {
            // Convert tag dev-0.2.1 → app version 0.2.1-dev.0
            const ver = tag.replace(/^dev-/, '')
            resolve(ver + '-dev.0')
            return
          }
          if (channel === 'stable' && (tag.startsWith('v') || /^\d+\.\d+\.\d+$/.test(tag))) {
            // Convert tag v0.2.0 → app version 0.2.0
            resolve(tag.replace(/^v/, ''))
            return
          }
        }
        reject(new Error(`no ${channel} release found in atom feed`))
      })
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

// --- Blockmap delta update ---

// Download and parse a blockmap file. The file itself is gzip-compressed
// (electron-builder writes it that way), but GitHub serves it as
// application/octet-stream WITHOUT content-encoding: gzip — so we must
// detect gzip by magic bytes, not by the HTTP header.
function downloadBlockmap(url: string): Promise<Blockmap> {
  const { promise, resolve, reject } = Promise.withResolvers<Blockmap>()
  function doRequest(u: string, redirects: number) {
    if (redirects > 5) {
      reject(new Error('too many redirects'))
      return
    }
    const req = https.get(u, { headers: { 'User-Agent': UA } }, (res) => {
      const status = res.statusCode ?? 0
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        res.resume()
        const loc = res.headers.location
        if (loc) doRequest(loc, redirects + 1)
        else reject(new Error('redirect without location'))
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`blockmap HTTP ${status}`))
        return
      }
      const rawChunks: Buffer[] = []
      res.on('data', (c: Buffer) => rawChunks.push(c))
      res.on('end', () => {
        try {
          const raw = Buffer.concat(rawChunks)
          // Detect gzip by magic bytes (1f 8b) — the HTTP content-encoding
          // header is NOT set by GitHub even though the file is gzip-compressed.
          const isGz = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b
          const json = isGz ? zlib.gunzipSync(raw).toString('utf-8') : raw.toString('utf-8')
          resolve(JSON.parse(json) as Blockmap)
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('blockmap request timeout')))
  }
  doRequest(url, 0)
  return promise
}

// Cache paths for old zip + blockmap (used for delta downloads).
function cacheZipPath(version: string): string {
  return path.join(getCacheDir(), `MIR-${version}.zip`)
}
function cacheBlockmapPath(version: string): string {
  return path.join(getCacheDir(), `MIR-${version}.zip.blockmap`)
}

// Total size of all blocks in a blockmap (== zip file size).
function newF_totalSize(bm: Blockmap): number {
  const f = bm.files[0]
  if (!f) return 0
  return f.sizes.reduce((sum, s) => sum + s, 0)
}

// Remove cached zip/blockmap for versions other than the two specified.
function cleanOldCache(keep1: string, keep2: string): void {
  try {
    const entries = fs.readdirSync(getCacheDir())
    for (const entry of entries) {
      const match = entry.match(/^MIR-(.+)\.(zip|zip\.blockmap)$/)
      if (match && match[1] !== keep1 && match[1] !== keep2) {
        fs.unlinkSync(path.join(getCacheDir(), entry))
      }
    }
  } catch {
    /* ignore */
  }
}

// Save zip + blockmap to cache for future delta updates.
async function saveToCache(zipPath: string, blockmap: Blockmap, version: string): Promise<void> {
  await fsp.mkdir(getCacheDir(), { recursive: true })
  await fsp.copyFile(zipPath, cacheZipPath(version))
  const bmGz = zlib.gzipSync(Buffer.from(JSON.stringify(blockmap), 'utf-8'))
  await fsp.writeFile(cacheBlockmapPath(version), bmGz)
}

// Load cached blockmap for a version (gunzip + parse).
async function loadCachedBlockmap(version: string): Promise<Blockmap | null> {
  const p = cacheBlockmapPath(version)
  try {
    const gz = await fsp.readFile(p)
    const json = zlib.gunzipSync(gz).toString('utf-8')
    return JSON.parse(json) as Blockmap
  } catch {
    return null
  }
}

// Check if cached old zip exists.
function hasCachedZip(version: string): boolean {
  return fs.existsSync(cacheZipPath(version))
}

// Compute block offsets from sizes (cumulative sum).
function computeOffsets(sizes: number[]): number[] {
  const offsets: number[] = []
  let acc = 0
  for (const s of sizes) {
    offsets.push(acc)
    acc += s
  }
  return offsets
}

// Compare old and new blockmaps using content-addressable matching.
// Instead of comparing block[i] vs block[i] (which fails when ZIP content
// shifts due to a changed file earlier in the archive), we build a map of
// old checksums and match each new block by its checksum regardless of
// position. This recognizes unchanged blocks even after offset shifts.
function computeDelta(
  oldBm: Blockmap,
  newBm: Blockmap
): { ranges: RangeRequest[]; totalDownload: number; blockPlan: BlockPlanEntry[] } {
  const oldF = oldBm.files[0]
  const newF = newBm.files[0]
  if (!oldF || !newF) {
    return { ranges: [], totalDownload: -1, blockPlan: [] }
  }

  const oldOffsets = computeOffsets(oldF.sizes)
  const newOffsets = computeOffsets(newF.sizes)

  // Build checksum → old block info map. If duplicate checksums exist
  // (unlikely but possible), first match wins.
  const oldChecksumMap = new Map<string, { offset: number; size: number }>()
  for (let i = 0; i < oldF.checksums.length; i++) {
    if (!oldChecksumMap.has(oldF.checksums[i])) {
      oldChecksumMap.set(oldF.checksums[i], { offset: oldOffsets[i], size: oldF.sizes[i] })
    }
  }

  const blockPlan: BlockPlanEntry[] = []
  const ranges: RangeRequest[] = []
  let totalDownload = 0
  let currentRange: RangeRequest | null = null

  for (let i = 0; i < newF.checksums.length; i++) {
    const checksum = newF.checksums[i]
    const oldMatch = oldChecksumMap.get(checksum)

    if (oldMatch) {
      // Block content unchanged (same checksum) — copy from old zip at old offset
      if (currentRange) {
        ranges.push(currentRange)
        currentRange = null
      }
      blockPlan.push({ type: 'copy', oldOffset: oldMatch.offset, oldSize: oldMatch.size })
    } else {
      // Block is new/changed — needs downloading
      const start = newOffsets[i]
      const end = start + newF.sizes[i]
      if (currentRange && currentRange.endBlock === i - 1) {
        currentRange.endBlock = i
        currentRange.endOffset = end
      } else {
        if (currentRange) ranges.push(currentRange)
        currentRange = { startBlock: i, endBlock: i, startOffset: start, endOffset: end }
      }
      totalDownload += newF.sizes[i]
      blockPlan.push({ type: 'download' })
    }
  }
  if (currentRange) ranges.push(currentRange)

  // Merge ranges that are close together. If the gap (copy blocks) between
  // two download ranges is small, it's cheaper to download the gap too
  // (one HTTP request) than to issue a separate request for the next range
  // (each request pays TLS + redirect latency). Threshold: 512KB — if the
  // gap is smaller than this, merge it into a single range.
  const MERGE_THRESHOLD = 512 * 1024
  if (ranges.length > 1) {
    // Walk ranges and merge adjacent ones with small gaps
    const mergedRanges: RangeRequest[] = [ranges[0]]
    for (let ri = 1; ri < ranges.length; ri++) {
      const prev = mergedRanges[mergedRanges.length - 1]
      const cur = ranges[ri]
      const gap = cur.startOffset - prev.endOffset
      if (gap <= MERGE_THRESHOLD) {
        // Merge cur into prev: extend prev to cover the gap + cur
        prev.endBlock = cur.endBlock
        prev.endOffset = cur.endOffset
        totalDownload += gap
      } else {
        mergedRanges.push(cur)
      }
    }

    // Rebuild blockPlan: any copy block that falls within a merged range
    // (i.e. between the original start and end of a merged range) becomes
    // a download block, since it's now part of a downloaded region.
    const newBlockPlan: BlockPlanEntry[] = []
    for (let i = 0; i < blockPlan.length; i++) {
      let inRange = false
      for (const r of mergedRanges) {
        if (i >= r.startBlock && i <= r.endBlock) {
          inRange = true
          break
        }
      }
      newBlockPlan.push(inRange ? { type: 'download' } : blockPlan[i])
    }

    return { ranges: mergedRanges, totalDownload, blockPlan: newBlockPlan }
  }

  return { ranges, totalDownload, blockPlan }
}

// Keep-alive agent so multiple range requests reuse the same TCP+TLS
// connection instead of re-handshaking for each request.
const rangeAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  maxFreeSockets: 8
})

// Resolve a github.com release URL to its final redirect target, so
// subsequent range requests can hit the CDN directly without re-paying
// redirect latency.
let resolvedDownloadUrl: string | null = null
function resolveDownloadUrl(url: string): Promise<string> {
  if (resolvedDownloadUrl) return Promise.resolve(resolvedDownloadUrl)
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
    const status = res.statusCode ?? 0
    const loc = res.headers.location
    res.resume()
    if ((status === 301 || status === 302) && loc) {
      resolvedDownloadUrl = loc
      resolve(loc)
    } else if (status === 200) {
      resolvedDownloadUrl = url
      resolve(url)
    } else {
      reject(new Error(`resolve URL HTTP ${status}`))
    }
  })
  req.on('error', reject)
  req.setTimeout(15000, () => req.destroy(new Error('resolve timeout')))
  return promise
}

// Download a specific byte range from a URL. Uses the keep-alive agent
// and hits the resolved CDN URL directly (no redirect per request).
function downloadRange(url: string, start: number, end: number): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  const opts: https.RequestOptions = {
    headers: { 'User-Agent': UA, Range: `bytes=${start}-${end - 1}` },
    agent: rangeAgent
  }
  const req = https.get(url, opts, (res) => {
    const status = res.statusCode ?? 0
    if (status !== 206 && status !== 200) {
      res.resume()
      reject(new Error(`range request HTTP ${status}`))
      return
    }
    const chunks: Buffer[] = []
    res.on('data', (c: Buffer) => chunks.push(c))
    res.on('end', () => resolve(Buffer.concat(chunks)))
  })
  req.on('error', reject)
  req.setTimeout(60000, () => req.destroy(new Error('range request timeout')))
  return promise
}

// Assemble the new zip using delta: copy unchanged blocks from old zip
// (at their old offsets, which may differ from new offsets due to shifts),
// insert downloaded changed blocks.
//
// Optimization: consecutive 'copy' blocks are merged into a single large
// read+write instead of one I/O call per block. With 5700+ blocks this
// reduces I/O calls from ~11000 to a few hundred, cutting assembly time
// from ~90s to ~2s.
async function assembleDeltaZip(
  oldZipPath: string,
  oldBm: Blockmap,
  newBm: Blockmap,
  ranges: RangeRequest[],
  blockPlan: BlockPlanEntry[],
  destPath: string,
  assetUrl: string,
  onProgress: (p: number) => void
): Promise<void> {
  const newF = newBm.files[0]
  const newOffsets = computeOffsets(newF.sizes)

  // Resolve the CDN URL once (avoids per-request redirect latency)
  const cdnUrl = await resolveDownloadUrl(assetUrl)

  // Download all changed ranges in parallel using keep-alive connection
  const rangeBuffers = new Map<number, Buffer>() // keyed by startBlock
  const totalDownload = ranges.reduce((sum, r) => sum + (r.endOffset - r.startOffset), 0)

  logToFile(`downloading ${ranges.length} ranges in parallel, total=${totalDownload} bytes (${Math.round(totalDownload / 1024 / 1024)}MB)`)
  const dlStart = Date.now()

  const downloadPromises = ranges.map(async (range) => {
    const buf = await downloadRange(cdnUrl, range.startOffset, range.endOffset)
    rangeBuffers.set(range.startBlock, buf)
    return buf.length
  })
  // Track progress as downloads complete
  let completedDownloads = 0
  const progressTracker = ranges.map(async (range, idx) => {
    const buf = await downloadPromises[idx]
    completedDownloads++
    if (totalDownload > 0) {
      onProgress(Math.min(99, Math.round((completedDownloads / ranges.length) * 100)))
    }
    return buf
  })
  await Promise.all(progressTracker)

  const dlMs = Date.now() - dlStart
  logToFile(`download complete in ${dlMs}ms (${Math.round(totalDownload / 1024 / (dlMs / 1000))} KB/s)`)

  // Build a run-length plan: merge consecutive blocks of the same type
  // into a single operation. Consecutive 'copy' blocks become one big
  // read from old zip + write to new zip. Consecutive 'download' blocks
  // (already merged into ranges) become one write.
  interface RunCopy { type: 'copy'; oldOffset: number; newOffset: number; length: number }
  interface RunDownload { type: 'download'; newOffset: number; length: number; range: RangeRequest }
  type Run = RunCopy | RunDownload

  const runs: Run[] = []
  for (let i = 0; i < blockPlan.length; i++) {
    const plan = blockPlan[i]
    const newSize = newF.sizes[i]
    const newOffset = newOffsets[i]

    if (plan.type === 'copy') {
      const last = runs[runs.length - 1]
      // Merge if the previous run is also a copy AND offsets are contiguous
      // (old offset follows previous old offset, new offset follows previous new offset)
      if (last && last.type === 'copy' &&
          last.oldOffset + last.length === plan.oldOffset &&
          last.newOffset + last.length === newOffset) {
        last.length += newSize
      } else {
        runs.push({ type: 'copy', oldOffset: plan.oldOffset, newOffset, length: newSize })
      }
    } else {
      const range = ranges.find(r => i >= r.startBlock && i <= r.endBlock)!
      const last = runs[runs.length - 1]
      // Merge consecutive download blocks within the same range
      if (last && last.type === 'download' && last.range === range &&
          last.newOffset + last.length === newOffset) {
        last.length += newSize
      } else {
        runs.push({ type: 'download', newOffset, length: newSize, range })
      }
    }
  }

  logToFile(`assembly runs: ${runs.length} (from ${blockPlan.length} blocks), copy runs: ${runs.filter(r => r.type === 'copy').length}`)

  const copyStart = Date.now()
  // Execute runs. Copy runs use streaming (createReadStream→pipe→writeStream)
  // for better throughput on large contiguous regions. Download runs write
  // from the in-memory range buffers.
  const newFd = await fsp.open(destPath, 'w')
  try {
    // First pass: write all download runs from buffers
    for (const run of runs) {
      if (run.type === 'download') {
        const rangeBuf = rangeBuffers.get(run.range.startBlock)!
        const offsetWithinRange = run.newOffset - run.range.startOffset
        const slice = rangeBuf.subarray(offsetWithinRange, offsetWithinRange + run.length)
        await newFd.write(slice, 0, run.length, run.newOffset)
      }
    }
    await newFd.close()

    // Second pass: stream-copy all copy runs from old zip to new zip
    // using pipe for efficient sequential I/O.
    for (const run of runs) {
      if (run.type !== 'copy') continue
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(oldZipPath, { start: run.oldOffset, end: run.oldOffset + run.length - 1 })
        const ws = fs.createWriteStream(destPath, { start: run.newOffset, flags: 'r+' })
        rs.on('error', reject)
        ws.on('error', reject)
        ws.on('finish', () => resolve())
        rs.pipe(ws)
      })
    }
    onProgress(100)
    logToFile(`assembly (stream copy) complete in ${Date.now() - copyStart}ms`)
  } finally {
    // newFd already closed above; ensure cleanup on error
    try { await newFd.close() } catch { /* already closed */ }
  }
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

    // Channel isolation: dev builds only update to newer dev builds,
    // stable builds only update to newer stable builds.
    if (getChannel(remoteVersion) !== getChannel(localVersion)) {
      emit({ status: 'not-available', manual: activeManual })
      return
    }

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
    // Tag naming: stable = v0.2.0, dev = dev-0.2.0 (tag uses dev- prefix
    // without the prerelease suffix, e.g. dev-0.2.0 for version 0.2.0-dev.0)
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const isDev = getChannel(remoteVersion) === 'dev'
    const productPrefix = isDev ? 'MIR-Dev' : 'MIR'
    const assetName = `${productPrefix}-${remoteVersion}-${arch}-mac.zip`
    const tag = isDev
      ? `dev-${parseSemver(remoteVersion)!.major}.${parseSemver(remoteVersion)!.minor}.${parseSemver(remoteVersion)!.patch}`
      : `v${remoteVersion}`
    const assetUrl = `https://github.com/${REPO}/releases/download/${tag}/${assetName}`
    const blockmapUrl = `${assetUrl}.blockmap`

    emit({ status: 'available', version: remoteVersion, manual: activeManual })

    const tmpDir = path.join(os.tmpdir(), `mir-update-${remoteVersion}`)
    safeRemoveDir(tmpDir)
    await fsp.mkdir(tmpDir, { recursive: true })

    const zipPath = path.join(tmpDir, assetName)

    // Try delta download if we have a cached old zip + blockmap.
    let usedDelta = false
    logToFile(`checking cache for localVersion=${localVersion}: hasZip=${hasCachedZip(localVersion)}`)
    if (hasCachedZip(localVersion)) {
      try {
        const oldBm = await loadCachedBlockmap(localVersion)
        logToFile(`cached blockmap loaded: ${oldBm ? 'OK' : 'null'}`)
        if (oldBm) {
          emit({ status: 'downloading', version: remoteVersion, progress: 0, manual: activeManual })
          logToFile(`downloading new blockmap from ${blockmapUrl}`)
          const newBm = await downloadBlockmap(blockmapUrl)
          logToFile(`new blockmap downloaded OK, checksums=${newBm.files[0]?.checksums.length}`)
          const { ranges, totalDownload, blockPlan } = computeDelta(oldBm, newBm)
          const newZipSize = newF_totalSize(newBm)
          logToFile(`delta computed: ranges=${ranges.length}, totalDownload=${totalDownload} bytes (${Math.round(totalDownload / 1024 / 1024)}MB), newZipSize=${newZipSize} bytes, threshold=${Math.round(newZipSize * 0.8)}`)

          if (totalDownload >= 0 && totalDownload < newZipSize * 0.8) {
            // Delta is worthwhile (< 80% of full download)
            logToFile(`delta worthwhile, starting assembly...`)
            emit({
              status: 'downloading',
              version: remoteVersion,
              progress: 0,
              message: `增量更新 ${Math.round(totalDownload / 1024 / 1024)}MB / ${Math.round(newZipSize / 1024 / 1024)}MB`,
              manual: activeManual
            })
            await assembleDeltaZip(
              cacheZipPath(localVersion),
              oldBm,
              newBm,
              ranges,
              blockPlan,
              zipPath,
              assetUrl,
              (p) => {
                emit({ status: 'downloading', version: remoteVersion, progress: p, manual: activeManual })
              }
            )
            logToFile(`delta assembly complete, usedDelta=true`)
            usedDelta = true
            // Cache the new zip + blockmap for next delta
            await saveToCache(zipPath, newBm, remoteVersion)
            logToFile(`cached new zip + blockmap for ${remoteVersion}`)
          } else {
            logToFile(`delta skipped: totalDownload=${totalDownload} >= threshold, falling back to full`)
          }
        }
      } catch (deltaErr) {
        // Delta failed — fall back to full download
        const msg = deltaErr instanceof Error ? deltaErr.message : String(deltaErr)
        logToFile(`delta FAILED: ${msg}`)
      }
    }

    if (!usedDelta) {
      // Full download
      logToFile(`starting full download from ${assetUrl}`)
      emit({ status: 'downloading', version: remoteVersion, progress: 0, manual: activeManual })
      await downloadFile(assetUrl, zipPath, (p) => {
        emit({ status: 'downloading', version: remoteVersion, progress: p, manual: activeManual })
      })
      logToFile(`full download complete, zipPath=${zipPath}, exists=${fs.existsSync(zipPath)}, size=${fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0}`)
      // Cache for future delta
      try {
        logToFile(`downloading blockmap for cache...`)
        const bm = await downloadBlockmap(blockmapUrl)
        logToFile(`blockmap downloaded OK, saving to cache...`)
        await saveToCache(zipPath, bm, remoteVersion)
        logToFile(`cached zip + blockmap for ${remoteVersion}`)
      } catch (cacheErr) {
        logToFile(`cache save FAILED: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`)
      }
    }

    // Clean up old version cache (keep only current + new)
    cleanOldCache(localVersion, remoteVersion)

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
