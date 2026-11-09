/**
 * 从模型接口「发现」模型列表。
 *
 * MIR Harness 的模型列表原本要手填，用户还得知道接口支持哪些模型 id。
 * 这里按几种常见的模型接口格式依次探测（OpenAI 兼容 / Anthropic / Google Gemini /
 * Ollama / 通用 JSON），拿到 id 与展示名后交给设置界面合并。
 *
 * 只在主进程调用（走 Node 的 fetch），但实现放在 shared：不依赖 electron / node:fs，
 * 方便用独立脚本单测。
 */

/** 接口格式：决定下拉里怎么提示用户「拉取到了什么」。 */
export type HarnessModelFormat = 'openai' | 'anthropic' | 'google' | 'ollama' | 'generic'

export interface DiscoveredHarnessModel {
  /** 真正要写进配置的模型 id。 */
  id: string
  /** 接口给的展示名；与 id 相同、或接口没给时为空。 */
  name?: string
  /** OpenAI 兼容接口的 `owned_by`。 */
  ownedBy?: string
}

export interface HarnessModelDiscoveryAttempt {
  /** 已脱敏的 URL（query 里的 key 会打码）。 */
  url: string
  status?: number
  ok: boolean
  format?: HarnessModelFormat
  count?: number
  /** 机器可读的失败原因：unauthorized / not-found / non-json / empty-list / timeout / 其它错误文本。 */
  error?: string
}

export interface HarnessModelDiscoveryResult {
  ok: boolean
  models: DiscoveredHarnessModel[]
  attempts: HarnessModelDiscoveryAttempt[]
  format?: HarnessModelFormat
  endpoint?: string
  error?: string
}

