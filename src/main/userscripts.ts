/**
 * 用户脚本（油猴脚本）主进程实现。
 *
 * 职责：
 *  - 扫描 / 解析 userData/userscripts/*.user.js 的 ==UserScript== 元数据
 *  - 按 @match / @include / @exclude 判断某个 URL 该注入哪些脚本（供 webview preload 同步查询）
 *  - @require / @resource 下载与本地缓存
 *  - GM_setValue 等键值的落盘（按脚本 id 分文件）
 *  - GM_xmlhttpRequest 的跨域代理（走 persist:browser 会话，与内嵌浏览器共享 Cookie）
 *
 * 这里刻意全部使用同步 fs：forUrl 是 ipcRenderer.sendSync 调用，
 * 主进程必须在同一次事件循环里返回结果。脚本文件都是小文本，代价可以忽略。
 */

import { app, BrowserWindow, Notification, dialog, session, shell } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { getStore } from './store'
import {
  DEFAULT_RUN_AT,
  USERSCRIPT_RUN_AT_VALUES,
  type GmXhrRequest,
  type GmXhrResponse,
  type UserScriptDetail,
  type UserScriptInjection,
  type UserScriptMeta,
  type UserScriptResourceRef,
  type UserScriptRunAt,
  type UserScriptSummary,
  type UserScriptsForUrlPayload
} from '../shared/userscripts'

/* ------------------------------------------------------------------ paths */

export function userscriptsDir(): string {
  return path.join(app.getPath('userData'), 'userscripts')
}

function cacheDir(): string {
  return path.join(userscriptsDir(), 'cache')
}

function valuesDir(): string {
  return path.join(userscriptsDir(), 'values')
}

function ensureDirs(): void {
  for (const dir of [userscriptsDir(), cacheDir(), valuesDir()]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }
}

/* --------------------------------------------------------------- metadata */

const META_BLOCK_RE = /\/\/[ \t]*==UserScript==([\s\S]*?)\/\/[ \t]*==\/UserScript==/
const META_LINE_RE = /^[ \t]*\/\/[ \t]*@([A-Za-z][\w:-]*)(?:[ \t]+(.*))?$/

/** 把 @run-at 的各种写法归一到三档 */
function normalizeRunAt(raw: string | undefined): UserScriptRunAt {
  const v = (raw ?? '').trim().toLowerCase()
  if (!v) return DEFAULT_RUN_AT
  if (v === 'document-start' || v === 'document-body') return 'document-start'
  if (v === 'document-end') return 'document-end'
  if (v === 'document-idle') return 'document-idle'
  // document-menu / context-menu 之类的交互型时机在 MIR 里按 idle 处理
  return USERSCRIPT_RUN_AT_VALUES.includes(v as UserScriptRunAt)
    ? (v as UserScriptRunAt)
    : DEFAULT_RUN_AT
}

export interface ParsedUserScript {
  meta: UserScriptMeta
  /** 剔除元数据块后的正文（保留换行数量，便于报错行号对齐） */
  body: string
  /** 原始元数据块文本，用于 GM_info.scriptMetaStr */
  metaStr: string
}

/**
 * 解析脚本原文。抛错表示这不是一个可安装的用户脚本。
 * 与油猴一致：必须至少有 @name，以及 @match / @include 之一。
 */
export function parseUserScript(source: string): ParsedUserScript {
  const text = source.replace(/^\uFEFF/, '')
  const block = META_BLOCK_RE.exec(text)
  if (!block) throw new Error('未找到 ==UserScript== 元数据块')

  const metaStr = block[0]
  const fields = new Map<string, string[]>()
  for (const line of block[1].split(/\r?\n/)) {
    const m = META_LINE_RE.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = (m[2] ?? '').trim()
    const list = fields.get(key)
    if (list) list.push(value)
    else fields.set(key, [value])
  }

  const first = (key: string): string => fields.get(key)?.[0] ?? ''
  const all = (key: string): string[] => (fields.get(key) ?? []).filter(v => v.length > 0)

  const name = first('name')
  if (!name) throw new Error('缺少 @name')

  const matches = all('match')
  const includes = all('include')
  if (matches.length === 0 && includes.length === 0) {
    throw new Error('缺少 @match 或 @include，脚本不会在任何页面生效')
  }

  const resources: UserScriptResourceRef[] = []
  for (const raw of all('resource')) {
    const sp = raw.indexOf(' ')
    if (sp <= 0) continue
    resources.push({ name: raw.slice(0, sp).trim(), url: raw.slice(sp + 1).trim() })
  }

  const known = new Set([
    'name', 'namespace', 'version', 'description', 'author', 'match', 'include',
    'exclude', 'run-at', 'grant', 'require', 'resource', 'noframes', 'icon',
    'homepage', 'supporturl', 'updateurl', 'downloadurl', 'license', 'copyright'
  ])
  const extra: Record<string, string[]> = {}
  for (const [key, values] of fields) {
    if (!known.has(key)) extra[key] = values
  }

  const meta: UserScriptMeta = {
    name,
    namespace: first('namespace'),
    version: first('version'),
    description: first('description'),
    author: first('author'),
    matches,
    includes,
    excludes: all('exclude'),
    runAt: normalizeRunAt(first('run-at')),
    grants: all('grant').filter(g => g.toLowerCase() !== 'none'),
    requires: all('require'),
    resources,
    noframes: fields.has('noframes'),
    ...(first('icon') ? { icon: first('icon') } : {}),
    extra
  }

  const start = block.index ?? 0
  const end = start + metaStr.length
  // 用等量换行替换元数据块，保持正文行号不变
  const removedLines = metaStr.split(/\r?\n/).length - 1
  const body = text.slice(0, start) + '\n'.repeat(removedLines) + text.slice(end)

  return { meta, body, metaStr }
}

