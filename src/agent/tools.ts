/**
 * MIR Harness 的工具集：模型可以调用的 5 个工具。
 *
 * 运行环境通过 ToolContext 注入，工具本身不碰全局状态：
 * - 读文件走 ctx.fs.readText（上层决定是 ACP client 的 fs 能力还是本地 fs）；
 * - 写文件 / 执行命令前，按 mode、会话级授权决定是否 requestPermission；
 * - ctx.signal 已 abort 时立刻抛 AbortError，让 agent 循环把整轮当成取消。
 *
 * 约定：参数缺失 / 参数非法返回 isError: true 的 ToolResult（文本里说明正确用法），
 * 只有 abort 才抛异常，这样 agent 循环调用工具时不需要给每个工具包 try/catch。
 * 返回给模型的文本统一按 TOOL_OUTPUT_LIMIT 截断：read_file 等保留头部，
 * run_command 保留尾部（构建 / 测试报错通常在末尾）。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TOOL_OUTPUT_LIMIT, readNumberArg, readStringArg } from './types'
import type {
  ToolCallRequest,
  ToolContext,
  ToolDefinition,
  ToolKind,
  ToolLocation,
  ToolResult,
  ToolSpec
} from './types'

/** allow_always 之后写进上下文的授权键（与工具名一致） */
const ALLOWANCE_WRITE_FILE = 'write_file'
const ALLOWANCE_RUN_COMMAND = 'run_command'

/* -------------------------------- read_file ------------------------------- */

const DEFAULT_READ_LINES = 400
const MAX_READ_LINES = 2000
const LINE_NUMBER_WIDTH = 4
/** 超过这个大小的文件直接拒绝，避免 agent 进程把几十 MB 的日志读进内存 */
const MAX_READ_FILE_BYTES = 8 * 1024 * 1024

/* -------------------------------- list_dir -------------------------------- */

const MAX_LIST_ENTRIES = 500

/* ------------------------------ search_files ------------------------------ */

const MAX_SEARCH_MATCHES = 100
const MAX_SEARCH_LINE_LENGTH = 200
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_SEARCH_LOCATIONS = 20
/** 递归搜索时跳过的目录：版本库元数据、依赖、构建产物 */
const SEARCH_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'release',
  '.next',
  '.cache',
  'pnpm-store'
])

/* ------------------------------- run_command ------------------------------ */

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
const MAX_COMMAND_TIMEOUT_MS = 600_000
/** 先 SIGTERM，宽限 5 秒后 SIGKILL */
const KILL_GRACE_MS = 5000
const BASH_PATH = '/bin/bash'
const SH_PATH = '/bin/sh'

/** 权限卡片里展示的写文件内容预览长度 */
const PERMISSION_PREVIEW_LIMIT = 2000

/* --------------------------------- 通用工具 -------------------------------- */