export interface HarnessModelDiscoveryInput {
  apiBase: string
  apiKey?: string
  /** 单次请求超时，默认 8s。 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 8_000
const MAX_ATTEMPTS = 4
const MAX_BODY_BYTES = 2_000_000

/* --------------------------------- 工具 --------------------------------- */

function trimSlashes(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** `https://x/openai/v1`、`.../v1beta` 之类已带版本段，不再追加 `/v1`。 */
function hasVersionSuffix(base: string): boolean {
  return /\/v\d+(?:[a-z0-9.]*)$/i.test(base)
}

/** OpenAI 兼容接口的根地址：没版本段就补 `/v1`。 */
function openAiBase(base: string): string {
  const trimmed = trimSlashes(base)
  if (!trimmed) return ''
  return hasVersionSuffix(trimmed) ? trimmed : `${trimmed}/v1`
}

function originOf(base: string): string {
  try {
    return new URL(trimSlashes(base)).origin
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** 把 `/models/xxx` 之类的名字归一成配置里用的 id。 */
function normalizeModelId(raw: string): string {
  return raw.replace(/^models\//, '').trim()
}

function toDiscoveredModel(item: unknown): DiscoveredHarnessModel | null {
  if (!isRecord(item)) return null
  const rawId = firstString(
    item.id,
    item.model,
    item.model_name,
    item.name,
    item.slug,
    item.key,
    item.modelId
  )
  if (!rawId) return null
  const id = normalizeModelId(rawId)
  if (!id) return null

  const model: DiscoveredHarnessModel = { id }
  const name = firstString(item.display_name, item.displayName, item.title, item.label, item.name, item.model)
  if (name && normalizeModelId(name) !== id) model.name = name
  const ownedBy = firstString(item.owned_by, item.ownedBy, item.organization, item.provider)
  if (ownedBy) model.ownedBy = ownedBy
  return model
}

function dedupeModels(models: DiscoveredHarnessModel[]): DiscoveredHarnessModel[] {
  const seen = new Set<string>()
  const result: DiscoveredHarnessModel[] = []
  for (const model of models) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    result.push(model)
  }
  return result
}

function detectFormatFromItems(items: unknown[], hint?: HarnessModelFormat): HarnessModelFormat {
  if (hint) return hint
  for (const item of items) {
    if (!isRecord(item)) continue
    const name = firstString(item.name)
    if (name?.startsWith('models/')) return 'google'
  }
  return 'generic'
}

/**
 * 解析一个模型列表响应。支持：
 * - OpenAI / Anthropic / OpenRouter / LiteLLM 等 `{ data: [...] }`
 * - Google Gemini `{ models: [{ name: "models/xxx", displayName }] }`
 * - Ollama `/api/tags` `{ models: [{ name: "qwen2.5:7b" }] }`
 * - 裸数组 `[{ id }]` 或 `{ result: [...] }`
 */
export function parseModelListPayload(
  payload: unknown,
  hint?: HarnessModelFormat
): { models: DiscoveredHarnessModel[]; format: HarnessModelFormat } | null {
  let items: unknown[] | null = null
  let format = hint

  if (Array.isArray(payload)) {
    items = payload
    format = format ?? 'generic'
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.data)) {
      items = payload.data
      format = format ?? 'openai'
    } else if (Array.isArray(payload.models)) {
      items = payload.models
      format = detectFormatFromItems(payload.models, format)
      // Google 用 models 字段，Ollama 也是；靠是否 `models/` 前缀 / 显式 hint 区分。
      if (!format) format = 'ollama'
    } else if (Array.isArray(payload.result)) {
      items = payload.result
      format = format ?? 'generic'
    } else if (Array.isArray(payload.model_list)) {
      items = payload.model_list
      format = format ?? 'generic'
    }
  }

  if (!items || items.length === 0) return null
  const models = dedupeModels(items.map(toDiscoveredModel).filter((model): model is DiscoveredHarnessModel => model !== null))
  if (models.length === 0) return null
  return { models, format: format ?? 'generic' }
}

/** 日志、错误提示里不暴露 API Key。 */
export function redactModelEndpoint(url: string): string {
  return url.replace(/([?&](?:key|api_key|apiKey)=)[^&]*/g, '$1***')
}

/* ------------------------------- 端点候选 -------------------------------- */

export interface ModelEndpointCandidate {
  url: string
  format: HarnessModelFormat
  headers: Record<string, string>
}

/**
 * 按接口地址推断候选端点，按「最可能成功」排序。
 * 调用方最多只会请求前 MAX_ATTEMPTS 个。
 */
export function modelEndpointCandidates(apiBase: string, apiKey?: string): ModelEndpointCandidate[] {
  const base = trimSlashes(apiBase)
  const candidates: ModelEndpointCandidate[] = []
  const key = apiKey?.trim() ?? ''
  const origin = originOf(base)
  const lower = base.toLowerCase()

  const push = (url: string, format: HarnessModelFormat, headers: Record<string, string> = {}): void => {
    if (!url) return
    if (candidates.some((candidate) => candidate.url === url)) return
    candidates.push({ url, format, headers })
  }

  const bearer: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {}
  const anthropicHeaders: Record<string, string> = { 'anthropic-version': '2023-06-01' }
  if (key) anthropicHeaders['x-api-key'] = key

  const isGoogle = lower.includes('generativelanguage.googleapis.com') || lower.includes('googleapis.com') || /\/v1beta\d*$/.test(lower)
  const isAnthropic = lower.includes('anthropic')
  const isOllama = lower.includes('ollama') || /:11434(?:\/|$)/.test(base)

  const googleQuery = key ? `?key=${encodeURIComponent(key)}` : ''
  const googleEndpoint = `${openAiBase(base)}/models${googleQuery}`

  if (isGoogle) {
    push(googleEndpoint, 'google')
    if (origin) push(`${origin}/v1beta/models${googleQuery}`, 'google')
    push(`${openAiBase(base)}/models`, 'openai', bearer)
  } else if (isAnthropic) {
    push(`${openAiBase(base)}/models`, 'anthropic', anthropicHeaders)
    push(`${openAiBase(base)}/models`, 'openai', bearer)
  } else if (isOllama) {
    if (origin) push(`${origin}/api/tags`, 'ollama')
    push(`${openAiBase(base)}/models`, 'openai', bearer)
  } else {
    push(`${openAiBase(base)}/models`, 'openai', bearer)
    if (base !== openAiBase(base)) push(`${base}/models`, 'openai', bearer)
    if (origin) push(`${origin}/api/tags`, 'ollama')
  }

  return candidates
}

/* -------------------------------- 主流程 -------------------------------- */

function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' || error.name === 'AbortError' || /timeout/i.test(error.message)
  }
  return false
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return typeof error === 'string' ? error : String(error)
}