/** 稳定 id：同一 @namespace + @name 的脚本重装会覆盖同一条记录 */
export function userScriptId(meta: UserScriptMeta): string {
  return crypto
    .createHash('sha1')
    .update(`${meta.namespace}\u0000${meta.name}`)
    .digest('hex')
    .slice(0, 16)
}

/* ---------------------------------------------------------------- matching */

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

function globToRegExpSource(glob: string): string {
  let out = ''
  for (const ch of glob) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += escapeRegExp(ch)
  }
  return out
}

/** Chrome match pattern：<scheme>://<host><path>，scheme 支持 *，host 支持 *. 前缀通配 */
function matchPatternToRegExp(pattern: string): RegExp | null {
  const m = /^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)?$/.exec(pattern.trim())
  if (!m) return null
  const [, scheme, host, rawPath] = m
  const schemeSrc = scheme === '*' ? 'https?' : escapeRegExp(scheme)
  let hostSrc: string
  if (host === '*') hostSrc = '[^/?#]+'
  else if (host.startsWith('*.')) hostSrc = `(?:[^/?#]+\\.)?${escapeRegExp(host.slice(2))}`
  else hostSrc = escapeRegExp(host)
  const pathSrc = globToRegExpSource(rawPath && rawPath.length > 0 ? rawPath : '/')
  try {
    return new RegExp(`^${schemeSrc}://${hostSrc}${pathSrc}$`)
  } catch {
    return null
  }
}

/** @include / @exclude 既可以是 match pattern，也可以是 glob，还允许 /正则/ */
function includeToMatcher(pattern: string): RegExp | null {
  const raw = pattern.trim()
  if (!raw || raw.startsWith('@')) return null
  if (raw.length > 2 && raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
    const lastSlash = raw.lastIndexOf('/')
    const source = raw.slice(1, lastSlash)
    const flags = raw.slice(lastSlash + 1).replace(/[^gimsuy]/g, '')
    try {
      // 去掉 g 标志，避免 lastIndex 影响重复测试
      return new RegExp(source, flags.replace(/g/g, ''))
    } catch {
      return null
    }
  }
  if (raw.includes('://')) {
    const patternRe = matchPatternToRegExp(raw)
    if (patternRe) return patternRe
  }
  try {
    return new RegExp(`^${globToRegExpSource(raw)}$`)
  } catch {
    return null
  }
}

/** 某个 URL 是否命中该脚本 */
export function userScriptMatches(url: string, meta: UserScriptMeta): boolean {
  if (!url) return false
  for (const ex of meta.excludes) {
    const re = includeToMatcher(ex)
    if (re && re.test(url)) return false
  }
  for (const pattern of meta.matches) {
    const re = matchPatternToRegExp(pattern)
    if (re && re.test(url)) return true
  }
  for (const inc of meta.includes) {
    const re = includeToMatcher(inc)
    if (re && re.test(url)) return true
  }
  return false
}

/* ------------------------------------------------------------ record cache */

interface CachedRecord {
  mtime: number
  source: string
  parsed: ParsedUserScript
}

const recordCache = new Map<string, CachedRecord>()

function findScriptFile(id: string): string | null {
  const file = path.join(userscriptsDir(), `${id}.user.js`)
  return fs.existsSync(file) ? file : null
}

