/**
 * OpenAI 兼容 /chat/completions 的流式客户端。
 *
 * 只用全局 fetch + TextDecoder 手写 SSE 解析：不引第三方依赖，也不假设网关
 * 一定按最规范的方式分包（换行可能跨 chunk、可能夹注释心跳、可能带私有字段）。
 *
 * 事件映射（见 types.ts 的 LlmEvent）：
 * - delta.content           → text
 * - delta.reasoning_content → reasoning（部分网关用 delta.reasoning）
 * - delta.tool_calls        → toolCall（按 index 增量拼装，由上层累积）
 * - 顶层 / 末尾 chunk 的 usage → usage
 * - finish_reason / 流结束   → finish
 */
import { LlmError } from './types'
import type { ChatMessage, LlmClient, LlmEvent, LlmRequest, LlmUsage, ToolSpec } from './types'

/** 非 2xx 时带回的错误正文上限（字符），避免把整页 HTML 塞进错误里 */
const ERROR_BODY_LIMIT = 4096
/** SSE 的流结束标记 */
const SSE_DONE = '[DONE]'

/* -------------------------------- 通用工具 ------------------------------- */

/** 统一的取消错误：上层约定用 name === 'AbortError' 判定「用户取消」 */
function createAbortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 错误链里的原因（Node 的 fetch 失败真正原因在 cause 上，如 ECONNREFUSED） */
function describeCause(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? error.cause.message : undefined
  return cause && cause !== error.message ? `${error.message}（${cause}）` : error.message
}

/* ------------------------------- 请求构造 ------------------------------- */

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface OpenAiMessage {
  role: string
  /** 纯文本消息用字符串；带图片的用户消息用 content parts 数组 */
  content: string | OpenAiContentPart[]
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

/**
 * ChatMessage → OpenAI 消息。
 *
 * - assistant 带 toolCalls 时输出 tool_calls，content 保留（可以是空字符串）；
 * - role === 'tool' 时用 tool_call_id 关联回对应的调用；
 * - user 带图片时转成 content parts（text + image_url data URL）；
 * - reasoning 只用于回放 / 展示，不回传给模型（多数接口会直接 400）。
 */
function toOpenAiMessages(messages: ChatMessage[]): OpenAiMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId ?? ''
      }
    }

    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments }
        }))
      }
    }

    if (message.role === 'user' && message.images && message.images.length > 0) {
      const parts: OpenAiContentPart[] = []
      if (message.content.trim()) parts.push({ type: 'text', text: message.content })
      for (const image of message.images) {
        if (!image || !image.data) continue
        const mimeType = image.mimeType || 'image/png'
        parts.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${image.data}` } })
      }
      if (parts.length > 0) return { role: 'user', content: parts }
    }

    return { role: message.role, content: message.content }
  })
}

function chatCompletionsUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, '')}/chat/completions`
}

interface RequestBodyOptions {
  /** 是否带 stream_options.include_usage（部分网关不认，需要重试去掉） */
  includeUsage: boolean
  /** 是否带 reasoning_effort（部分网关不认，需要重试去掉） */
  includeReasoning: boolean
}

function buildRequestBody(request: LlmRequest, options: RequestBodyOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOpenAiMessages(request.messages),
    stream: true
  }

  if (Number.isFinite(request.maxTokens) && request.maxTokens > 0) body.max_tokens = request.maxTokens

  const tools: ToolSpec[] = request.tools ?? []
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }))
  }

  // high / max 两档都直接传；不认这个字段的网关会 400，由 openStream 去掉重试
  if (options.includeReasoning) body.reasoning_effort = request.reasoningEffort

  if (options.includeUsage) body.stream_options = { include_usage: true }

  return body
}