async function fetchModelsOnce(
  candidate: ModelEndpointCandidate,
  timeoutMs: number
): Promise<{ attempt: HarnessModelDiscoveryAttempt; parsed?: { models: DiscoveredHarnessModel[]; format: HarnessModelFormat } }> {
  const attempt: HarnessModelDiscoveryAttempt = {
    url: redactModelEndpoint(candidate.url),
    ok: false,
    format: candidate.format
  }
  let response: Response
  try {
    response = await fetch(candidate.url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...candidate.headers },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    attempt.error = isTimeoutError(error) ? 'timeout' : errorText(error)
    return { attempt }
  }

  attempt.status = response.status
  if (!response.ok) {
    attempt.error = response.status === 401 || response.status === 403 ? 'unauthorized' : `http-${response.status}`
    // 401/403 往往说明这是「另一种认证格式」的接口，别把响应体当 JSON 继续解析。
    void response.body?.cancel?.()
    return { attempt }
  }

  let text: string
  try {
    text = await response.text()
  } catch (error) {
    attempt.error = isTimeoutError(error) ? 'timeout' : errorText(error)
    return { attempt }
  }
  text = text.slice(0, MAX_BODY_BYTES)

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    attempt.error = 'non-json'
    return { attempt }
  }

  const parsed = parseModelListPayload(payload, candidate.format)
  if (!parsed) {
    attempt.error = 'empty-list'
    return { attempt }
  }
  attempt.ok = true
  attempt.count = parsed.models.length
  attempt.format = parsed.format
  return { attempt, parsed }
}

/**
 * 依次探测候选端点，返回第一个能解析出模型列表的结果。
 * 全部失败时 `error` 给出对用户友好的原因（401、非 JSON、超时……）。
 */
export async function discoverHarnessModels(input: HarnessModelDiscoveryInput): Promise<HarnessModelDiscoveryResult> {
  const apiBase = typeof input.apiBase === 'string' ? input.apiBase.trim() : ''
  const attempts: HarnessModelDiscoveryAttempt[] = []

  if (!apiBase) {
    return { ok: false, models: [], attempts, error: '请先填写接口地址' }
  }
  if (!/^https?:\/\//i.test(apiBase)) {
    return { ok: false, models: [], attempts, error: '接口地址需要以 http:// 或 https:// 开头' }
  }

  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? Math.min(input.timeoutMs, 60_000)
      : DEFAULT_TIMEOUT_MS

  const candidates = modelEndpointCandidates(apiBase, input.apiKey).slice(0, MAX_ATTEMPTS)
  let unauthorized = false
  let nonJson = false
  let timedOut = false

  for (const candidate of candidates) {
    const { attempt, parsed } = await fetchModelsOnce(candidate, timeoutMs)
    attempts.push(attempt)
    if (parsed) {
      return {
        ok: true,
        models: parsed.models,
        attempts,
        format: parsed.format,
        endpoint: attempt.url
      }
    }
    if (attempt.error === 'unauthorized') unauthorized = true
    if (attempt.error === 'non-json') nonJson = true
    if (attempt.error === 'timeout') timedOut = true
  }

  let error: string
  if (unauthorized) error = '模型接口返回 401/403，请检查 API Key 是否正确、是否有权限'
  else if (nonJson) error = '接口返回的不是 JSON，请确认地址指向的是模型接口'
  else if (timedOut) error = '连接接口超时，请检查地址与网络'
  else if (attempts.length === 0) error = '没有可用的模型接口地址'
  else error = '接口没有返回可识别的模型列表'

  return { ok: false, models: [], attempts, error }
}