function readRecord(file: string): CachedRecord | null {
  try {
    const st = fs.statSync(file)
    const cached = recordCache.get(file)
    if (cached && cached.mtime === st.mtimeMs) return cached
    const source = fs.readFileSync(file, 'utf8')
    let parsed: ParsedUserScript
    try {
      parsed = parseUserScript(source)
    } catch (e) {
      // 解析失败的脚本仍然出现在列表里，方便用户修正：用文件名兜底
      parsed = {
        meta: {
          name: path.basename(file, '.user.js'),
          namespace: '',
          version: '',
          description: '',
          author: '',
          matches: [],
          includes: [],
          excludes: [],
          runAt: DEFAULT_RUN_AT,
          grants: [],
          requires: [],
          resources: [],
          noframes: false,
          extra: { parseError: [e instanceof Error ? e.message : String(e)] }
        },
        body: '',
        metaStr: ''
      }
      const record: CachedRecord = { mtime: st.mtimeMs, source, parsed }
      recordCache.set(file, record)
      return record
    }
    const record: CachedRecord = { mtime: st.mtimeMs, source, parsed }
    recordCache.set(file, record)
    return record
  } catch {
    return null
  }
}

/* ------------------------------------------------------------ enabled flag */

function disabledIds(): Set<string> {
  const raw = getStore().get('userscripts.disabledIds')
  return new Set(Array.isArray(raw) ? (raw as string[]) : [])
}

function writeDisabledIds(ids: Set<string>): void {
  getStore().set('userscripts.disabledIds', [...ids])
}

/* --------------------------------------------------------- require/resource */

function cacheKeyFor(url: string): string {
  return crypto.createHash('sha1').update(url).digest('hex')
}

function extForUrl(url: string): string {
  try {
    const p = new URL(url).pathname
    const ext = path.extname(p).replace(/[^\w.]/g, '')
    return ext && ext.length <= 6 ? ext : '.txt'
  } catch {
    return '.txt'
  }
}

function cacheFileFor(url: string): string {
  return path.join(cacheDir(), `${cacheKeyFor(url)}${extForUrl(url)}`)
}

function fetchSession(): Electron.Session {
  return session.fromPartition('persist:browser')
}

async function download(url: string, force: boolean): Promise<string> {
  ensureDirs()
  const file = cacheFileFor(url)
  if (!force && fs.existsSync(file)) return file
  const res = await fetchSession().fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, file)
  return file
}

