/**
 * 客户端侧终端方法：Agent 通过它们执行命令并读取输出。
 *
 * 每个终端累积 stdout+stderr，超过 outputByteLimit（默认 1MB）时从头部截断。
 * 终端状态在 releaseTerminal 或进程退出后清理，等待方必须始终能拿到结果。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse
} from '@agentclientprotocol/sdk'

const DEFAULT_OUTPUT_LIMIT = 1024 * 1024
const KILL_GRACE_MS = 2000

interface TerminalExitStatus {
  exitCode?: number | null
  signal?: string | null
}

interface TerminalState {
  child: ChildProcess
  output: string
  truncated: boolean
  limit: number
  exitStatus: TerminalExitStatus | null
  exited: Promise<void>
  settleExit: () => void
}

const terminals = new Map<string, TerminalState>()
let terminalSeq = 0

function getTerminal(terminalId: string): TerminalState {
  const state = terminals.get(terminalId)
  if (!state) throw new Error(`unknown terminal: ${terminalId}`)
  return state
}

function appendOutput(state: TerminalState, chunk: string): void {
  state.output += chunk
  if (state.output.length <= state.limit) return
  state.output = state.output.slice(state.output.length - state.limit)
  state.truncated = true
}

function killTerminalProcess(state: TerminalState): void {
  const { child } = state
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程已消失
      }
    }
  }, KILL_GRACE_MS)
  timer.unref?.()
}

export async function createTerminal(
  params: CreateTerminalRequest
): Promise<CreateTerminalResponse> {
  const limit =
    typeof params.outputByteLimit === 'number' && params.outputByteLimit > 0
      ? params.outputByteLimit
      : DEFAULT_OUTPUT_LIMIT

  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const variable of params.env ?? []) {
    env[variable.name] = variable.value
  }

  const child = spawn(params.command, params.args ?? [], {
    cwd: params.cwd ?? undefined,
    env,
    shell: true,
    stdio: 'pipe'
  })

  let settleExit: () => void = () => undefined
  const exited = new Promise<void>((resolve) => {
    settleExit = resolve
  })

  const state: TerminalState = {
    child,
    output: '',
    truncated: false,
    limit,
    exitStatus: null,
    exited,
    settleExit
  }

  const finish = (status: TerminalExitStatus): void => {
    if (state.exitStatus) return
    state.exitStatus = status
    state.settleExit()
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => appendOutput(state, chunk))
  child.stderr?.on('data', (chunk: string) => appendOutput(state, chunk))
  child.on('error', () => finish({ exitCode: null, signal: null }))
  child.on('close', (code, signal) => finish({ exitCode: code, signal }))

  terminalSeq += 1
  const terminalId = `term_${terminalSeq}`
  terminals.set(terminalId, state)
  return { terminalId }
}

export async function terminalOutput(
  params: TerminalOutputRequest
): Promise<TerminalOutputResponse> {
  const state = getTerminal(params.terminalId)
  const response: TerminalOutputResponse = { output: state.output, truncated: state.truncated }
  if (state.exitStatus) response.exitStatus = state.exitStatus
  return response
}

export async function waitForTerminalExit(
  params: WaitForTerminalExitRequest
): Promise<WaitForTerminalExitResponse> {
  const state = getTerminal(params.terminalId)
  await state.exited
  return {
    exitCode: state.exitStatus?.exitCode ?? null,
    signal: state.exitStatus?.signal ?? null
  }
}

export async function killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
  const state = getTerminal(params.terminalId)
  killTerminalProcess(state)
  return {}
}

export async function releaseTerminal(
  params: ReleaseTerminalRequest
): Promise<ReleaseTerminalResponse> {
  const state = terminals.get(params.terminalId)
  if (!state) return {}
  killTerminalProcess(state)
  terminals.delete(params.terminalId)
  return {}
}

/** 主进程退出 / Agent 断开时清空所有终端，避免残留子进程 */
export function disposeAllTerminals(): void {
  for (const state of terminals.values()) {
    killTerminalProcess(state)
    state.settleExit()
  }
  terminals.clear()
}
