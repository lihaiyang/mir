/**
 * MIR Harness 会话持久化。
 *
 * 每个 ACP 会话落盘成一个 JSON 文件：`~/.mir-harness/sessions/<sessionId>.json`，
 * agent 进程的 session/list、session/load、session/resume 都从这里读。
 *
 * 三条约定：
 * - 文件名里的 sessionId 只允许 [A-Za-z0-9._-]，避免 `/`、`\`、`..` 造成目录穿越；
 * - 写入先落临时文件再 rename，进程中途退出也不会留下半个 JSON；
 * - 读取对损坏 / 缺字段的文件一律返回 null，不让一个坏文件拖垮整个 session/list。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { HARNESS_DIR_NAME } from '../shared/harness'
import type {
  ChatMessage,
  ChatRole,
  ChatToolCall,
  HarnessMode,
  PersistedSession,
  PersistedSessionSummary,
  SessionConfigValues,
  ThoughtLevel
} from './types'

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const SESSION_FILE_SUFFIX = '.json'
/** 会话标题的最大字符数（list / 界面展示用） */
const MAX_TITLE_LENGTH = 80

/** 会话里可能有用户代码与提示词，目录 / 文件默认只给当前用户读写 */
const SESSIONS_DIR_MODE = 0o700
const SESSION_FILE_MODE = 0o600

const CHAT_ROLES: readonly ChatRole[] = ['system', 'user', 'assistant', 'tool']
const THOUGHT_LEVELS: readonly ThoughtLevel[] = ['off', 'low', 'medium', 'high']

/* --------------------------------- 路径 --------------------------------- */

/** 会话目录：~/.mir-harness/sessions */
export function sessionsDir(): string {
  return join(homedir(), HARNESS_DIR_NAME, 'sessions')
}

/** 新会话 id：随机 UUID，天然满足文件名白名单 */
export function newSessionId(): string {
  return randomUUID()
}

function isValidSessionId(sessionId: string): boolean {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false
  // `.` / `..` 虽然匹配白名单，但拼出来就是当前目录 / 上级目录的名字，直接拒绝
  return sessionId !== '.' && sessionId !== '..'
}

/** 会话文件路径；非法 sessionId 返回 null（读 / 删时按「不存在」处理） */
function sessionFilePath(sessionId: string): string | null {
  if (!isValidSessionId(sessionId)) return null
  return join(sessionsDir(), `${sessionId}${SESSION_FILE_SUFFIX}`)
}

/* -------------------------------- 归一化 -------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isChatRole(value: unknown): value is ChatRole {
  return typeof value === 'string' && (CHAT_ROLES as readonly string[]).includes(value)
}

function isThoughtLevel(value: unknown): value is ThoughtLevel {
  return typeof value === 'string' && (THOUGHT_LEVELS as readonly string[]).includes(value)
}

function normalizeToolCalls(raw: unknown): ChatToolCall[] {
  if (!Array.isArray(raw)) return []
  const calls: ChatToolCall[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    if (typeof item.id !== 'string' || typeof item.name !== 'string') continue
    if (typeof item.arguments !== 'string') continue
    calls.push({ id: item.id, name: item.name, arguments: item.arguments })
  }
  return calls
}

/** 单条消息：字段不对就丢弃（历史回放时少一条也比炸掉整份会话好） */
function normalizeMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null
  if (!isChatRole(raw.role)) return null
  if (typeof raw.content !== 'string') return null

  const message: ChatMessage = { role: raw.role, content: raw.content }
  const toolCalls = normalizeToolCalls(raw.toolCalls)
  if (toolCalls.length > 0) message.toolCalls = toolCalls
  if (typeof raw.toolCallId === 'string') message.toolCallId = raw.toolCallId
  if (typeof raw.toolName === 'string') message.toolName = raw.toolName
  if (typeof raw.reasoning === 'string') message.reasoning = raw.reasoning
  return message
}

/**
 * 会话配置：model 缺失视为文件不可用；thoughtLevel / mode 非法时回落到安全默认值，
 * 这样以后给枚举加值时，旧文件仍然能 load。
 */
function normalizeConfig(raw: unknown): SessionConfigValues | null {
  if (!isRecord(raw)) return null
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (!model) return null
  const thoughtLevel: ThoughtLevel = isThoughtLevel(raw.thoughtLevel) ? raw.thoughtLevel : 'off'
  const mode: HarnessMode = raw.mode === 'code' ? 'code' : 'ask'
  return { model, thoughtLevel, mode }
}