/** 统一的取消错误：name 固定为 AbortError，agent 循环据此识别取消 */
function abortError(): Error {
  const error = new Error('操作已中止')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(ctx: ToolContext): void {
  if (ctx.signal.aborted) throw abortError()
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function messageOf(error: unknown): string {
  return toError(error).message
}

function statOrNull(target: string): Stats | null {
  try {
    return statSync(target)
  } catch {
    return null
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function compareName(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** 路径在 cwd 内就显示相对路径，否则显示绝对路径（读操作允许绝对路径） */
function displayPathOf(cwd: string, absolute: string): string {
  const relativePath = relative(cwd, absolute)
  if (!relativePath) return absolute
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return absolute
  }
  return relativePath
}

/**
 * 写操作的目标解析：只允许落在 cwd 之内。
 * 用 resolve + relative 判断，越界返回 null（调用方转成错误文本，不抛异常）。
 * 注意：这里不展开 realpath，软链接指向工作区外的极端情况由上层自行约束。
 */
function resolveInsideWorkspace(cwd: string, input: string): { absolute: string; relative: string } | null {
  const root = resolve(cwd)
  const absolute = resolve(root, input)
  const relativePath = relative(root, absolute)
  if (!relativePath) return null // 目标就是工作目录本身
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null
  return { absolute, relative: relativePath }
}

/** 单行化 + 截断，用于工具标题 / 权限标题 */
function previewText(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= limit) return oneLine
  return `${oneLine.slice(0, limit)}…`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 保留头部截断，并在末尾标注被截断 */
function limitHead(text: string): string {
  if (text.length <= TOOL_OUTPUT_LIMIT) return text
  const head = text.slice(0, TOOL_OUTPUT_LIMIT)
  const lastBreak = head.lastIndexOf('\n')
  const body = lastBreak > Math.floor(TOOL_OUTPUT_LIMIT / 2) ? head.slice(0, lastBreak) : head
  return `${body}\n…（输出已截断：共 ${text.length} 字符，仅显示前 ${body.length} 字符）`
}

/** 权限卡片里的文件内容预览 */
function previewContent(content: string): string {
  if (content.length <= PERMISSION_PREVIEW_LIMIT) return content
  return `${content.slice(0, PERMISSION_PREVIEW_LIMIT)}\n…（共 ${content.length} 字符，仅展示前 ${PERMISSION_PREVIEW_LIMIT} 字符）`
}

interface ResultOptions {
  title: string
  kind: ToolKind
  text: string
  isError?: boolean
  display?: string
  locations?: ToolLocation[]
}

function buildResult(options: ResultOptions): ToolResult {
  const result: ToolResult = { title: options.title, kind: options.kind, text: options.text }
  if (options.display !== undefined) result.display = options.display
  if (options.locations && options.locations.length > 0) result.locations = options.locations
  if (options.isError) result.isError = true
  return result
}

function errorResult(kind: ToolKind, title: string, text: string, locations?: ToolLocation[]): ToolResult {
  return buildResult({ title, kind, text, isError: true, locations })
}

/* --------------------------------- read_file -------------------------------- */

async function runReadFile(
  _call: ToolCallRequest,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  throwIfAborted(ctx)

  const inputPath = readStringArg(args, 'path')?.trim()
  if (!inputPath) {
    return errorResult(
      'read',
      '读取文件',
      '缺少参数 path。用法：read_file({"path":"src/index.ts","line":1,"limit":400})'
    )
  }

  const absolute = resolve(ctx.cwd, inputPath)
  const displayPath = displayPathOf(ctx.cwd, absolute)
  const title = `读取文件 ${displayPath}`
  const startLine = Math.max(1, Math.floor(readNumberArg(args, 'line') ?? 1))
  const limit = clampInt(readNumberArg(args, 'limit') ?? DEFAULT_READ_LINES, 1, MAX_READ_LINES)

  const stat = statOrNull(absolute)
  if (!stat) return errorResult('read', title, `文件不存在：${inputPath}`)
  if (stat.isDirectory()) {
    return errorResult('read', title, `${inputPath} 是目录，查看目录内容请用 list_dir`)
  }
  if (!stat.isFile()) {
    return errorResult('read', title, `${inputPath} 不是普通文件，read_file 只能读取文本文件`)
  }
  if (stat.size > MAX_READ_FILE_BYTES) {
    return errorResult(
      'read',
      title,
      `文件过大（${formatBytes(stat.size)}），read_file 只读取 ${formatBytes(MAX_READ_FILE_BYTES)} 以内的文件；请用 search_files 定位后用 line / limit 分段读取`
    )
  }

  let content: string
  try {
    content = await ctx.fs.readText(absolute)
  } catch (error) {
    return errorResult('read', title, `读取 ${inputPath} 失败：${messageOf(error)}`)
  }
  throwIfAborted(ctx)

  // 文本文件里不该出现 NUL 字节；出现就说明是二进制（压缩包、图片、可执行文件等）
  if (content.includes('\u0000')) {
    return errorResult('read', title, `${inputPath} 含 NUL 字节，看起来是二进制文件；read_file 只读取文本文件`)
  }

  const locations: ToolLocation[] = [{ path: absolute, line: startLine }]
  if (content === '') {
    return buildResult({ title, kind: 'read', text: `（${displayPath} 是空文件）`, locations })
  }

  const lines = content.split(/\r?\n/)
  // 文件以换行结尾时 split 会多出一个空串，不算真实行
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  if (startLine > lines.length) {
    return errorResult('read', title, `起始行 ${startLine} 超出文件范围：${inputPath} 共 ${lines.length} 行`)
  }

  const endLine = Math.min(lines.length, startLine - 1 + limit)
  const width = Math.max(LINE_NUMBER_WIDTH, String(endLine).length)
  let text = lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${String(startLine + index).padStart(width)}| ${line}`)
    .join('\n')

  if (endLine < lines.length) {
    text += `\n…（文件共 ${lines.length} 行，已显示第 ${startLine}-${endLine} 行；可用 line / limit 继续读取）`
  }

  return buildResult({ title, kind: 'read', text: limitHead(text), locations })
}

/* -------------------------------- write_file -------------------------------- */

async function runWriteFile(
  _call: ToolCallRequest,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  throwIfAborted(ctx)

  const inputPath = readStringArg(args, 'path')?.trim()
  const content = readStringArg(args, 'content')
  if (!inputPath || content === undefined) {
    return errorResult(
      'edit',
      '写入文件',
      '缺少参数。用法：write_file({"path":"src/index.ts","content":"完整文件内容"})；content 是整份文件内容，不是 diff。'
    )
  }

  const target = resolveInsideWorkspace(ctx.cwd, inputPath)
  if (!target) {
    return errorResult(
      'edit',
      `写入文件 ${inputPath}`,
      `拒绝写入：${inputPath} 不在工作目录 ${ctx.cwd} 内。write_file 只允许写工作目录里的文件。`
    )
  }

  const displayPath = target.relative
  const title = `写入文件 ${displayPath}`
  const locations: ToolLocation[] = [{ path: target.absolute }]

  const stat = statOrNull(target.absolute)
  if (stat?.isDirectory()) {
    return errorResult('edit', title, `${displayPath} 是一个目录，不能当文件写入`)
  }
  const exists = stat !== null

  // ask 模式下写文件前必须问一次；code 模式或已有 allow_always 授权时直接写
  if (ctx.mode !== 'code' && !ctx.hasAllowance(ALLOWANCE_WRITE_FILE)) {
    const outcome = await ctx.requestPermission({
      title,
      kind: 'edit',
      content: previewContent(content),
      locations,
      rawInput: {
        path: displayPath,
        bytes: Buffer.byteLength(content, 'utf8'),
        overwrite: exists
      }
    })
    if (outcome === 'reject') {
      return errorResult('edit', title, `用户拒绝了写入 ${displayPath}，文件没有做任何改动。`)
    }
    if (outcome === 'allow_always') ctx.rememberAllowance(ALLOWANCE_WRITE_FILE)
    // 等授权期间可能被取消
    throwIfAborted(ctx)
  }

  try {
    await ctx.fs.writeText(target.absolute, content)
  } catch (error) {
    return errorResult('edit', title, `写入 ${displayPath} 失败：${messageOf(error)}`)
  }

  const bytes = Buffer.byteLength(content, 'utf8')
  const lineCount = content === '' ? 0 : content.replace(/\r?\n$/, '').split(/\r?\n/).length
  const text = exists
    ? `已覆盖 ${displayPath}（${bytes} 字节，${lineCount} 行）。注意：write_file 是全量覆盖，原文件内容已被整份替换。`
    : `已创建 ${displayPath}（${bytes} 字节，${lineCount} 行）。`

  return buildResult({ title, kind: 'edit', text, locations })
}

/* --------------------------------- list_dir -------------------------------- */

/** 软链接按目标类型展示为目录或文件 */
function isDirectoryEntry(entry: Dirent, absolute: string): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  return statOrNull(absolute)?.isDirectory() ?? false
}

async function runListDir(
  _call: ToolCallRequest,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  throwIfAborted(ctx)

  const inputPath = readStringArg(args, 'path')?.trim() || '.'
  const absolute = resolve(ctx.cwd, inputPath)
  const displayPath = displayPathOf(ctx.cwd, absolute)
  const title = `列出目录 ${displayPath}`

  const stat = statOrNull(absolute)
  if (!stat) return errorResult('read', title, `目录不存在：${inputPath}`)
  if (!stat.isDirectory()) {
    return errorResult('read', title, `${inputPath} 不是目录；读取文件内容请用 read_file`)
  }

  let entries: Dirent[]
  try {
    entries = readdirSync(absolute, { withFileTypes: true })
  } catch (error) {
    return errorResult('read', title, `无法读取目录 ${displayPath}：${messageOf(error)}`)
  }

  const listed = entries.map((entry) => ({
    name: entry.name,
    directory: isDirectoryEntry(entry, join(absolute, entry.name))
  }))
  // 目录在前，同类按名字排序，避免不同文件系统返回顺序不一致
  listed.sort((a, b) => (a.directory === b.directory ? compareName(a.name, b.name) : a.directory ? -1 : 1))

  const locations: ToolLocation[] = [{ path: absolute }]
  if (listed.length === 0) {
    return buildResult({ title, kind: 'read', text: `（${displayPath} 是空目录）`, locations })
  }

  const shown = listed.slice(0, MAX_LIST_ENTRIES)
  let text = shown.map((entry) => (entry.directory ? `${entry.name}/` : entry.name)).join('\n')
  if (listed.length > shown.length) {
    text += `\n…（共 ${listed.length} 项，仅显示前 ${MAX_LIST_ENTRIES} 项）`
  }

  return buildResult({ title, kind: 'read', text: limitHead(text), locations })
}

/* ------------------------------- search_files ------------------------------- */

/** ext 参数统一成带点的形式（ts → .ts），比较时忽略大小写 */
function normalizeExtension(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const ext = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
  return ext.toLowerCase()
}

async function runSearchFiles(
  _call: ToolCallRequest,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  throwIfAborted(ctx)

  const pattern = readStringArg(args, 'pattern')?.trim()
  if (!pattern) {
    return errorResult(
      'search',
      '搜索文件',
      '缺少参数 pattern。用法：search_files({"pattern":"createServer\\(","path":"src","ext":".ts"})'
    )
  }

  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (error) {
    return errorResult('search', `搜索 ${pattern}`, `正则表达式无效：${pattern}\n${messageOf(error)}`)
  }

  const inputPath = readStringArg(args, 'path')?.trim() || '.'
  const root = resolve(ctx.cwd, inputPath)
  const displayRoot = displayPathOf(ctx.cwd, root)
  const title = `搜索 ${pattern}`

  const stat = statOrNull(root)
  if (!stat) return errorResult('search', title, `路径不存在：${inputPath}`)
  if (!stat.isDirectory()) return errorResult('search', title, `${inputPath} 不是目录，search_files 需要搜索目录`)

  const ext = normalizeExtension(readStringArg(args, 'ext'))
  const matches: string[] = []
  const locations: ToolLocation[] = []
  const locatedFiles = new Set<string>()

  const scanFile = (file: string): void => {
    throwIfAborted(ctx)
    if (matches.length >= MAX_SEARCH_MATCHES) return

    const fileStat = statOrNull(file)
    if (!fileStat?.isFile() || fileStat.size > MAX_SEARCH_FILE_BYTES) return

    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      return // 没权限 / 读失败的文件直接跳过
    }
    if (content === '' || content.includes('\u0000')) return

    const displayFile = displayPathOf(ctx.cwd, file)
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= MAX_SEARCH_MATCHES) return
      const line = lines[index]
      if (!regex.test(line)) continue

      const trimmed = line.trim()
      const shown =
        trimmed.length > MAX_SEARCH_LINE_LENGTH
          ? `${Array.from(trimmed).slice(0, MAX_SEARCH_LINE_LENGTH).join('')}…`
          : trimmed
      matches.push(`${displayFile}:${index + 1}: ${shown}`)

      if (!locatedFiles.has(file)) {
        locatedFiles.add(file)
        if (locations.length < MAX_SEARCH_LOCATIONS) locations.push({ path: file, line: index + 1 })
      }
    }
  }

  const walk = (dir: string): void => {
    throwIfAborted(ctx)
    if (matches.length >= MAX_SEARCH_MATCHES) return

    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 读不进去的目录跳过
    }
    entries.sort((a, b) => compareName(a.name, b.name))

    for (const entry of entries) {
      if (matches.length >= MAX_SEARCH_MATCHES) return
      // 软链接跳过：既避免循环，也避免跟随到工作区外
      if (entry.isSymbolicLink()) continue

      const entryPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name)) continue
        walk(entryPath)
        continue
      }
      if (!entry.isFile()) continue
      if (ext && extname(entry.name).toLowerCase() !== ext) continue
      scanFile(entryPath)
    }
  }

  walk(root)

  if (matches.length === 0) {
    const extNote = ext ? `（仅看 ${ext} 文件）` : ''
    return buildResult({
      title,
      kind: 'search',
      text: `在 ${displayRoot} 下没有找到匹配 ${pattern} 的内容${extNote}`
    })
  }

  let text = matches.join('\n')
  if (matches.length >= MAX_SEARCH_MATCHES) {
    text += `\n…（已达到 ${MAX_SEARCH_MATCHES} 条上限，可能还有更多匹配；请缩小 path 或用更精确的正则）`
  }

  return buildResult({ title, kind: 'search', text: limitHead(text), locations })
}

/* -------------------------------- run_command ------------------------------- */

/** 优先登录 shell（PATH 和用户终端一致）；没有 bash 的极简环境退回 POSIX sh */
function resolveShell(command: string): { command: string; args: string[] } {
  if (existsSync(BASH_PATH)) return { command: BASH_PATH, args: ['-lc', command] }
  return { command: SH_PATH, args: ['-c', command] }
}

/**
 * 粗略判断命令是否只在工作区内活动，用于 code 模式下免授权执行。
 * 只盯明显的越界信号：家目录写法、路径里出现 `..`、工作区外的绝对路径。
 * 这是一条启发式规则：宁可多弹一次权限，也不要在 code 模式下默默执行到工作区外。
 */
function looksInsideWorkspace(command: string, cwd: string): boolean {
  const root = resolve(cwd)
  const tokens = command.split(/[\s;&|()<>=`'"]+/).filter(Boolean)
  for (const token of tokens) {
    if (token.startsWith('~')) return false
    if (/(^|\/)\.\.($|\/)/.test(token)) return false
    if (!token.startsWith('/')) continue
    const target = resolve(token)
    const relativePath = relative(root, target)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return false
    }
  }
  return true
}

interface CommandOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  /** 已按 TOOL_OUTPUT_LIMIT 保留尾部 */
  output: string
  /** 输出总字符数（截断前），用于标注 */
  totalChars: number
  truncated: boolean
  timedOut: boolean
  spawnError?: Error
}

/**
 * 执行 shell 命令，合并 stdout / stderr。
 * 超时或 abort 时先 SIGTERM，KILL_GRACE_MS 后再 SIGKILL（整组，见 detached 注释）。
 * 本函数不抛异常：启动失败通过 outcome.spawnError 返回。
 */
function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<CommandOutcome> {
  const shell = resolveShell(command)

  return new Promise<CommandOutcome>((settle) => {
    let child: ChildProcess
    try {
      child = spawn(shell.command, shell.args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 独立进程组：超时 / 取消时能把 shell 派生的子进程一起收掉
        detached: process.platform !== 'win32'
      })
    } catch (error) {
      settle({
        code: null,
        signal: null,
        output: '',
        totalChars: 0,
        truncated: false,
        timedOut: false,
        spawnError: toError(error)
      })
      return
    }

    let output = ''
    let totalChars = 0
    let truncated = false
    let timedOut = false
    let finished = false
    let timeoutTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined

    const append = (chunk: string): void => {
      totalChars += chunk.length
      output += chunk
      // 只保留尾部：长命令的输出往往有几十兆，全留会撑爆 agent 进程
      if (output.length > TOOL_OUTPUT_LIMIT) {
        output = output.slice(output.length - TOOL_OUTPUT_LIMIT)
        truncated = true
      }
    }

    const terminate = (sig: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        // detached 之后 child.pid 就是进程组 id，负数表示整个进程组
        if (process.platform !== 'win32' && typeof child.pid === 'number') process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch {
        try {
          child.kill(sig)
        } catch {
          // 进程已经退出，忽略
        }
      }
    }

    const terminateWithGrace = (): void => {
      terminate('SIGTERM')
      if (killTimer) return
      killTimer = setTimeout(() => terminate('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref()
    }

    const onAbort = (): void => {
      terminateWithGrace()
    }

    const finish = (code: number | null, sig: NodeJS.Signals | null, spawnError?: Error): void => {
      if (finished) return
      finished = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      signal.removeEventListener('abort', onAbort)

      const outcome: CommandOutcome = { code, signal: sig, output, totalChars, truncated, timedOut }
      if (spawnError) outcome.spawnError = spawnError
      settle(outcome)
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => append(chunk))
    child.stderr?.on('data', (chunk: string) => append(chunk))
    child.on('error', (error) => finish(null, null, error))
    child.on('close', (code, sig) => finish(code, sig))

    timeoutTimer = setTimeout(() => {
      timedOut = true
      terminateWithGrace()
    }, timeoutMs)
    timeoutTimer.unref()

    if (signal.aborted) terminateWithGrace()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function formatCommandResult(
  outcome: CommandOutcome,
  title: string,
  command: string,
  timeoutMs: number
): ToolResult {
  if (outcome.spawnError) {
    return errorResult('execute', title, `命令启动失败：${messageOf(outcome.spawnError)}`)
  }

  const header = [`$ ${previewText(command, 200)}`]
  if (outcome.timedOut) header.push(`状态：超过 ${timeoutMs}ms 未结束，已终止进程`)
  if (outcome.signal) header.push(`信号：${outcome.signal}`)
  header.push(`退出码：${outcome.code === null ? '未知' : outcome.code}`)

  let output = outcome.output
  if (outcome.truncated) {
    output = `…（输出已截断：共 ${outcome.totalChars} 字符，仅保留最后 ${TOOL_OUTPUT_LIMIT} 字符）\n${output}`
  }
  if (output.trim() === '') output = '（无输出）'

  const text = `${header.join('\n')}\n输出：\n${output}`
  const isError = outcome.timedOut || outcome.signal !== null || (outcome.code !== null && outcome.code !== 0)
  return buildResult({ title, kind: 'execute', text, isError })
}

async function runRunCommand(
  _call: ToolCallRequest,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  throwIfAborted(ctx)

  const command = readStringArg(args, 'command')?.trim()
  if (!command) {
    return errorResult(
      'execute',
      '执行命令',
      '缺少参数 command。用法：run_command({"command":"npm test","timeoutMs":60000})'
    )
  }

  const timeoutMs = clampInt(
    readNumberArg(args, 'timeoutMs') ?? DEFAULT_COMMAND_TIMEOUT_MS,
    1,
    MAX_COMMAND_TIMEOUT_MS
  )
  const title = `执行命令 ${previewText(command, 80)}`

  // code 模式下、且命令看起来只在工作区内活动时免授权；ask 模式一律先问
  const autoApproved = ctx.mode === 'code' && looksInsideWorkspace(command, ctx.cwd)
  if (!autoApproved && !ctx.hasAllowance(ALLOWANCE_RUN_COMMAND)) {
    const outcome = await ctx.requestPermission({
      title,
      kind: 'execute',
      content: command,
      rawInput: { command }
    })
    if (outcome === 'reject') {
      return errorResult('execute', title, `用户拒绝了执行命令：${previewText(command, 200)}`)
    }
    if (outcome === 'allow_always') ctx.rememberAllowance(ALLOWANCE_RUN_COMMAND)
    // 等授权期间可能被取消
    throwIfAborted(ctx)
  }

  const outcome = await runShellCommand(command, ctx.cwd, timeoutMs, ctx.signal)
  // 被取消的命令不回给模型结果，直接按取消处理，避免模型继续往下推理
  if (ctx.signal.aborted) throw abortError()

  return formatCommandResult(outcome, title, command, timeoutMs)
}

/* --------------------------------- 工具清单 -------------------------------- */

const READ_FILE_SPEC: ToolSpec = {
  name: 'read_file',
  description:
    'Read a text file. The result is the file content prefixed with 1-based line numbers. Use `line` and `limit` to read a slice of a large file, and call it again to continue. Binary files (containing NUL bytes) and files larger than 8 MB are rejected. Always read a file before editing it.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'File path. Relative paths are resolved from the working directory; absolute paths are allowed.'
      },
      line: {
        type: 'number',
        description: '1-based line number to start reading from. Defaults to 1.'
      },
      limit: {
        type: 'number',
        description: `Maximum number of lines to return. Defaults to ${DEFAULT_READ_LINES}, maximum ${MAX_READ_LINES}.`
      }
    },
    required: ['path']
  }
}

const WRITE_FILE_SPEC: ToolSpec = {
  name: 'write_file',
  description:
    'Create a file, or replace an existing file with the given content. IMPORTANT: this tool overwrites the WHOLE file in a single call — send the complete final content, never a diff, a patch or a partial fragment, and read the file first so existing content is not lost. The path must stay inside the working directory; writes outside it are refused.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Target file path, relative to the working directory (absolute paths must resolve inside it).'
      },
      content: {
        type: 'string',
        description: 'Complete content of the file after the write. It replaces the entire file.'
      }
    },
    required: ['path', 'content']
  }
}

