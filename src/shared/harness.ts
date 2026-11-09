/**
 * MIR Harness（内置 Agent）的配置模型。
 *
 * 这里只放「纯数据 + 纯函数」，主进程（读写 ~/.mir-harness/config.json、设置界面）、
 * 渲染器（设置界面表单）和 agent 进程（启动时加载）三边共用，避免各写一份默认值。
 *
 * 配置文件路径：~/.mir-harness/config.json（可用环境变量 MIR_HARNESS_CONFIG 覆盖）
 * 字段级覆盖：MIR_HARNESS_API_BASE / MIR_HARNESS_API_KEY / MIR_HARNESS_MODEL
 */

/** 一个可选的模型；apiBase / apiKey 留空时回落到顶层配置 */
export interface HarnessModelConfig {
  /** 传给 OpenAI 兼容接口的 model 字段 */
  id: string
  /** 展示名，默认用 id */
  name?: string
  apiBase?: string
  apiKey?: string
}

export type HarnessApprovalMode = 'ask' | 'auto'

export interface HarnessConfig {
  /** OpenAI 兼容接口根地址，例如 https://api.deepseek.com/v1 */
  apiBase: string
  apiKey: string
  /** 默认模型 id */
  model: string
  models: HarnessModelConfig[]
  temperature: number
  maxTokens: number
  /** 单轮对话中最多允许的「模型 → 工具」循环次数 */
  maxTurns: number
  /** 估算上下文占用时使用的窗口大小（用于 usage_update 的 size） */
  contextWindow: number
  systemPrompt: string
  /** ask：写文件/执行命令前询问；auto：工作区内自动批准 */
  approvalMode: HarnessApprovalMode
  /** 是否把 thought_level 作为 reasoning_effort 传给接口（部分网关支持） */
  sendReasoningEffort: boolean
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
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }
  ],
  temperature: 0.2,
  maxTokens: 8192,
  maxTurns: 24,
  contextWindow: 128000,
  systemPrompt: DEFAULT_HARNESS_SYSTEM_PROMPT,
  approvalMode: 'ask',
  sendReasoningEffort: false
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

function normalizeModels(raw: unknown, fallback: HarnessModelConfig[]): HarnessModelConfig[] {
  const models: HarnessModelConfig[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue
      const id = asString(item.id)
      if (!id || seen.has(id)) continue
      const model: HarnessModelConfig = { id }
      const name = asString(item.name)
      if (name) model.name = name
      const apiBase = asString(item.apiBase)
      if (apiBase) model.apiBase = apiBase
      const apiKey = asString(item.apiKey)
      if (apiKey) model.apiKey = apiKey
      models.push(model)
      seen.add(id)
    }
  }
  if (models.length === 0) return fallback.map((model) => ({ ...model }))
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
    temperature: clampNumber(source.temperature, 0, 2, fallback.temperature),
    maxTokens: Math.round(clampNumber(source.maxTokens, 1, 200_000, fallback.maxTokens)),
    maxTurns: Math.round(clampNumber(source.maxTurns, 1, 100, fallback.maxTurns)),
    contextWindow: Math.round(clampNumber(source.contextWindow, 1_000, 2_000_000, fallback.contextWindow)),
    systemPrompt:
      typeof source.systemPrompt === 'string' && source.systemPrompt.trim()
        ? source.systemPrompt
        : fallback.systemPrompt,
    approvalMode: source.approvalMode === 'auto' ? 'auto' : source.approvalMode === 'ask' ? 'ask' : fallback.approvalMode,
    sendReasoningEffort:
      typeof source.sendReasoningEffort === 'boolean' ? source.sendReasoningEffort : fallback.sendReasoningEffort
  }

  // 选中的模型必须在列表里，否则补进去，避免界面显示一个不存在的选项
  if (!config.models.some((item) => item.id === config.model)) {
    config.models = [{ id: config.model, name: config.model }, ...config.models]
  }

  return config
}

/** 模型下拉用的展示名 */
export function harnessModelLabel(model: HarnessModelConfig): string {
  return model.name?.trim() || model.id
}

/** 解析某个模型实际要用的接口地址与密钥（模型级配置优先） */
export function resolveHarnessModel(
  config: HarnessConfig,
  modelId: string
): { id: string; label: string; apiBase: string; apiKey: string } {
  const target = config.models.find((item) => item.id === modelId) ?? config.models[0]
  return {
    id: target?.id ?? modelId,
    label: target ? harnessModelLabel(target) : modelId,
    apiBase: target?.apiBase ?? config.apiBase,
    apiKey: target?.apiKey ?? config.apiKey
  }
}
