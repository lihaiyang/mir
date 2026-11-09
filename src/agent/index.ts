/**
 * MIR Harness agent 进程入口。
 *
 * MIR 用 `ELECTRON_RUN_AS_NODE=1 {{EXEC_PATH}} out/main/agent/index.js` 拉起本进程，
 * 之后通过 stdio 上的 NDJSON 帧（JSON-RPC 2.0）驱动它。因此这里只做三件事：
 *
 * 1. 把 stdin / stdout 包成 ACP 的流，装配 `AgentSideConnection`；
 * 2. 把日志全部写 stderr —— stdout 是协议通道，多写一个字节都会破坏帧；
 * 3. 兜住进程级异常与退出信号：ACP 连接活着就绝不因为一次异常退出（编辑器会显示「启动失败」），
 *    对端关闭（stdin end）或收到 SIGTERM/SIGINT 时才干净地 exit(0)。
 */
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'
import { HarnessAgent } from './agent'

const DEBUG_ENABLED = process.env.MIR_HARNESS_DEBUG === '1' || process.env.MIR_HARNESS_DEBUG === 'true'

/** ACP 连接是否已经建立（决定 uncaughtException 是「记日志继续」还是「退出」） */
let connected = false
let shuttingDown = false

function log(line: string): void {
  try {
    process.stderr.write(`[mir-harness] ${line}\n`)
  } catch {
    // stderr 也可能被父进程关掉，此时安静丢弃，绝不能因此抛异常
  }
}

function debug(line: string): void {
  if (DEBUG_ENABLED) log(line)
}

function shutdown(code: number, reason: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log(`exiting(${code})：${reason}`)
  // 让已经排队到 stdout 的 JSON-RPC 帧先写出去，再真正退出
  setTimeout(() => process.exit(code), 0)
}

function main(): void {
  const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))

  // 构造函数会同步回调，HarnessAgent 就在这里被创建
  new AgentSideConnection((connection) => {
    connected = true
    log(`ready (pid=${process.pid}, protocolVersion=${PROTOCOL_VERSION}, debug=${DEBUG_ENABLED ? 'on' : 'off'})`)
    return new HarnessAgent(connection)
  }, stream)

  /* ------------------------------ stdin / 对端关闭 ----------------------------- */

  process.stdin.on('end', () => shutdown(0, 'stdin end'))
  process.stdin.on('close', () => shutdown(0, 'stdin close'))
  process.stdin.on('error', (error) => {
    log(`stdin error: ${describe(error)}`)
    shutdown(0, 'stdin error')
  })

  /* ---------------------------------- 信号 ---------------------------------- */

  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'))
  process.on('SIGINT', () => shutdown(0, 'SIGINT'))

  /* -------------------------------- 兜底异常 --------------------------------- */

  process.on('uncaughtException', (error) => {
    log(`uncaughtException: ${describe(error)}\n${stackOf(error)}`)
    // 连接建立之后出现异常：保持进程存活，让 MIR 侧看到「本轮失败」而不是「Agent 崩溃」；
    // 建立之前就崩说明进程根本起不来，直接退出，避免留一个半死进程。
    if (!connected) shutdown(1, 'uncaughtException before connection')
  })

  process.on('unhandledRejection', (reason) => {
    log(`unhandledRejection: ${describe(reason)}\n${stackOf(reason)}`)
    // 未处理的 rejection 只可能是某次通知 / 工具竞速的尾巴，不影响协议循环，记日志即可
  })

  /* -------------------------------- stdout 异常 ------------------------------- */

  // 父进程关掉管道后再写 stdout 会触发 EPIPE；此时协议已经不可用，直接退出
  process.stdout.on('error', (error) => {
    log(`stdout error: ${describe(error)}`)
    shutdown(0, 'stdout error')
  })
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function stackOf(error: unknown): string {
  if (error instanceof Error) return error.stack ?? '(no stack)'
  return '(no stack)'
}

main()