/** 顶层字段（sessionId / cwd / 时间戳 / messages / config）不全就直接判为损坏 */
function normalizeSession(raw: unknown): PersistedSession | null {
  if (!isRecord(raw)) return null
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : ''
  if (!isValidSessionId(sessionId) || !cwd) return null
  if (!isFiniteNumber(raw.createdAt) || !isFiniteNumber(raw.updatedAt)) return null
  if (!Array.isArray(raw.messages)) return null
  const config = normalizeConfig(raw.config)
  if (!config) return null

  const messages: ChatMessage[] = []
  for (const item of raw.messages) {
    const message = normalizeMessage(item)
    if (message) messages.push(message)
  }

  const session: PersistedSession = {
    sessionId,
    cwd,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    messages,
    config
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (title) session.title = title
  return session
}

/** 比较 cwd 之前先转绝对路径；Windows 盘符大小写不敏感 */
function normalizeCwd(cwd: string): string {
  const absolute = resolve(cwd)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/* -------------------------------- 读写接口 ------------------------------- */

/**
 * 列出会话（按 updatedAt 倒序）。
 * 目录不存在返回 []；损坏 / 缺字段的文件直接跳过；传 cwd 时只看该目录下的会话。
 */
export function listPersistedSessions(cwd?: string): PersistedSessionSummary[] {
  let names: string[]
  try {
    names = readdirSync(sessionsDir())
  } catch {
    // 还没有任何会话（目录不存在）或目录不可读：都当作空列表
    return []
  }

  const wanted = cwd ? normalizeCwd(cwd) : undefined
  const summaries: PersistedSessionSummary[] = []
  for (const name of names) {
    if (!name.endsWith(SESSION_FILE_SUFFIX)) continue
    const sessionId = name.slice(0, -SESSION_FILE_SUFFIX.length)
    if (!isValidSessionId(sessionId)) continue

    const session = readPersistedSession(sessionId)
    if (!session) continue
    if (wanted !== undefined && normalizeCwd(session.cwd) !== wanted) continue

    const summary: PersistedSessionSummary = {
      sessionId: session.sessionId,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length
    }
    if (session.title) summary.title = session.title
    summaries.push(summary)
  }

  summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  return summaries
}

/**
 * 读取一份会话。文件不存在、JSON 损坏、字段缺失、sessionId 非法都返回 null，
 * 任何情况下都不抛异常（session/load 时把它当成「会话已丢失」即可）。
 */
export function readPersistedSession(sessionId: string): PersistedSession | null {
  const file = sessionFilePath(sessionId)
  if (!file) return null

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }

  return normalizeSession(parsed)
}

/**
 * 写入一份会话：先写同目录下的临时文件，再 rename 覆盖目标文件。
 * rename 在同一文件系统上是原子的，因此 list / load 永远读不到写了一半的 JSON。
 */
export function writePersistedSession(session: PersistedSession): void {
  const file = sessionFilePath(session.sessionId)
  if (!file) throw new Error(`非法的会话 id：${session.sessionId}`)

  const payload = `${JSON.stringify(session, null, 2)}\n`
  const dir = sessionsDir()
  mkdirSync(dir, { recursive: true, mode: SESSIONS_DIR_MODE })

  const temp = join(dir, `${session.sessionId}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, payload, { encoding: 'utf8', mode: SESSION_FILE_MODE })
    renameSync(temp, file)
  } catch (error) {
    // 写失败时清掉临时文件，避免 sessions 目录里堆垃圾
    try {
      rmSync(temp, { force: true })
    } catch {
      // 清理失败不影响把原始错误抛给调用方
    }
    throw error
  }
}

/** 删除一份会话；文件不存在视为已删除，sessionId 非法抛错 */
export function deletePersistedSession(sessionId: string): void {
  const file = sessionFilePath(sessionId)
  if (!file) throw new Error(`非法的会话 id：${sessionId}`)
  rmSync(file, { force: true })
}

/* -------------------------------- 标题推导 ------------------------------- */

/**
 * 从历史里推导会话标题：取第一条 user 消息的第一行非空内容，去掉首尾空白，
 * 超过 MAX_TITLE_LENGTH 个字符按码点截断。没有 user 消息时返回 undefined。
 */
export function deriveTitle(messages: ChatMessage[]): string | undefined {
  const firstUser = messages.find((message) => message.role === 'user')
  if (!firstUser) return undefined

  const line = firstUser.content
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (!line) return undefined

  // 按码点截断，避免把 emoji / 代理对截成半个字符
  const chars = Array.from(line)
  const title = chars.length > MAX_TITLE_LENGTH ? chars.slice(0, MAX_TITLE_LENGTH).join('').trimEnd() : line
  return title || undefined
}
