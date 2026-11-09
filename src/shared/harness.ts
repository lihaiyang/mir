/**
 * MIR Harness（内置 Agent）的配置模型。
 *
 * 这里只放「纯数据 + 纯函数」，主进程（读写 ~/.mir-harness/config.json、设置界面）、
 * 渲染器（设置界面表单）和 agent 进程（启动时加载）三边共用，避免各写一份默认值。
 *
 * 配置文件路径：~/.mir-harness/config.json（可用环境变量 MIR_HARNESS_CONFIG 覆盖）
 * 字段级覆盖：MIR_HARNESS_API_BASE / MIR_HARNESS_API_KEY / MIR_HARNESS_MODEL
 */

/** 推理强度：只有 high / max 两档，默认 max */
export type HarnessReasoningEffort = 'high' | 'max'

export const HARNESS_REASONING_EFFORTS: readonly HarnessReasoningEffort[] = ['high', 'max']

export const DEFAULT_HARNESS_REASONING_EFFORT: HarnessReasoningEffort = 'max'

/** 单个模型的默认上下文窗口（tokens）：1M */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 1_000_000

/** 单个模型的默认最大输出（tokens）：128K */
export const DEFAULT_MODEL_MAX_TOKENS = 128_000

/** 默认认为模型能接收图片 */
export const DEFAULT_MODEL_SUPPORTS_IMAGES = true

/**
 * 一个可选的模型及其能力 / 采样参数。
 *
 * apiBase / apiKey 留空时回落到顶层配置；其余字段都有全局默认值，
 * 解析时由 {@link resolveHarnessModel} 补齐，界面上可以逐模型覆盖。
 */
export interface HarnessModelConfig {
  /** 传给 OpenAI 兼容接口的 model 字段 */
  id: string
  /** 展示名，默认用 id */
  name?: string
  apiBase?: string
  apiKey?: string
  /** 推理强度（high / max），默认 max */
  reasoningEffort?: HarnessReasoningEffort
  /** 能否接收图片输入，默认 true */
  supportsImages?: boolean
  /** 上下文窗口（tokens），默认 1M；用于 usage / 状态展示 */
  contextWindow?: number
  /** 单次回复最大输出 tokens，默认 128K */
  maxTokens?: number
}

export type HarnessApprovalMode = 'ask' | 'auto'

export interface HarnessConfig {
  /** OpenAI 兼容接口根地址，例如 https://api.deepseek.com/v1 */
  apiBase: string
  apiKey: string
  /** 默认模型 id */
  model: string
  models: HarnessModelConfig[]
  /** 单轮对话中最多允许的「模型 → 工具」循环次数 */
  maxTurns: number
  systemPrompt: string
  /** ask：写文件/执行命令前询问；auto：工作区内自动批准 */
  approvalMode: HarnessApprovalMode
}

/** 设置界面 / 主进程之间传递的配置快照 */
export interface HarnessConfigSnapshot {
  /** 实际读取 / 写入的配置文件路径 */
  path: string
  /** 文件是否已存在（首次打开设置时为 false，配置值来自默认值 + 环境变量） */
  exists: boolean
  config: HarnessConfig
  defaults: HarnessConfig
  /** 当前进程里生效的环境变量覆盖项，仅用于在界面上提示 */
  envOverrides: string[]
  /** 配置文件解析失败时的错误信息（此时 config 为默认值 + 环境变量） */
  error?: string
}

/** 某个模型实际生效的配置（会话 / 请求侧使用） */
export interface ResolvedHarnessModel {
  id: string
  label: string
  /** 模型 id 里 `provider/model` 的 provider 段；没有则用 apiBase 的 host */
  provider: string
  apiBase: string
  apiKey: string
  reasoningEffort: HarnessReasoningEffort
  supportsImages: boolean
  contextWindow: number
  maxTokens: number
}

export const HARNESS_DIR_NAME = '.mir-harness'
export const HARNESS_CONFIG_FILE_NAME = 'config.json'
/** 环境变量：覆盖配置文件路径 */
export const HARNESS_CONFIG_ENV = 'MIR_HARNESS_CONFIG'
export const HARNESS_API_BASE_ENV = 'MIR_HARNESS_API_BASE'
export const HARNESS_API_KEY_ENV = 'MIR_HARNESS_API_KEY'
export const HARNESS_MODEL_ENV = 'MIR_HARNESS_MODEL'

export const DEFAULT_HARNESS_SYSTEM_PROMPT = [
  'You are MIR Harness, the built-in coding agent of the MIR editor.',
  'You work inside the user project directory and use the provided tools to read, search, write files and run commands.',
  'Read before you edit; prefer small, verifiable changes; never invent file contents.',
  'Keep replies concise and use Markdown. Reply in the same language as the user.'
].join(' ')

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  apiBase: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  models: [
    {
      id: 'deepseek-chat',
      name: 'DeepSeek Chat',
      reasoningEffort: DEFAULT_HARNESS_REASONING_EFFORT,
      supportsImages: DEFAULT_MODEL_SUPPORTS_IMAGES,
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS
    },
    {
      id: 'deepseek-reasoner',
      name: 'DeepSeek Reasoner',
      reasoningEffort: DEFAULT_HARNESS_REASONING_EFFORT,
      supportsImages: DEFAULT_MODEL_SUPPORTS_IMAGES,
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS
    }
  ],
  maxTurns: 24,
  systemPrompt: DEFAULT_HARNESS_SYSTEM_PROMPT,
  approvalMode: 'ask'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function isHarnessReasoningEffort(value: unknown): value is HarnessReasoningEffort {
  return value === 'high' || value === 'max'
}

