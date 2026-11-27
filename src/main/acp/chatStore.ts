/**
 * ACP 聊天消息持久化存储（主进程侧）。
 *
 * 将每个会话的 ChatItem[] 增量保存到 `<userData>/acp-chats/<sessionId>.json`，
 * 这样即便 Agent 不支持 `session/load`（或应用重启后尚未重连），也能查看历史消息与跨会话搜索。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AcpChatSearchResult, AcpPersistedChatItem } from '../../shared/acp'

interface PersistedChatFile {
  sessionId: string
  agentId: string
  agentName: string
  title?: string
  cwd?: string
  updatedAt: number
  items: AcpPersistedChatItem[]
}

const SAFE_ID_RE = /^[a-zA-Z0-9._-]+$/

function getChatsDir(): string {
  const dir = join(app.getPath('userData'), 'acp-chats')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function chatFilePath(sessionId: string): string | null {
  if (!sessionId || !SAFE_ID_RE.test(sessionId)) return null
  return join(getChatsDir(), `${sessionId}.json`)
}

export function saveChatItems(payload: {
  sessionId: string
  agentId: string
  agentName: string
  title?: string
  cwd?: string
  items: AcpPersistedChatItem[]
}): void {
  const filePath = chatFilePath(payload.sessionId)
  if (!filePath) return
  // 去掉正在流式中的标记，落盘为稳定态
  const items = payload.items.map((item) =>
    item.streaming ? { ...item, streaming: false } : item
  )
  const record: PersistedChatFile = {
    sessionId: payload.sessionId,
    agentId: payload.agentId,
    agentName: payload.agentName,
    title: payload.title,
    cwd: payload.cwd,
    updatedAt: Date.now(),
    items
  }
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(record), 'utf-8')
  renameSync(tmpPath, filePath)
}

export function loadChatItems(sessionId: string): PersistedChatFile | null {
  const filePath = chatFilePath(sessionId)
  if (!filePath || !existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as PersistedChatFile
    if (!parsed || !Array.isArray(parsed.items)) return null
    return parsed
  } catch {
    return null
  }
}

export function deleteChatItems(sessionId: string): void {
  const filePath = chatFilePath(sessionId)
  if (!filePath || !existsSync(filePath)) return
  try {
    rmSync(filePath, { force: true })
  } catch {
    // ignore
  }
}

export function searchChatItems(query: string): AcpChatSearchResult[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const dir = getChatsDir()
  const results: AcpChatSearchResult[] = []

  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8')
      const data = JSON.parse(raw) as PersistedChatFile
      if (!data || !Array.isArray(data.items)) continue

      // 先查标题
      const titleMatch = data.title?.toLowerCase().includes(q)
      let snippet = ''
      for (const item of data.items) {
        if ((item.kind === 'user' || item.kind === 'agent') && item.text) {
          const idx = item.text.toLowerCase().indexOf(q)
          if (idx >= 0) {
            const start = Math.max(0, idx - 30)
            const end = Math.min(item.text.length, idx + q.length + 50)
            snippet = (start > 0 ? '…' : '') + item.text.slice(start, end).replace(/\s+/g, ' ') + (end < item.text.length ? '…' : '')
            break
          }
        }
      }

      if (titleMatch || snippet) {
        results.push({
          sessionId: data.sessionId,
          agentId: data.agentId,
          agentName: data.agentName,
          title: data.title,
          updatedAt: data.updatedAt,
          snippet: snippet || data.title || ''
        })
      }
    } catch {
      // skip corrupt files
    }
  }

  return results.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30)
}
