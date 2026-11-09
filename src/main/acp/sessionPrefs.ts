/**
 * 记住每个 Agent 上一次会话里选择的模型 / 模式 / 推理强度。
 *
 * 背景：ACP 的 `session/new` 总是返回 Agent 自己的默认配置，用户每次新建会话都得
 * 重新挑一次模型。这里把用户切换过的「会话级配置」（model / mode / thought_level）
 * 按 agentId 记在本地，创建新会话后自动套用；Agent 不再提供的值会被安全跳过。
 *
 * 存储在 electron-store 的 `acp-last-session-config` 键下，与用户配置（`acp`）分开，
 * 避免把「记忆」混进设置界面。
 */
import { getStore } from '../store'

const STORE_KEY = 'acp-last-session-config'

/** 需要记住的配置项分类（Agent 也可能用 id 直接命名，见 isRememberedOption） */
const REMEMBERED_CATEGORIES = new Set(['mode', 'model', 'thought_level'])
const REMEMBERED_IDS = new Set(['mode', 'model', 'thought_level'])

export interface RememberedSessionConfig {
  /** config option id -> value */
  values: Record<string, string | boolean>
  /** 通过 session/set_mode 设置的当前模式 */
  modeId?: string
  /** 只有 models 状态、没有 config option 的 Agent 用到的当前模型 */
  modelId?: string
}

type RememberedMap = Record<string, RememberedSessionConfig>

let cache: RememberedMap | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalize(raw: unknown): RememberedSessionConfig | null {
  if (!isRecord(raw)) return null
  const config: RememberedSessionConfig = { values: {} }

  if (isRecord(raw.values)) {
    for (const [key, value] of Object.entries(raw.values)) {
      if (typeof value === 'string' || typeof value === 'boolean') config.values[key] = value
    }
  }
  if (typeof raw.modeId === 'string' && raw.modeId) config.modeId = raw.modeId
  if (typeof raw.modelId === 'string' && raw.modelId) config.modelId = raw.modelId
  return config
}

function load(): RememberedMap {
  if (cache) return cache
  const map: RememberedMap = {}
  try {
    const raw = getStore().get(STORE_KEY)
    if (isRecord(raw)) {
      for (const [agentId, value] of Object.entries(raw)) {
        const config = normalize(value)
        if (config) map[agentId] = config
      }
    }
  } catch {
    // store 尚未就绪（dev 下 userData 重定向晚于模块加载）时按空处理即可
  }
  cache = map
  return map
}

function save(): void {
  if (!cache) return
  try {
    getStore().set(STORE_KEY, cache)
  } catch {
    // 持久化失败不影响当前会话
  }
}

function entry(agentId: string): RememberedSessionConfig {
  const map = load()
  const existing = map[agentId]
  if (existing) return existing
  const created: RememberedSessionConfig = { values: {} }
  map[agentId] = created
  return created
}

/** 该分类的配置项要不要记住（模型 / 模式 / 推理强度） */
export function isRememberedOption(option: { id: string; category?: string | null }): boolean {
  if (typeof option.category === 'string' && REMEMBERED_CATEGORIES.has(option.category)) return true
  return REMEMBERED_IDS.has(option.id)
}

export function getRememberedSessionConfig(agentId: string): RememberedSessionConfig | undefined {
  const config = load()[agentId]
  if (!config) return undefined
  return { values: { ...config.values }, modeId: config.modeId, modelId: config.modelId }
}

export function rememberConfigValue(agentId: string, configId: string, value: string | boolean): void {
  const config = entry(agentId)
  config.values[configId] = value
  save()
}

export function rememberMode(agentId: string, modeId: string): void {
  const config = entry(agentId)
  config.modeId = modeId
  save()
}

export function rememberModel(agentId: string, modelId: string): void {
  const config = entry(agentId)
  config.modelId = modelId
  save()
}
