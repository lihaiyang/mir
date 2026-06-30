import * as fs from 'fs'
import * as path from 'path'
import Ignore from 'ignore'
import { BrowserWindow } from 'electron'

export interface SearchOptions {
  rootPath: string
  query: string
  isRegex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  extensions?: string[]
  excludeDirs?: string[]
  maxResults?: number
}

export interface SearchMatch {
  file: string
  line: number
  col: number
  text: string
}

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

interface ActiveSearch {
  abort: boolean
}

const activeSearches = new Map<string, ActiveSearch>()

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function cancelSearch(id: string): void {
  const s = activeSearches.get(id)
  if (s) s.abort = true
}

export function startSearch(id: string, opts: SearchOptions, win: BrowserWindow): void {
  const {
    rootPath,
    query,
    isRegex = false,
    caseSensitive = false,
    wholeWord = false,
    extensions = [],
    excludeDirs = ['node_modules', '.git', 'dist', 'out', '.cache'],
    maxResults = 500
  } = opts

  if (!query || win.isDestroyed()) return

  const search: ActiveSearch = { abort: false }
  activeSearches.set(id, search)

  let pattern: RegExp
  try {
    let q = isRegex ? query : escapeRegex(query)
    if (wholeWord) q = `\\b${q}\\b`
    pattern = new RegExp(q, caseSensitive ? 'g' : 'gi')
  } catch {
    win.webContents.send('search:error', { id, message: 'Invalid regex pattern' })
    activeSearches.delete(id)
    return
  }

  const ig = Ignore()
  const gitignorePath = path.join(rootPath, '.gitignore')
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, 'utf-8'))
  }
  excludeDirs.forEach(d => ig.add(d))

  let totalMatches = 0
  let filesProcessed = 0

  async function walk(dir: string): Promise<void> {
    if (search.abort || totalMatches >= maxResults) return
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (search.abort || totalMatches >= maxResults) return
      const fullPath = path.join(dir, entry.name)
      const rel = path.relative(rootPath, fullPath)
      if (ig.ignores(rel)) continue

      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile()) {
        if (extensions.length > 0) {
          const ext = path.extname(entry.name).toLowerCase()
          if (!extensions.includes(ext)) continue
        }
        try {
          const stat = await fs.promises.stat(fullPath)
          if (stat.size > MAX_FILE_SIZE) continue

          const content = await fs.promises.readFile(fullPath, 'utf-8')
          const lines = content.split('\n')
          const fileMatches: SearchMatch[] = []
          for (let i = 0; i < lines.length && totalMatches < maxResults; i++) {
            pattern.lastIndex = 0
            let m: RegExpExecArray | null
            while ((m = pattern.exec(lines[i])) !== null) {
              fileMatches.push({
                file: rel,
                line: i + 1,
                col: m.index + 1,
                text: lines[i]
              })
              totalMatches++
              if (!pattern.global) break
            }
          }
          if (fileMatches.length > 0 && !win.isDestroyed()) {
            win.webContents.send('search:results', { id, matches: fileMatches })
          }
          filesProcessed++
          if (filesProcessed % 20 === 0) {
            await new Promise(r => setImmediate(r))
          }
        } catch {
          // skip binary/unreadable files
        }
      }
    }
  }

  walk(rootPath).then(() => {
    if (!win.isDestroyed()) {
      win.webContents.send('search:complete', { id, filesProcessed, totalMatches })
    }
    activeSearches.delete(id)
  }).catch((err) => {
    if (!win.isDestroyed()) {
      win.webContents.send('search:error', { id, message: String(err) })
    }
    activeSearches.delete(id)
  })
}