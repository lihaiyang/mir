#!/usr/bin/env node
/**
 * MIR Harness 协议自测（离线，不依赖真实模型 / 网络 / 登录）。
 *
 * 做法：
 * 1. 起一个假的 OpenAI 兼容服务（node:http，127.0.0.1 随机端口），按提示词关键词
 *    切换剧本（默认流式 / 工具调用 / slow 取消 / authfail 401），返回 SSE；
 * 2. 用真正的 out/main/agent/index.js 作为被测算子进程（stdio 走 ACP NDJSON），
 *    用临时 HOME + MIR_HARNESS_CONFIG 隔离配置与会话历史；
 * 3. 按 initialize → session/new → prompt 流式 → 工具 → 取消 → 配置/模式 →
 *    session/list + session/load → 无 apiKey → 401 的顺序断言，逐条打印 PASS/FAIL。
 *
 * 运行方式：
 *   npm run build          # 生成 out/main/agent/index.js
 *   node scripts/mir-harness-selftest.mjs
 *
 * 退出码：全部通过 0，否则 1。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'

/* --------------------------------- 环境常量 -------------------------------- */

// resolve() 去掉尾部斜杠：agent 侧对 cwd 做过归一化，断言拿到的路径必须同形
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const agentEntry = join(repoRoot, 'out/main/agent/index.js')
/** 单条断言等待的上限：卡住就判失败，避免自测永远挂住 */
const WATCHDOG_MS = 75_000
/** 默认剧本每帧间隔（毫秒）：20–40ms，肉眼可见的流式节奏 */
const FRAME_DELAY_MIN = 20
const FRAME_DELAY_MAX = 40
/** slow 剧本：40 帧 × 60ms，给取消留出窗口 */
const SLOW_FRAME_COUNT = 40
const SLOW_FRAME_DELAY = 60
/** 会被环境噪声污染的变量：自测要完全接管，不能继承开发者的真实配置 */
const STRIPPED_ENV_KEYS = [
  'MIR_HARNESS_CONFIG',
  'MIR_HARNESS_API_BASE',
  'MIR_HARNESS_API_KEY',
  'MIR_HARNESS_MODEL',
  'MIR_HARNESS_DEBUG'
]
const VERBOSE = process.argv.includes('--verbose')

/* -------------------------------- 断言记录器 -------------------------------- */

let checkCount = 0
const failures = []

function section(title) {
  process.stdout.write(`\n— ${title} —\n`)
}

function pass(label) {
  checkCount += 1
  process.stdout.write(`PASS  ${label}\n`)
}

function fail(label, detail) {
  checkCount += 1
  const suffix = detail === undefined || detail === '' ? '' : `\n        ${String(detail).replaceAll('\n', '\n        ')}`
  failures.push({ label, detail })
  process.stdout.write(`FAIL  ${label}${suffix}\n`)
}

function check(label, condition, detail) {
  if (condition) {
    pass(label)
    return true
  }
  fail(label, detail)
  return false
}

function checkEqual(label, actual, expected) {
  return check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/* --------------------------------- 小工具 --------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function randomFrameDelay() {
  return FRAME_DELAY_MIN + Math.floor(Math.random() * (FRAME_DELAY_MAX - FRAME_DELAY_MIN + 1))
}

function describeError(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function errorCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'number' ? error.code : undefined
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（>${timeoutMs}ms）`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** 轮询等待某个条件成立；返回是否等到了（不抛异常，交给断言决定） */
async function waitFor(predicate, timeoutMs = 3000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(intervalMs)
  }
  return predicate()
}

/* ------------------------------- 假 LLM 服务 ------------------------------- */

/**
 * 按请求里「最后一条 user 消息」的关键词选剧本。
 * 注意 tool 的第二轮：messages 里会出现 role:'tool'，此时一律走 followup。
 */