async function postChatCompletions(
  request: LlmRequest,
  body: Record<string, unknown>
): Promise<Response> {
  try {
    return await fetch(chatCompletionsUrl(request.apiBase), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`
      },
      body: JSON.stringify(body),
      signal: request.signal
    })
  } catch (error) {
    if (request.signal.aborted || isAbortError(error)) throw createAbortError()
    throw new LlmError(`模型接口请求失败：${describeCause(error)}`, { cause: error })
  }
}

/** 400 时依次去掉可选字段重试：先去掉 stream_options，再去掉 reasoning_effort */
const RETRY_ATTEMPTS: RequestBodyOptions[] = [
  { includeUsage: true, includeReasoning: true },
  { includeUsage: false, includeReasoning: true },
  { includeUsage: true, includeReasoning: false }
]

/**
 * 发起流式请求，返回响应交给调用方判断状态码。
 *
 * 个别网关不认 stream_options.include_usage 或 reasoning_effort 会直接回 400，
 * 这时逐个去掉可选字段重试；都不是 400 就原样返回（错误正文交给上层）。
 */
async function openStream(request: LlmRequest): Promise<Response> {
  let last: Response | null = null
  for (const attempt of RETRY_ATTEMPTS) {
    const response = await postChatCompletions(request, buildRequestBody(request, attempt))
    if (response.status !== 400) return response
    last = response
    try {
      await response.body?.cancel()
    } catch {
      // 取消失败无所谓：下面本来就要重发请求
    }
  }
  return last as Response
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, ERROR_BODY_LIMIT)
  } catch {
    return ''
  }
}

/* -------------------------------- SSE 解析 ------------------------------- */

/**
 * 解析一行 SSE，返回 `data:` 的负载；没有可处理内容时返回 undefined。
 *
 * 空行（事件分隔）、`:` 开头的注释（如 `: heartbeat`）、`event:` / `id:` /
 * `retry:` 字段一律忽略——只需要 payload。
 */
function parseSseLine(line: string): string | undefined {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!text || text.startsWith(':')) return undefined
  if (!text.startsWith('data:')) return undefined
  const payload = text.slice('data:'.length).trim()
  return payload || undefined
}

/**
 * 逐条吐出 SSE 的 data 负载。
 *
 * 自己处理跨 chunk 的半行与 UTF-8 半个字符；abort 时立刻取消 reader，
 * 让挂起的 read() 返回，而不是等网关把流写完。
 */
async function* iterateSsePayloads(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  const body = response.body
  if (!body) return

  const reader = body.getReader()
  const decoder = new TextDecoder()
  const cancelOnAbort = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancelOnAbort)

  let buffer = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let lineBreak = buffer.indexOf('\n')
      while (lineBreak >= 0) {
        const payload = parseSseLine(buffer.slice(0, lineBreak))
        buffer = buffer.slice(lineBreak + 1)
        if (payload === SSE_DONE) return
        if (payload) yield payload
        if (signal.aborted) throw createAbortError()
        lineBreak = buffer.indexOf('\n')
      }
    }

    if (signal.aborted) throw createAbortError()

    // 最后一行可能没有以换行结尾（有的网关直接关连接）
    buffer += decoder.decode()
    const tail = parseSseLine(buffer)
    if (tail && tail !== SSE_DONE) yield tail
  } catch (error) {
    // 取消 / 网络中断（如 ECONNRESET）都在这里收口
    if (signal.aborted || isAbortError(error)) throw createAbortError()
    if (error instanceof LlmError) throw error
    throw new LlmError(`读取模型响应失败：${describeCause(error)}`, { cause: error })
  } finally {
    signal.removeEventListener('abort', cancelOnAbort)
    try {
      await reader.cancel()
    } catch {
      // 流已经结束时 cancel 可能抛错，忽略
    }
  }
}

/* -------------------------------- chunk 解析 ------------------------------ */

interface ParsedToolCallDelta {
  index: number
  id?: string
  name?: string
  argumentsDelta?: string
}

interface ParsedChunk {
  text?: string
  reasoning?: string
  toolCalls: ParsedToolCallDelta[]
  usage?: LlmUsage
  finishReason?: string
}

/**
 * 解析一条 data JSON。
 * 不是 JSON / 不是对象时返回 undefined（网关的私有帧直接忽略，不打断整轮对话）。
 */
function parseChunk(payload: string): ParsedChunk | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(payload)
  } catch {
    return undefined
  }

  const root = asRecord(raw)
  if (!root) return undefined

  const parsed: ParsedChunk = { toolCalls: [] }
  const choice = asRecord(asArray(root.choices)?.[0])
  const delta = choice ? asRecord(choice.delta) : undefined

  if (delta) {
    const text = asString(delta.content)
    if (text) parsed.text = text

    // deepseek 等网关用 reasoning_content，部分网关用 reasoning
    const reasoning = asString(delta.reasoning_content) ?? asString(delta.reasoning)
    if (reasoning) parsed.reasoning = reasoning

    for (const item of asArray(delta.tool_calls) ?? []) {
      const call = asRecord(item)
      if (!call) continue
      const fn = asRecord(call.function)
      const deltaCall: ParsedToolCallDelta = { index: asNumber(call.index) ?? 0 }
      // 只带本帧真正出现的字段，上层按 index 累积
      const id = asString(call.id)
      if (id) deltaCall.id = id
      const name = fn ? asString(fn.name) : undefined
      if (name) deltaCall.name = name
      const args = fn ? asString(fn.arguments) : undefined
      if (args) deltaCall.argumentsDelta = args
      parsed.toolCalls.push(deltaCall)
    }
  }

  const finishReason = choice ? asString(choice.finish_reason) : undefined
  if (finishReason) parsed.finishReason = finishReason

  const usage = asRecord(root.usage)
  if (usage) {
    parsed.usage = {
      inputTokens: asNumber(usage.prompt_tokens) ?? 0,
      outputTokens: asNumber(usage.completion_tokens) ?? 0
    }
  }

  return parsed
}

/* --------------------------------- 主流程 -------------------------------- */

/** 一次流式对话：请求 → SSE → LlmEvent；取消时抛 AbortError，接口错误抛 LlmError */
async function* streamChatCompletion(request: LlmRequest): AsyncGenerator<LlmEvent, void, void> {
  if (request.signal.aborted) throw createAbortError()

  const response = await openStream(request)
  if (!response.ok) {
    const body = await readErrorBody(response)
    throw new LlmError(`模型接口返回 HTTP ${response.status}`, { status: response.status, body })
  }

  let finishReason: string | undefined

  for await (const payload of iterateSsePayloads(response, request.signal)) {
    const chunk = parseChunk(payload)
    if (!chunk) continue

    if (chunk.text) yield { type: 'text', text: chunk.text }
    if (chunk.reasoning) yield { type: 'reasoning', text: chunk.reasoning }

    for (const call of chunk.toolCalls) {
      const event: Extract<LlmEvent, { type: 'toolCall' }> = { type: 'toolCall', index: call.index }
      if (call.id !== undefined) event.id = call.id
      if (call.name !== undefined) event.name = call.name
      if (call.argumentsDelta !== undefined) event.argumentsDelta = call.argumentsDelta
      yield event
    }

    if (chunk.usage) yield { type: 'usage', usage: chunk.usage }
    if (chunk.finishReason) finishReason = chunk.finishReason
  }

  // finish_reason 通常出现在倒数第二个 chunk（最后一个是 usage），统一在流结束时发
  yield { type: 'finish', reason: finishReason ?? 'stop' }
}

/** 创建 OpenAI 兼容的流式客户端；无状态，整个 agent 进程复用一个即可 */
export function createOpenAiLlmClient(): LlmClient {
  return { stream: streamChatCompletion }
}
