/**
 * Agent 子进程的启动与终止。
 *
 * 与参考实现一致：在 macOS / Linux 上经由登录 shell 启动，这样 `npx`、`uvx`
 * 等命令能拿到用户在 .zshrc / .bash_profile 里配置的 PATH；Windows 直接用
 * `shell: true`。参数逐个做单引号转义，避免空格与特殊字符被 shell 解释。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { app } from 'electron'
import type { AcpAgentConfig } from '../../shared/acp'

/** 仓库内脚本（如 mock agent）不在会话 cwd 下，用该占位符展开成 app path */
export const APP_PATH_TOKEN = '{{APP_PATH}}'

const STDERR_TAIL_LIMIT = 8000
const KILL_GRACE_MS = 5000

const LOGIN_SHELLS = new Set(['zsh', 'bash', 'ksh'])
const NON_LOGIN_SHELLS = new Set(['fish', 'sh', 'dash'])

export interface AgentExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface SpawnAgentOptions {
  /** Agent 进程的工作目录 */
  cwd: string
  onStderr?: (chunk: string, stderrTail: string) => void
  onExit?: (exit: AgentExit) => void
}

export interface AgentProcess {
  readonly agentId: string
  readonly child: ChildProcess
  readonly pid: number | undefined
  /** stderr 滚动尾部（最多 8000 字符），用于错误提示 */
  stderrTail(): string
  /** 子进程退出（或启动失败）时 resolve，永不 reject */
  readonly exited: Promise<AgentExit>
  /** SIGTERM，5s 后仍未退出则 SIGKILL */
  kill(): void
  /** 是否仍在运行 */
  running(): boolean
}

/** 单引号包裹；内部单引号替换为 '\'' */
export function shellEscape(arg: string): string {
  if (arg === '') return "''"
  return `'${arg.replace(/'/g, "'\\''")}'`
}

export function expandAppPath(value: string): string {
  if (!value.includes(APP_PATH_TOKEN)) return value
  return value.split(APP_PATH_TOKEN).join(app.getAppPath())
}

/**
 * 挑选启动用的 shell：
 * - $SHELL 是 zsh / bash / ksh → 用登录 shell（-l）
 * - $SHELL 是 fish / sh / dash → 不加 -l（fish 的 -l 语义不同、sh 不需要）
 * - 其它情况探测常见路径
 */
export function resolveUnixShell(): { shell: string, login: boolean } {
  const envShell = process.env.SHELL
  if (envShell) {
    const name = basename(envShell).replace(/\.exe$/i, '')
    if (LOGIN_SHELLS.has(name)) return { shell: envShell, login: true }
    if (NON_LOGIN_SHELLS.has(name)) return { shell: envShell, login: false }
  }

  for (const candidate of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) {
    if (existsSync(candidate)) return { shell: candidate, login: true }
  }

  return { shell: '/bin/sh', login: false }
}

function buildEnv(agent: AcpAgentConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(agent.env ?? {})) {
    env[key] = expandAppPath(value)
  }
  return env
}

export function spawnAgentProcess(agent: AcpAgentConfig, options: SpawnAgentOptions): AgentProcess {
  const command = expandAppPath(agent.command)
  const args = (agent.args ?? []).map(expandAppPath)
  const env = buildEnv(agent)

  let child: ChildProcess
  if (process.platform === 'win32') {
    child = spawn(command, args, { shell: true, stdio: 'pipe', cwd: options.cwd, env })
  } else {
    const { shell, login } = resolveUnixShell()
    const flags = login ? ['-l', '-c'] : ['-c']
    const commandLine = [command, ...args].map(shellEscape).join(' ')
    child = spawn(shell, [...flags, commandLine], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd,
      env
    })
  }

  let tail = ''
  let settled = false
  let resolveExit: (exit: AgentExit) => void = () => undefined
  const exited = new Promise<AgentExit>((resolve) => {
    resolveExit = resolve
  })

  const appendTail = (chunk: string): void => {
    tail = (tail + chunk).slice(-STDERR_TAIL_LIMIT)
    options.onStderr?.(chunk, tail)
  }

  const settle = (exit: AgentExit): void => {
    if (settled) return
    settled = true
    resolveExit(exit)
    options.onExit?.(exit)
  }

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => appendTail(chunk))

  child.on('error', (error: Error) => {
    appendTail(`\n[spawn error] ${error.message}\n`)
    settle({ code: null, signal: null })
  })
  child.once('exit', (code, signal) => settle({ code, signal }))

  return {
    agentId: agent.id,
    child,
    pid: child.pid,
    stderrTail: () => tail,
    exited,
    running: () => !settled && child.exitCode === null && child.signalCode === null,
    kill: () => {
      if (!child.pid) return
      if (settled || child.exitCode !== null || child.signalCode !== null) return

      try {
        child.kill('SIGTERM')
      } catch {
        // 进程可能已消失
      }

      const timer = setTimeout(() => {
        if (settled || child.exitCode !== null || child.signalCode !== null) return
        try {
          child.kill('SIGKILL')
        } catch {
          // 同上
        }
      }, KILL_GRACE_MS)
      timer.unref?.()
    }
  }
}