function pickScenario(messages) {
  const users = messages.filter((message) => message && message.role === 'user')
  const lastUser = users[users.length - 1]
  const text =
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser.content.map((part) => part?.text ?? '').join(' ')
        : ''

  // 只有「最后一条是工具结果」才算工具续轮；历史里残留的 tool 消息不能算，
  // 否则同一会话的后续所有请求都会掉进 followup 剧本
  const lastMessage = messages[messages.length - 1]
  if (lastMessage && lastMessage.role === 'tool') return 'tool-followup'
  if (/authfail/i.test(text)) return 'authfail'
  if (/\bslow\b/i.test(text)) return 'slow'
  if (/\btool\b/i.test(text)) return 'tool-first'
  return 'default'
}

function createSseWriter(response) {
  let closed = false
  response.on('close', () => {
    closed = true
  })

  return {
    get closed() {
      return closed || response.writableEnded
    },
    /** 写一帧 SSE；客户端已断开时返回 false（剧本据此提前收尾） */
    async frame(payload, delayMs = randomFrameDelay()) {
      if (delayMs > 0) await sleep(delayMs)
      if (this.closed) return false
      response.write(`data: ${JSON.stringify(payload)}\n\n`)
      return true
    },
    finish() {
      if (this.closed) return
      response.write('data: [DONE]\n\n')
      response.end()
    }
  }
}

function chunkFrame(delta, finishReason = null, extra = {}) {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra }
}

function usageFrame(promptTokens, completionTokens) {
  return { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } }
}

/** 默认剧本：reasoning → 3 段正文 → usage → stop */
async function playDefault(writer) {
  await writer.frame(chunkFrame({ role: 'assistant', reasoning_content: '用户只是打了个招呼，直接回答即可。' }))
  await writer.frame(chunkFrame({ content: 'Hello' }))
  await writer.frame(chunkFrame({ content: ' from' }))
  await writer.frame(chunkFrame({ content: ' fake model.' }))
  await writer.frame(usageFrame(32, 9))
  await writer.frame(chunkFrame({}, 'stop'))
}

/** 工具剧本第一轮：两帧拼出 read_file({"path":"package.json"})，finish_reason=tool_calls */
async function playToolFirst(writer) {
  await writer.frame(chunkFrame({ role: 'assistant' }))
  await writer.frame(
    chunkFrame({ tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'read_file', arguments: '' } }] })
  )
  await writer.frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"package' } }] }, finish_reason: null }] })
  await writer.frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '.json"}' } }] }, finish_reason: null }] })
  await writer.frame(chunkFrame({}, 'tool_calls'))
}

/** 工具剧本第二轮：看到 role:'tool' 后给出最终文本 */
async function playToolFollowup(writer) {
  await writer.frame(chunkFrame({ content: 'done' }))
  await writer.frame(chunkFrame({ content: ' after' }))
  await writer.frame(chunkFrame({ content: ' tool' }))
  await writer.frame(usageFrame(120, 6))
  await writer.frame(chunkFrame({}, 'stop'))
}

/** 慢剧本：40 帧 × 60ms，用于验证 cancel */
async function playSlow(writer) {
  for (let index = 1; index <= SLOW_FRAME_COUNT; index += 1) {
    const written = await writer.frame(chunkFrame({ content: `chunk ${index} ` }), SLOW_FRAME_DELAY)
    if (!written) return
  }
  await writer.frame(usageFrame(20, SLOW_FRAME_COUNT))
  await writer.frame(chunkFrame({}, 'stop'))
}