function normalizeReasoningEffort(value: unknown): HarnessReasoningEffort {
  return isHarnessReasoningEffort(value) ? value : DEFAULT_HARNESS_REASONING_EFFORT
}

function normalizeModelConfig(item: Record<string, unknown>, id: string): HarnessModelConfig {
  const model: HarnessModelConfig = {
    id,
    reasoningEffort: normalizeReasoningEffort(item.reasoningEffort),
    supportsImages:
      typeof item.supportsImages === 'boolean' ? item.supportsImages : DEFAULT_MODEL_SUPPORTS_IMAGES,
    contextWindow: Math.round(
      clampNumber(item.contextWindow, 1_000, 10_000_000, DEFAULT_MODEL_CONTEXT_WINDOW)
    ),
    maxTokens: Math.round(clampNumber(item.maxTokens, 1, 1_000_000, DEFAULT_MODEL_MAX_TOKENS))
  }
  const name = asString(item.name)
  if (name) model.name = name
  const apiBase = asString(item.apiBase)
  if (apiBase) model.apiBase = apiBase
  const apiKey = asString(item.apiKey)
  if (apiKey) model.apiKey = apiKey
  return model
}

function normalizeModels(raw: unknown, fallback: HarnessModelConfig[]): HarnessModelConfig[] {
  const models: HarnessModelConfig[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue
      const id = asString(item.id)
      if (!id || seen.has(id)) continue
      models.push(normalizeModelConfig(item, id))
      seen.add(id)
    }
  }
  if (models.length === 0) {
    return fallback.map((model) => normalizeModelConfig({ ...model } as Record<string, unknown>, model.id))
  }
  return models
}

/**
 * 归一化配置文件内容：非法字段回落到默认值，数值做范围限制，模型列表去重。
 * 主进程保存与 agent 加载都走这里，保证两边看到的是同一份配置。
 */
export function normalizeHarnessConfig(
  raw: unknown,
  fallback: HarnessConfig = DEFAULT_HARNESS_CONFIG
): HarnessConfig {
  const source = isRecord(raw) ? raw : {}
  const models = normalizeModels(source.models, fallback.models)
  const model = asString(source.model) ?? fallback.model
  const config: HarnessConfig = {
    apiBase: asString(source.apiBase) ?? fallback.apiBase,
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : fallback.apiKey,
    model,
    models,
    maxTurns: Math.round(clampNumber(source.maxTurns, 1, 100, fallback.maxTurns)),
    systemPrompt:
      typeof source.systemPrompt === 'string' && source.systemPrompt.trim()
        ? source.systemPrompt
        : fallback.systemPrompt,
    approvalMode: source.approvalMode === 'auto' ? 'auto' : source.approvalMode === 'ask' ? 'ask' : fallback.approvalMode
  }

  // 选中的模型必须在列表里，否则补进去，避免界面显示一个不存在的选项
  if (!config.models.some((item) => item.id === config.model)) {
    config.models = [normalizeModelConfig({}, config.model), ...config.models]
  }

  return config
}

/**
 * 模型下拉用的展示名：有展示名时把 id 一并带上，方便区分同名模型与提供商
 * （例如 `DeepSeek V4.1 Flash (mccodex-mc/deepseek-v4.1-flash)`）。
 */
export function harnessModelLabel(model: HarnessModelConfig): string {
  const name = model.name?.trim()
  if (name && name !== model.id) return `${name} (${model.id})`
  return model.id
}

/** 模型提供商：优先取 id 的 `provider/model` 前缀，其次取 apiBase 的 host */
export function harnessModelProvider(model: HarnessModelConfig): string {
  const slash = model.id.indexOf('/')
  if (slash > 0) return model.id.slice(0, slash)
  if (model.apiBase) {
    try {
      return new URL(model.apiBase).host
    } catch {
      return ''
    }
  }
  return ''
}

/** 解析某个模型实际要用的地址、密钥与采样参数（模型级配置优先，缺省用默认值） */
export function resolveHarnessModel(config: HarnessConfig, modelId: string): ResolvedHarnessModel {
  const target = config.models.find((item) => item.id === modelId) ?? config.models[0]
  const id = target?.id ?? modelId
  return {
    id,
    label: target ? harnessModelLabel(target) : modelId,
    provider: target ? harnessModelProvider(target) : '',
    apiBase: target?.apiBase ?? config.apiBase,
    apiKey: target?.apiKey ?? config.apiKey,
    reasoningEffort: normalizeReasoningEffort(target?.reasoningEffort),
    supportsImages:
      typeof target?.supportsImages === 'boolean' ? target.supportsImages : DEFAULT_MODEL_SUPPORTS_IMAGES,
    contextWindow: Math.round(
      clampNumber(target?.contextWindow, 1_000, 10_000_000, DEFAULT_MODEL_CONTEXT_WINDOW)
    ),
    maxTokens: Math.round(clampNumber(target?.maxTokens, 1, 1_000_000, DEFAULT_MODEL_MAX_TOKENS))
  }
}