/** 确保脚本声明的 @require / @resource 都已落到本地缓存，返回失败原因（全部成功返回 null） */
async function ensureAssets(meta: UserScriptMeta, force = false): Promise<string | null> {
  const jobs: { kind: string; url: string }[] = [
    ...meta.requires.map(url => ({ kind: '@require', url })),
    ...meta.resources.map(r => ({ kind: '@resource', url: r.url }))
  ]
  const errors: string[] = []
  for (const job of jobs) {
    try {
      await download(job.url, force)
    } catch (e) {
      errors.push(`${job.kind} ${job.url}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return errors.length > 0 ? errors.join('; ') : null
}

function readCacheText(url: string): string {
  const file = cacheFileFor(url)
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/* --------------------------------------------------------------- summaries */

function toSummary(id: string, file: string, record: CachedRecord): UserScriptSummary {
  let size = 0
  let mtime = 0
  try {
    const st = fs.statSync(file)
    size = st.size
    mtime = st.mtimeMs
  } catch {
    /* 文件刚被删除 */
  }
  const parseError = record.parsed.meta.extra.parseError?.[0] ?? null
  const missingAssets = [
    ...record.parsed.meta.requires,
    ...record.parsed.meta.resources.map(r => r.url)
  ].filter(url => !fs.existsSync(cacheFileFor(url)))

  return {
    id,
    enabled: !disabledIds().has(id) && !parseError,
    file,
    meta: record.parsed.meta,
    size,
    mtime,
    cacheError: parseError ?? (missingAssets.length > 0 ? `尚未下载 ${missingAssets.length} 个外部依赖` : null)
  }
}

export function listUserScripts(): UserScriptSummary[] {
  ensureDirs()
  let entries: string[]
  try {
    entries = fs.readdirSync(userscriptsDir())
  } catch {
    return []
  }
  const out: UserScriptSummary[] = []
  for (const name of entries) {
    if (!name.endsWith('.user.js')) continue
    const id = name.slice(0, -'.user.js'.length)
    const file = path.join(userscriptsDir(), name)
    const record = readRecord(file)
    if (!record) continue
    out.push(toSummary(id, file, record))
  }
  out.sort((a, b) => a.meta.name.localeCompare(b.meta.name, 'zh-Hans-CN'))
  return out
}

export function getUserScriptDetail(id: string): UserScriptDetail | null {
  const file = findScriptFile(id)
  if (!file) return null
  const record = readRecord(file)
  if (!record) return null
  return { ...toSummary(id, file, record), source: record.source }
}

/* ------------------------------------------------------------------- CRUD */

async function writeScript(id: string, source: string): Promise<void> {
  ensureDirs()
  const file = path.join(userscriptsDir(), `${id}.user.js`)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, source.replace(/\r\n/g, '\n'))
  fs.renameSync(tmp, file)
  recordCache.delete(file)
}

export async function installUserScript(source: string): Promise<UserScriptSummary> {
  const parsed = parseUserScript(source)
  const id = userScriptId(parsed.meta)
  const existed = findScriptFile(id) !== null
  await writeScript(id, source)
  const cacheError = await ensureAssets(parsed.meta)
  const file = path.join(userscriptsDir(), `${id}.user.js`)
  const record = readRecord(file)
  if (!record) throw new Error('脚本写入失败')
  if (existed) {
    // 覆盖安装视为用户明确想启用
    const disabled = disabledIds()
    if (disabled.delete(id)) writeDisabledIds(disabled)
  }
  const summary = toSummary(id, file, record)
  return { ...summary, cacheError }
}

export async function saveUserScript(id: string, source: string): Promise<UserScriptSummary> {
  const file = findScriptFile(id)
  if (!file) throw new Error('脚本不存在')
  const parsed = parseUserScript(source)
  const newId = userScriptId(parsed.meta)
  if (newId !== id) {
    // @name / @namespace 改了会换 id：删旧文件，按新 id 落盘
    await writeScript(newId, source)
    try {
      fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
    recordCache.delete(file)
    const cacheError = await ensureAssets(parsed.meta)
    const record = readRecord(path.join(userscriptsDir(), `${newId}.user.js`))!
    return { ...toSummary(newId, path.join(userscriptsDir(), `${newId}.user.js`), record), cacheError }
  }
  await writeScript(id, source)
  const cacheError = await ensureAssets(parsed.meta)
  const record = readRecord(file)
  if (!record) throw new Error('脚本写入失败')
  return { ...toSummary(id, file, record), cacheError }
}

export function removeUserScript(id: string): void {
  const file = findScriptFile(id)
  if (file) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
    recordCache.delete(file)
  }
  const valueFile = path.join(valuesDir(), `${id}.json`)
  try {
    fs.unlinkSync(valueFile)
  } catch {
    /* ignore */
  }
  valueCache.delete(id)
  const disabled = disabledIds()
  if (disabled.delete(id)) writeDisabledIds(disabled)
}

export function setUserScriptEnabled(id: string, enabled: boolean): UserScriptSummary {
  const file = findScriptFile(id)
  if (!file) throw new Error('脚本不存在')
  const disabled = disabledIds()
  if (enabled) disabled.delete(id)
  else disabled.add(id)
  writeDisabledIds(disabled)
  const record = readRecord(file)
  if (!record) throw new Error('脚本读取失败')
  return toSummary(id, file, record)
}

export async function refreshUserScriptCache(id: string): Promise<UserScriptSummary> {
  const file = findScriptFile(id)
  if (!file) throw new Error('脚本不存在')
  const record = readRecord(file)
  if (!record) throw new Error('脚本读取失败')
  const cacheError = await ensureAssets(record.parsed.meta, true)
  return { ...toSummary(id, file, record), cacheError }
}

export function rescanUserScripts(): UserScriptSummary[] {
  recordCache.clear()
  return listUserScripts()
}

export async function installUserScriptsFromFiles(): Promise<UserScriptSummary[]> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined
  const result = await dialog.showOpenDialog(win as BrowserWindow, {
    title: '选择用户脚本',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '用户脚本', extensions: ['js', 'txt'] }, { name: '全部文件', extensions: ['*'] }]
  })
  if (result.canceled) return []
  const out: UserScriptSummary[] = []
  for (const file of result.filePaths) {
    const source = fs.readFileSync(file, 'utf8')
    out.push(await installUserScript(source))
  }
  return out
}

export function openUserScriptsDir(): void {
  ensureDirs()
  void shell.openPath(userscriptsDir())
}

/* --------------------------------------------------------------- GM values */

const valueCache = new Map<string, Record<string, unknown>>()

function loadValues(id: string): Record<string, unknown> {
  const cached = valueCache.get(id)
  if (cached) return cached
  const file = path.join(valuesDir(), `${id}.json`)
  let parsed: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) parsed = raw as Record<string, unknown>
  } catch {
    /* 文件不存在或损坏：从空值开始 */
  }
  valueCache.set(id, parsed)
  return parsed
}

function persistValues(id: string): void {
  ensureDirs()
  const file = path.join(valuesDir(), `${id}.json`)
  const tmp = `${file}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(loadValues(id), null, 2))
    fs.renameSync(tmp, file)
  } catch {
    /* 存储失败不该让脚本崩溃 */
  }
}

export function gmSetValue(id: string, key: string, value: unknown): void {
  const values = loadValues(id)
  values[key] = value
  persistValues(id)
}

export function gmDeleteValue(id: string, key: string): void {
  const values = loadValues(id)
  delete values[key]
  persistValues(id)
}

/* ------------------------------------------------------------ URL → 注入集 */

function buildInjection(id: string, record: CachedRecord): UserScriptInjection {
  const { meta, body, metaStr } = record.parsed
  const requireCode = meta.requires
    .map(url => readCacheText(url))
    .filter(text => text.trim().length > 0)
    .join('\n;/* ---- next @require ---- */\n')

  const resources: Record<string, string> = {}
  for (const res of meta.resources) {
    const text = readCacheText(res.url)
    if (text) resources[res.name] = text
  }

  return {
    id,
    name: meta.name,
    runAt: meta.runAt,
    grants: meta.grants,
    requireCode,
    code: body,
    resources,
    info: {
      script: {
        name: meta.name,
        namespace: meta.namespace,
        version: meta.version,
        description: meta.description,
        author: meta.author,
        matches: meta.matches,
        grants: meta.grants,
        runAt: meta.runAt
      },
      scriptHandler: 'MIR Userscripts',
      version: app.getVersion(),
      scriptMetaStr: metaStr
    }
  }
}

/** 同步构造某 URL 的注入快照：preload 用 sendSync 调用，必须同一次事件循环返回 */
export function userScriptsForUrl(url: string): UserScriptsForUrlPayload {
  const payload: UserScriptsForUrlPayload = { url, scripts: [], values: {} }
  if (!url || /^(about|devtools|chrome|chrome-extension|data):/i.test(url)) return payload

  const disabled = disabledIds()
  const summaries = listUserScripts()
  for (const summary of summaries) {
    if (disabled.has(summary.id)) continue
    if (summary.cacheError && summary.meta.extra.parseError) continue
    if (!userScriptMatches(url, summary.meta)) continue
    const record = readRecord(summary.file)
    if (!record) continue
    payload.scripts.push(buildInjection(summary.id, record))
    payload.values[summary.id] = { ...loadValues(summary.id) }
  }
  return payload
}

/* ------------------------------------------------------------ cross-origin */

export async function gmXhr(request: GmXhrRequest): Promise<GmXhrResponse> {
  const empty: GmXhrResponse = {
    ok: false,
    status: 0,
    statusText: '',
    responseHeaders: '',
    finalUrl: request.url,
    responseText: ''
  }
  if (!request || typeof request.url !== 'string' || request.url.length === 0) {
    return { ...empty, error: '缺少 url' }
  }

  const ses = request.anonymous
    ? session.fromPartition('userscripts-anonymous')
    : fetchSession()

  const controller = new AbortController()
  const timeoutMs = typeof request.timeout === 'number' && request.timeout > 0 ? request.timeout : 30_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await ses.fetch(request.url, {
      method: request.method && request.method.length > 0 ? request.method.toUpperCase() : 'GET',
      headers: request.headers,
      body: request.data,
      redirect: 'follow',
      signal: controller.signal
    } as RequestInit)

    const headerLines: string[] = []
    res.headers.forEach((value, key) => {
      headerLines.push(`${key.toUpperCase()}: ${value}`)
    })

    const isBinary = request.responseType === 'arraybuffer'
    const body = isBinary
      ? Buffer.from(await res.arrayBuffer()).toString('base64')
      : await res.text()

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      responseHeaders: headerLines.join('\r\n'),
      finalUrl: res.url || request.url,
      responseText: body
    }
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

/* --------------------------------------------------------------- host hooks */

/** GM_openInTab：转给宿主渲染进程开一个浏览器标签（复用已有的 webview:new-window 通道） */
export function openUrlInBrowserTab(url: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('webview:new-window', url)
  }
}

export function showUserScriptNotification(title: string, text: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title: title || '用户脚本', body: text || '' }).show()
}