async function startFakeLlmServer() {
  const requests = []
  const server = createServer((request, response) => {
    handleRequest(request, response).catch(() => {
      if (!response.writableEnded) response.destroy()
    })
  })
  server.on('clientError', (_error, socket) => socket.destroy())

  async function handleRequest(request, response) {
    const url = request.url ?? ''
    if (request.method !== 'POST' || !url.endsWith('/chat/completions')) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `unknown path ${url}` } }))
      return
    }

    let body = ''
    request.setEncoding('utf8')
    for await (const chunk of request) body += chunk

    let payload = null
    try {
      payload = JSON.parse(body)
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid JSON body' } }))
      return
    }

    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    const scenario = pickScenario(messages)
    requests.push({ scenario, body: payload, at: Date.now() })
    if (VERBOSE) process.stderr.write(`[fake-llm] ${scenario} model=${payload?.model}\n`)

    if (scenario === 'authfail') {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Invalid API key provided', type: 'authentication_error' } }))
      return
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    const writer = createSseWriter(response)
    try {
      if (scenario === 'slow') await playSlow(writer)
      else if (scenario === 'tool-first') await playToolFirst(writer)
      else if (scenario === 'tool-followup') await playToolFollowup(writer)
      else await playDefault(writer)
    } catch {
      // 客户端取消 / 断开是预期路径，安静收尾
    } finally {
      writer.finish()
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    requests,
    port,
    get baseUrl() {
      return `http://127.0.0.1:${port}`
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}

/* --------------------------------- 客户端 --------------------------------- */

/**
 * ACP 客户端：记录所有 session/update，自动批准权限请求，实现 fs 桥。
 * 这里实现的是 MIR 主进程侧协议的「最小可信客户端」，断言只看记录内容。
 */
class RecordingClient {
  constructor() {
    this.updates = []
    this.permissionRequests = []
    this.textFileReads = []
    this.textFileWrites = []
  }

  reset() {
    this.updates.length = 0
    this.permissionRequests.length = 0
    this.textFileReads.length = 0
    this.textFileWrites.length = 0
  }

  async sessionUpdate(params) {
    this.updates.push({
      kind: params?.update?.sessionUpdate ?? 'unknown',
      sessionId: params?.sessionId,
      update: params?.update,
      at: Date.now()
    })
  }

  async requestPermission(params) {
    this.permissionRequests.push(params)
    const options = Array.isArray(params?.options) ? params.options : []
    const allowed = options.find((option) => typeof option?.kind === 'string' && option.kind.startsWith('allow'))
    if (!allowed) return { outcome: { outcome: 'cancelled' } }
    return { outcome: { outcome: 'selected', optionId: allowed.optionId } }
  }

  async readTextFile(params) {
    this.textFileReads.push(params)
    return { content: readFileSync(params.path, 'utf8') }
  }

  async writeTextFile(params) {
    this.textFileWrites.push(params)
    writeFileSync(params.path, params.content, 'utf8')
    return {}
  }

  /** 取某类 update 的列表 */
  ofKind(kind) {
    return this.updates.filter((entry) => entry.kind === kind)
  }

  /** 拼接所有 agent 文本块 */
  text() {
    return this.ofKind('agent_message_chunk')
      .map((entry) => entry.update?.content?.text ?? '')
      .join('')
  }
}

/* ------------------------------ 被测算子进程 ------------------------------ */

class AgentHandle {
  constructor(label, configPath, homeDir) {
    this.label = label
    this.stderr = ''
    this.child = spawn(process.execPath, [agentEntry], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildAgentEnv(configPath, homeDir),
      windowsHide: true
    })

    this.child.stdin.on('error', () => {
      // 子进程先退出时写 stdin 会 EPIPE；这是测试收尾的正常现象
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk
      if (this.stderr.length > 40_000) this.stderr = this.stderr.slice(-40_000)
      if (VERBOSE) process.stderr.write(`[${label}] ${chunk}`)
    })

    this.exit = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => resolve({ code, signal }))
    })

    this.client = new RecordingClient()
    const stream = ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout))
    // 工厂参数是 agent 侧代理；客户端逻辑不直接调用它，只需要 Connection 本身
    this.connection = new ClientSideConnection(() => this.client, stream)
  }

  get alive() {
    return this.child.exitCode === null && this.child.signalCode === null
  }

  async stop() {
    if (!this.alive) return
    this.child.kill('SIGTERM')
    const exited = await Promise.race([this.exit, sleep(3000).then(() => null)])
    if (!exited) this.child.kill('SIGKILL')
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
  }
}

