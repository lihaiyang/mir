import * as fs from 'fs'
import * as path from 'path'
import Ignore from 'ignore'

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

export async function searchInProject(opts: SearchOptions): Promise<SearchMatch[]> {
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

  if (!query) return []

  let pattern: RegExp
  try {
    let q = isRegex ? query : escapeRegex(query)
    if (wholeWord) q = `\\b${q}\\b`
    pattern = new RegExp(q, caseSensitive ? 'g' : 'gi')
  } catch {
    return []
  }

  // Load gitignore if present
  const ig = Ignore()
  const gitignorePath = path.join(rootPath, '.gitignore')
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, 'utf-8'))
  }
  excludeDirs.forEach(d => ig.add(d))

  const results: SearchMatch[] = []

  let filesProcessed = 0
  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= maxResults) break
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
          const content = await fs.promises.readFile(fullPath, 'utf-8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            pattern.lastIndex = 0
            let m: RegExpExecArray | null
            while ((m = pattern.exec(lines[i])) !== null) {
              results.push({
                file: rel,
                line: i + 1,
                col: m.index + 1,
                text: lines[i]
              })
              if (!pattern.global) break
            }
          }
          filesProcessed++
          if (filesProcessed % 50 === 0) {
            await new Promise(r => setImmediate(r))
          }
        } catch {
          // skip binary/unreadable files
        }
      }
    }
  }

  await walk(rootPath)
  return results
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