const LIST_DIR_SPEC: ToolSpec = {
  name: 'list_dir',
  description:
    'List the entries of a directory. Directories are shown with a trailing slash and come first, files after them. Defaults to the working directory. Prefer this over running `ls` through run_command.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path. Relative paths are resolved from the working directory. Defaults to ".".'
      }
    },
    required: []
  }
}

const SEARCH_FILES_SPEC: ToolSpec = {
  name: 'search_files',
  description: `Search file contents with a JavaScript regular expression and return matches as \`path:line: text\` (at most ${MAX_SEARCH_MATCHES}). Recursively walks the directory tree but skips .git, node_modules, out, dist, release, .next, .cache and pnpm-store, binary files, and files larger than 1 MB.`,
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression without delimiters or flags, e.g. "createServer\\(|app\\.listen".'
      },
      path: {
        type: 'string',
        description: 'Directory to search in, relative to the working directory. Defaults to ".".'
      },
      ext: {
        type: 'string',
        description: 'Only search files with this extension, e.g. ".ts" (a leading dot is optional).'
      }
    },
    required: ['pattern']
  }
}

const RUN_COMMAND_SPEC: ToolSpec = {
  name: 'run_command',
  description: `Run a shell command in the working directory and return its exit code, signal and the tail of the merged stdout/stderr. Commands run through the login shell (bash -lc, or sh -c when bash is unavailable). Use it for builds, tests, git and scripts; use read_file / write_file / search_files for file work. Long-running commands should be avoided or bounded with \`timeoutMs\`, because output is only kept from the tail.`,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Full shell command line, e.g. "npm run typecheck && npm test".'
      },
      timeoutMs: {
        type: 'number',
        description: `Timeout in milliseconds. Defaults to ${DEFAULT_COMMAND_TIMEOUT_MS}, capped at ${MAX_COMMAND_TIMEOUT_MS}. The process is terminated when it expires.`
      }
    },
    required: ['command']
  }
}

const TOOLS: ToolDefinition[] = [
  { spec: READ_FILE_SPEC, run: runReadFile },
  { spec: WRITE_FILE_SPEC, run: runWriteFile },
  { spec: LIST_DIR_SPEC, run: runListDir },
  { spec: SEARCH_FILES_SPEC, run: runSearchFiles },
  { spec: RUN_COMMAND_SPEC, run: runRunCommand }
]

/** 给模型客户端用的工具描述（OpenAI tools[].function 的 parameters 直接用它） */
export function getToolSpecs(): ToolSpec[] {
  return TOOLS.map((tool) => ({ ...tool.spec }))
}

/** 按名字找工具（模型返回的 tool call 靠它分发） */
export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.spec.name === name)
}