function buildAgentEnv(configPath, homeDir) {
  const env = { ...process.env }
  for (const key of STRIPPED_ENV_KEYS) delete env[key]
  // 临时 HOME：会话历史落到 <tmp>/home/.mir-harness/sessions，不污染本机
  env.HOME = homeDir
  env.MIR_HARNESS_CONFIG = configPath
  return env
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  const startedAt = Date.now()
  process.stdout.write(`MIR Harness 协议自测\n仓库：${repoRoot}\n入口：${agentEntry}\n`)

  if (!existsSync(agentEntry)) {
    process.stderr.write(`\n找不到 ${agentEntry}\n请先执行 \`npm run build\`（约 30s）再跑本脚本。\n`)
    process.exit(1)
  }

  const watchdog = setTimeout(() => {
    process.stdout.write(`\nFAIL  自测整体超时（>${WATCHDOG_MS}ms），强制退出\n`)
    process.exit(1)
  }, WATCHDOG_MS)

  const tempDir = mkdtempSync(join(tmpdir(), 'mir-harness-selftest-'))
  const homeDir = join(tempDir, 'home')
  mkdirSync(homeDir, { recursive: true })

  const fakeLlm = await startFakeLlmServer()
  const configPath = join(tempDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        apiBase: `${fakeLlm.baseUrl}/v1`,
        apiKey: 'test-key',
        model: 'fake-model',
        models: [
          {
            id: 'fake-model',
            name: 'Fake Model',
            reasoningEffort: 'max',
            supportsImages: true,
            contextWindow: 1000000,
            maxTokens: 256
          }
        ],
        systemPrompt: 'You are a test agent. Reply briefly.',
        maxTurns: 4
      },
      null,
      2
    )
  )

  const noAuthConfigPath = join(tempDir, 'config-noauth.json')
  writeFileSync(
    noAuthConfigPath,
    JSON.stringify(
      {
        apiBase: `${fakeLlm.baseUrl}/v1`,
        apiKey: '',
        model: 'fake-model',
        models: [{ id: 'fake-model', name: 'Fake Model' }],
        systemPrompt: 'You are a test agent.'
      },
      null,
      2
    )
  )
  if (VERBOSE) process.stderr.write(`[selftest] temp=${tempDir} fake-llm=${fakeLlm.baseUrl}\n`)

  let agent = null
  let noAuthAgent = null
  let sessionId = null

  try {
    agent = new AgentHandle('main', configPath, homeDir)

    /* ------------------------- 1. initialize ------------------------- */
    section('1. initialize')
    const init = await withTimeout(
      agent.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: 'mir-harness-selftest', title: 'MIR Harness Selftest', version: '0.0.0' }
      }),
      15_000,
      'initialize'
    )
    checkEqual('protocolVersion === PROTOCOL_VERSION', init?.protocolVersion, PROTOCOL_VERSION)
    checkEqual('agentInfo.name === "mir-harness"', init?.agentInfo?.name, 'mir-harness')
    checkEqual('agentCapabilities.loadSession === true', init?.agentCapabilities?.loadSession, true)
    check('agentCapabilities.sessionCapabilities.list 存在', Boolean(init?.agentCapabilities?.sessionCapabilities?.list))
    check('agentCapabilities.sessionCapabilities.resume 存在', Boolean(init?.agentCapabilities?.sessionCapabilities?.resume))
    checkEqual('authMethods[0].id === "config"', init?.authMethods?.[0]?.id, 'config')

    /* ------------------------- 2. session/new ------------------------ */
    section('2. session/new')
    const session = await withTimeout(agent.connection.newSession({ cwd: repoRoot, mcpServers: [] }), 15_000, 'session/new')
    sessionId = session?.sessionId
    check('session/new 返回非空 sessionId', typeof sessionId === 'string' && sessionId.length > 0, `got ${JSON.stringify(sessionId)}`)

    const modes = session?.modes
    checkEqual('modes.currentModeId === "ask"', modes?.currentModeId, 'ask')
    const modeIds = (modes?.availableModes ?? []).map((mode) => mode.id)
    check('availableModes 含 ask 与 code', modeIds.includes('ask') && modeIds.includes('code'), `got ${JSON.stringify(modeIds)}`)

    const configOptions = Array.isArray(session?.configOptions) ? session.configOptions : []
    const modelOption = configOptions.find((option) => option.id === 'model')
    const modelValues = (modelOption?.options ?? []).map((option) => option?.value ?? option?.options?.map((inner) => inner.value))
    checkEqual('configOptions.model.currentValue === "fake-model"', modelOption?.currentValue, 'fake-model')
    check('configOptions.model.options 含 fake-model', JSON.stringify(modelValues).includes('fake-model'), `got ${JSON.stringify(modelValues)}`)

    const thoughtOption = configOptions.find((option) => option.id === 'thought_level')
    check(
      'configOptions.thought_level.currentValue ∈ high/max',
      ['high', 'max'].includes(thoughtOption?.currentValue),
      `got ${JSON.stringify(thoughtOption?.currentValue)}`
    )
    checkEqual('configOptions.thought_level 使用模型配置的 max', thoughtOption?.currentValue, 'max')

    const commandsArrived = await waitFor(() => agent.client.ofKind('available_commands_update').length > 0, 3000)
    check('session/new 后收到 available_commands_update', commandsArrived, '3s 内没有收到')
    const commandNames = (agent.client.ofKind('available_commands_update')[0]?.update?.availableCommands ?? []).map(
      (command) => command?.name
    )
    check('availableCommands 含 clear', commandNames.includes('clear'), `got ${JSON.stringify(commandNames)}`)

    /* --------------------- 3. prompt 流式回答 ------------------------ */
    section('3. prompt 流式回答')
    agent.client.reset()
    const answer = await withTimeout(
      agent.connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] }),
      20_000,
      "prompt('hi')"
    )
    checkEqual('prompt 返回 stopReason "end_turn"', answer?.stopReason, 'end_turn')
    const thoughtChunks = agent.client.ofKind('agent_thought_chunk')
    const textChunks = agent.client.ofKind('agent_message_chunk')
    check('收到 ≥1 个 agent_thought_chunk', thoughtChunks.length >= 1, `got ${thoughtChunks.length}`)
    check('收到 ≥2 个 agent_message_chunk', textChunks.length >= 2, `got ${textChunks.length}`)
    checkEqual('拼接文本 === "Hello from fake model."', agent.client.text(), 'Hello from fake model.')

    const usageUpdate = agent.client.ofKind('usage_update')[0]?.update
    check(
      '收到 usage_update 且 used / size 为正',
      typeof usageUpdate?.used === 'number' && usageUpdate.used > 0 && typeof usageUpdate?.size === 'number' && usageUpdate.size > 0,
      `got ${JSON.stringify(usageUpdate)}`
    )

    const textGaps = textChunks.slice(1).map((entry, index) => entry.at - textChunks[index].at)
    check('文本 chunk 之间存在间隔（证明是流式而非一次性返回）', textGaps.some((gap) => gap >= 5), `gaps=${JSON.stringify(textGaps)}`)

    /* ------------------------ 4. 工具调用 --------------------------- */
    section('4. 工具调用')
    agent.client.reset()
    const toolAnswer = await withTimeout(
      agent.connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'please use the tool to read package.json' }] }),
      25_000,
      'prompt(tool)'
    )
    checkEqual('tool 剧本 stopReason "end_turn"', toolAnswer?.stopReason, 'end_turn')

    const toolCall = agent.client.ofKind('tool_call').find((entry) => entry.update?.kind === 'read')
    check('收到 tool_call（kind === "read"）', Boolean(toolCall), `updates=${JSON.stringify(agent.client.updates.map((entry) => entry.kind))}`)
    const toolCallId = toolCall?.update?.toolCallId
    const toolCompleted = agent.client
      .ofKind('tool_call_update')
      .find((entry) => entry.update?.toolCallId === toolCallId && entry.update?.status === 'completed')
    check('收到同名 tool_call_update（status completed）', Boolean(toolCompleted))
    check('最终文本含 "done after tool"', agent.client.text().includes('done after tool'), `got ${JSON.stringify(agent.client.text())}`)
    check(
      '假服务收到工具续轮请求（role:"tool"）',
      fakeLlm.requests.some((entry) => entry.scenario === 'tool-followup'),
      `scenarios=${JSON.stringify(fakeLlm.requests.map((entry) => entry.scenario))}`
    )
    if (agent.client.permissionRequests.length > 0) {
      process.stdout.write(`      （note：read_file 也走了一次权限询问，已自动批准）\n`)
    }

    /* ------------------------- 5. 取消 ----------------------------- */
    section('5. 取消')
    agent.client.reset()
    const slowStartedAt = Date.now()
    const slowPromise = agent.connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'please go slow now' }] })
    await sleep(200)
    await agent.connection.cancel({ sessionId })
    let cancelResult = null
    let cancelFailure = null
    try {
      cancelResult = await withTimeout(slowPromise, 3000, 'cancel 后 prompt')
    } catch (error) {
      cancelFailure = error
    }
    check('cancel 后 prompt 在 3s 内 resolve', cancelFailure === null, cancelFailure ? describeError(cancelFailure) : '')
    checkEqual('stopReason === "cancelled"', cancelResult?.stopReason, 'cancelled')
    process.stdout.write(`      （取消耗时 ${Date.now() - slowStartedAt}ms）\n`)

    /* --------------------- 6. 配置项 / 模式切换 ---------------------- */
    section('6. 配置项 / 模式切换')
    const configResult = await withTimeout(
      agent.connection.setSessionConfigOption({ sessionId, configId: 'thought_level', value: 'high' }),
      10_000,
      'setSessionConfigOption'
    )
    const updatedThought = (configResult?.configOptions ?? []).find((option) => option.id === 'thought_level')
    checkEqual('setSessionConfigOption 返回 thought_level.currentValue === "high"', updatedThought?.currentValue, 'high')

    agent.client.reset()
    await withTimeout(agent.connection.setSessionMode({ sessionId, modeId: 'code' }), 10_000, 'setSessionMode')
    const modeUpdateArrived = await waitFor(() => agent.client.ofKind('current_mode_update').length > 0, 3000)
    check('setSessionMode 后收到 current_mode_update', modeUpdateArrived)
    checkEqual(
      'current_mode_update.currentModeId === "code"',
      agent.client.ofKind('current_mode_update')[0]?.update?.currentModeId,
      'code'
    )

    let invalidConfigError = null
    try {
      await withTimeout(
        agent.connection.setSessionConfigOption({ sessionId, configId: 'thought_level', value: 'bogus' }),
        10_000,
        'setSessionConfigOption(bogus)'
      )
    } catch (error) {
      invalidConfigError = error
    }
    check('非法 thought_level 返回 JSON-RPC error', Boolean(invalidConfigError), '未抛错')
    checkEqual('非法 thought_level error.code === -32602', errorCode(invalidConfigError), -32602)

    /* -------------------- 7. session/list + session/load ------------ */
    section('7. session/list + session/load')
    const list = await withTimeout(agent.connection.listSessions({ cwd: repoRoot }), 10_000, 'listSessions')
    const listedSessions = Array.isArray(list?.sessions) ? list.sessions : []
    check('session/list 返回 ≥1 条会话', listedSessions.length >= 1, `got ${listedSessions.length}`)
    const listed = listedSessions.find((entry) => entry.sessionId === sessionId)
    check('session/list 包含当前会话', Boolean(listed))
    checkEqual('列表项 cwd === 仓库根目录', listed?.cwd, repoRoot)

    agent.client.reset()
    const loaded = await withTimeout(
      agent.connection.loadSession({ sessionId, cwd: repoRoot, mcpServers: [] }),
      15_000,
      'loadSession'
    )
    check('session/load 返回 configOptions', Array.isArray(loaded?.configOptions) && loaded.configOptions.length > 0)
    check('session/load 响应不含 sessionId（协议约定）', !('sessionId' in (loaded ?? {})))
    check('session/load 回放 user_message_chunk', agent.client.ofKind('user_message_chunk').length >= 1)
    check('session/load 回放 agent_message_chunk', agent.client.ofKind('agent_message_chunk').length >= 1)

    /* --------------------- 8. 无 apiKey 的会话 ----------------------- */
    section('8. 无 apiKey（auth required）')
    noAuthAgent = new AgentHandle('noauth', noAuthConfigPath, homeDir)
    const noAuthInit = await withTimeout(
      noAuthAgent.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'mir-harness-selftest', version: '0.0.0' }
      }),
      15_000,
      'noauth initialize'
    )
    checkEqual('无 apiKey 时 initialize 仍成功', noAuthInit?.protocolVersion, PROTOCOL_VERSION)

    let noAuthError = null
    try {
      await withTimeout(noAuthAgent.connection.newSession({ cwd: repoRoot, mcpServers: [] }), 10_000, 'noauth session/new')
    } catch (error) {
      noAuthError = error
    }
    check('无 apiKey 时 session/new 抛错', Boolean(noAuthError), '未抛错')
    checkEqual('auth required error.code === -32000', errorCode(noAuthError), -32000)
    check('auth 错误信息非空', typeof noAuthError?.message === 'string' && noAuthError.message.length > 0)

    /* --------------------------- 9. LLM 401 -------------------------- */
    section('9. 模型接口 401')
    agent.client.reset()
    let authFailError = null
    try {
      await withTimeout(
        agent.connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'please authfail now' }] }),
        15_000,
        'prompt(authfail)'
      )
    } catch (error) {
      authFailError = error
    }
    check('401 时 prompt 抛错', Boolean(authFailError), '未抛错')
    check(
      '错误信息含提示（鉴权 / API Key / 401）',
      /鉴权|API Key|密钥|401/i.test(String(authFailError?.message ?? '')),
      `message=${JSON.stringify(authFailError?.message)}`
    )
    check('错误带数字 code', typeof errorCode(authFailError) === 'number', `code=${JSON.stringify(errorCode(authFailError))}`)
    process.stdout.write(`      （401 错误 code=${errorCode(authFailError)} message=${JSON.stringify(authFailError?.message)}）\n`)
    check('401 后 agent 进程仍存活', agent.alive)

    const retry = await withTimeout(
      agent.connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi again' }] }),
      20_000,
      'prompt after 401'
    )
    checkEqual('401 之后正常提示仍能 end_turn', retry?.stopReason, 'end_turn')
    checkEqual('401 之后文本仍正确', agent.client.text(), 'Hello from fake model.')
  } catch (error) {
    fail('自测流程未中断', `${describeError(error)}\n${error instanceof Error ? (error.stack ?? '') : ''}`)
  } finally {
    await agent?.stop()
    await noAuthAgent?.stop()
    await fakeLlm.close()
    rmSync(tempDir, { recursive: true, force: true })
    clearTimeout(watchdog)
  }

  /* --------------------------------- 汇总 --------------------------------- */

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)
  process.stdout.write('\n' + '─'.repeat(60) + '\n')
  if (failures.length === 0) {
    process.stdout.write(`ALL PASS — ${checkCount} checks in ${elapsed}s\n`)
  } else {
    process.stdout.write(`FAILED ${failures.length}/${checkCount} checks in ${elapsed}s\n`)
    for (const failure of failures) process.stdout.write(`  · ${failure.label}\n`)
    const stderr = (agent?.stderr ?? '').trim()
    if (stderr) process.stdout.write(`\nagent stderr（末尾 4000 字）：\n${stderr.slice(-4000)}\n`)
    const requests = fakeLlm.requests.map((entry) => entry.scenario).join(', ')
    process.stdout.write(`\n假服务收到的剧本序列：${requests || '(空)'}\n`)
  }
  process.stdout.write(`临时目录：${tempDir}（已清理）\n`)

  // 显式 flush 再把退出码交出去，避免 summary 被截断
  await new Promise((resolve) => process.stdout.write('', resolve))
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`自测启动失败：${describeError(error)}\n${error instanceof Error ? (error.stack ?? '') : ''}\n`)
  process.exit(1)
})
