/**
 * 把一个 Agent 子进程包装成 ACP 连接：NDJSON 流 + initialize 握手。
 *
 * 只在 logTraffic 打开时挂 tap，避免正常运行时每条消息都做一次 JSON.parse。
 */
import { Readable, Writable } from 'node:stream'
import { app } from 'electron'
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'
import type {
  AgentCapabilities,
  AuthMethod,
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import { spawnAgentProcess } from './agentProcess'
import type { AgentExit, AgentProcess } from './agentProcess'
import { AcpClient } from './client'
import type {
  AcpAgentCapabilities,
  AcpAgentConfig,
  AcpAuthMethod,
  AcpTrafficEntry
} from '../../shared/acp'

const INITIALIZE_TIMEOUT_MS = 30_000
const TRAFFIC_LIMIT = 200

let trafficSeq = 0
const trafficLog: AcpTrafficEntry[] = []

/** 最近的 JSON-RPC 流量（logTraffic 打开时才有内容） */
export function getTraffic(): AcpTrafficEntry[] {
  return [...trafficLog]
}

export function clearTraffic(): void {
  trafficLog.length = 0
}

function pushTraffic(
  direction: AcpTrafficEntry['direction'],
  agentId: string,
  line: string
): void {
  let label = line.slice(0, 80)
  let payload: unknown = line
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    payload = parsed
    const method = typeof parsed.method === 'string' ? parsed.method : undefined
    if (method) label = method
    else if (parsed.id !== undefined) label = `#${String(parsed.id)}`
  } catch {
    // 非 JSON 行原样保留，便于排错
  }

  trafficSeq += 1
  trafficLog.push({
    id: trafficSeq,
    at: Date.now(),
    direction,
    agentId,
    label,
    payload
  })
  if (trafficLog.length > TRAFFIC_LIMIT) {
    trafficLog.splice(0, trafficLog.length - TRAFFIC_LIMIT)
  }
}

/** 按行切分，处理跨 chunk 的半行 */
function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) onLine(line)
      index = buffer.indexOf('\n')
    }
  }
}

function tapReadable(
  source: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        onChunk(decoder.decode(value, { stream: true }))
        controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    }
  })
}

function tapWritable(
  target: WritableStream<Uint8Array>,
  onChunk: (chunk: string) => void
): WritableStream<Uint8Array> {
  const writer = target.getWriter()
  const decoder = new TextDecoder()
  return new WritableStream<Uint8Array>({
    write(chunk) {
      onChunk(decoder.decode(chunk, { stream: true }))
      return writer.write(chunk)
    },
    close() {
      return writer.close()
    },
    abort(reason) {
      return writer.abort(reason)
    }
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

export function mapAgentCapabilities(raw: AgentCapabilities | undefined | null): AcpAgentCapabilities {
  return {
    loadSession: raw?.loadSession === true,
    listSessions: Boolean(raw?.sessionCapabilities?.list),
    resumeSession: Boolean(raw?.sessionCapabilities?.resume),
    promptImages: raw?.promptCapabilities?.image === true,
    promptAudio: raw?.promptCapabilities?.audio === true,
    promptEmbeddedContext: raw?.promptCapabilities?.embeddedContext === true,
    // MIR 总是向 Agent 声明 terminal 能力，这里表示可以渲染 / 控制 Agent 发起的终端
    terminal: true
  }
}

export function mapAuthMethods(methods: AuthMethod[] | undefined | null): AcpAuthMethod[] {
  return (methods ?? []).map((method) => {
    const mapped: AcpAuthMethod = { id: method.id, name: method.name }
    if (typeof method.description === 'string' && method.description) {
      mapped.description = method.description
    }
    return mapped
  })
}

export interface OpenAcpConnectionOptions {
  agent: AcpAgentConfig
  cwd: string
  logTraffic: boolean
  onStderr: (chunk: string, stderrTail: string) => void
  onExit: (exit: AgentExit) => void
  onSessionUpdate: (notification: SessionNotification) => void
  requestPermission: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>
}

export interface AcpConnectionHandle {
  proc: AgentProcess
  connection: ClientSideConnection
  capabilities: AcpAgentCapabilities
  authMethods: AcpAuthMethod[]
  agentInfo?: { name: string, version?: string }
  protocolVersion: number
}

export async function openAcpConnection(
  options: OpenAcpConnectionOptions
): Promise<AcpConnectionHandle> {
  const proc = spawnAgentProcess(options.agent, {
    cwd: options.cwd,
    onStderr: options.onStderr,
    onExit: options.onExit
  })

  const stdin = proc.child.stdin
  const stdout = proc.child.stdout
  if (!stdin || !stdout) {
    proc.kill()
    throw new Error(`agent ${options.agent.id} has no stdio pipe`)
  }

  const writable = Writable.toWeb(stdin) as unknown as WritableStream<Uint8Array>
  const readable = Readable.toWeb(stdout) as unknown as ReadableStream<Uint8Array>

  const client = new AcpClient({
    agentId: options.agent.id,
    onSessionUpdate: options.onSessionUpdate,
    requestPermission: options.requestPermission
  })

  // tap 挂在字节流上（ndJsonStream 之后拿到的是已解析的 JSON-RPC 对象流）
  const agentId = options.agent.id
  const tappedWritable = options.logTraffic
    ? tapWritable(writable, createLineSplitter((line) => pushTraffic('send', agentId, line)))
    : writable
  const tappedReadable = options.logTraffic
    ? tapReadable(readable, createLineSplitter((line) => pushTraffic('receive', agentId, line)))
    : readable
  const stream = ndJsonStream(tappedWritable, tappedReadable)

  const connection = new ClientSideConnection((agent) => {
    client.setAgent(agent)
    return client
  }, stream)

  let init: InitializeResponse
  try {
    init = await withTimeout(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'mir', version: app.getVersion() },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true
        }
      }),
      INITIALIZE_TIMEOUT_MS,
      'agent did not respond to initialize'
    )
  } catch (error) {
    proc.kill()
    throw error
  }

  const agentInfo = init.agentInfo
    ? { name: init.agentInfo.name, ...(init.agentInfo.version ? { version: init.agentInfo.version } : {}) }
    : undefined

  return {
    proc,
    connection,
    capabilities: mapAgentCapabilities(init.agentCapabilities),
    authMethods: mapAuthMethods(init.authMethods),
    agentInfo,
    protocolVersion: init.protocolVersion
  }
}
