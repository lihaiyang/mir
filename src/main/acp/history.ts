/**
 * ACP 会话历史（只存摘要，不存消息体）。
 *
 * 存储在 electron-store 的 `acp-history` 键下，每个 Agent 最多保留 MAX_PER_AGENT 条。
 * 历史是本地权威：Agent 不支持 session/list 时也能恢复列表；支持时用 reconcile 补齐。
 */
import { getStore } from '../store'
import type { AcpHistoryEntry, AcpRemoteSession } from '../../shared/acp'

const STORE_KEY = 'acp-history'
const MAX_PER_AGENT = 50

let cache: AcpHistoryEntry[] | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeEntry(raw: unknown): AcpHistoryEntry | null {
  if (!isRecord(raw)) return null
  const agentId = typeof raw.agentId === 'string' ? raw.agentId : undefined
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined
  if (!agentId || !sessionId) return null

  const now = Date.now()
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now
  const lastActiveAt =
    typeof raw.lastActiveAt === 'number' && Number.isFinite(raw.lastActiveAt) ? raw.lastActiveAt : createdAt

  const entry: AcpHistoryEntry = {
    agentId,
    sessionId,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    createdAt,
    lastActiveAt
  }
  if (typeof raw.title === 'string' && raw.title) entry.title = raw.title
  if (typeof raw.firstPrompt === 'string' && raw.firstPrompt) entry.firstPrompt = raw.firstPrompt
  return entry
}

function load(): AcpHistoryEntry[] {
  if (cache) return cache
  const raw: unknown = getStore().get(STORE_KEY)
  cache = Array.isArray(raw)
    ? raw.map(normalizeEntry).filter((entry): entry is AcpHistoryEntry => entry !== null)
    : []
  return cache
}

function save(entries: AcpHistoryEntry[]): void {
  cache = entries
  getStore().set(STORE_KEY, entries)
}

/** 全部历史，按最近活跃降序 */
export function listHistory(): AcpHistoryEntry[] {
  return [...load()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

/** 每个 Agent 内按最近活跃降序裁剪 */
function trimPerAgent(entries: AcpHistoryEntry[]): AcpHistoryEntry[] {
  const counts = new Map<string, number>()
  const sorted = [...entries].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  const kept: AcpHistoryEntry[] = []
  for (const entry of sorted) {
    const count = counts.get(entry.agentId) ?? 0
    if (count >= MAX_PER_AGENT) continue
    counts.set(entry.agentId, count + 1)
    kept.push(entry)
  }
  return kept
}

/** 插入或更新一条历史 */
export function upsertHistory(entry: AcpHistoryEntry): AcpHistoryEntry {
  const entries = load().filter(
    (item) => !(item.agentId === entry.agentId && item.sessionId === entry.sessionId)
  )
  const next: AcpHistoryEntry = { ...entry }
  if (!next.cwd) {
    const previous = load().find(
      (item) => item.agentId === entry.agentId && item.sessionId === entry.sessionId
    )
    if (previous) next.cwd = previous.cwd
  }
  entries.push(next)
  save(trimPerAgent(entries))
  return next
}

/** 局部更新一条历史（不存在则忽略） */
export function patchHistory(
  agentId: string,
  sessionId: string,
  patch: Partial<AcpHistoryEntry>
): AcpHistoryEntry | undefined {
  const entries = load()
  const index = entries.findIndex((item) => item.agentId === agentId && item.sessionId === sessionId)
  if (index < 0) return undefined
  const current = entries[index]
  const next: AcpHistoryEntry = {
    ...current,
    ...patch,
    agentId: current.agentId,
    sessionId: current.sessionId
  }
  if (!next.cwd) next.cwd = current.cwd
  const updated = [...entries]
  updated[index] = next
  save(trimPerAgent(updated))
  return next
}

/** 删除一条历史 */
export function removeHistory(agentId: string, sessionId: string): void {
  const entries = load()
  const next = entries.filter((item) => !(item.agentId === agentId && item.sessionId === sessionId))
  if (next.length !== entries.length) save(trimPerAgent(next))
}

/**
 * 用 Agent 端的 session/list 结果补齐本地历史。
 * 只新增/刷新，不删除本地条目（本地可能有 Agent 已遗忘的旧会话）。
 */
export function reconcile(agentId: string, remote: AcpRemoteSession[]): AcpHistoryEntry[] {
  const entries = load()
  const byId = new Map(entries.map((entry) => [entry.sessionId, entry]))

  for (const session of remote) {
    const existing = byId.get(session.sessionId)
    const remoteUpdatedAt = session.updatedAt ?? Date.now()

    if (!existing) {
      const entry: AcpHistoryEntry = {
        agentId,
        sessionId: session.sessionId,
        cwd: session.cwd ?? '',
        createdAt: remoteUpdatedAt,
        lastActiveAt: remoteUpdatedAt
      }
      if (session.title) entry.title = session.title
      entries.push(entry)
      byId.set(entry.sessionId, entry)
      continue
    }

    existing.lastActiveAt = Math.max(existing.lastActiveAt, remoteUpdatedAt)
    if (session.cwd) existing.cwd = session.cwd
    if (session.title) existing.title = session.title
  }

  save(trimPerAgent(entries))
  return listHistory()
}

/** 清空某 Agent 的历史（断开 Agent 时不用，仅调试用） */
export function clearHistory(agentId?: string): void {
  const entries = agentId ? load().filter((item) => item.agentId !== agentId) : []
  save(entries)
}
