/**
 * ACP 配置的加载 / 持久化。
 *
 * 存储在 electron-store 的 `acp` 键下。agents 列表以用户落盘内容为准（含删空），
 * 只有首次运行 / 老版本数据缺字段时才播种 DEFAULT_ACP_AGENTS。
 */
import { getStore } from '../store'
import { DEFAULT_ACP_CONFIG } from '../../shared/acp'
import type { AcpAgentConfig, AcpAutoApprove, AcpConfig } from '../../shared/acp'

const STORE_KEY = 'acp'
const SCHEMA_VERSION_KEY = 'acpSchemaVersion'
/** 配置结构版本；升级时用于一次性迁移旧的默认 Agent 列表 */
const ACP_CONFIG_VERSION = 3

/**
 * 0.2.10-dev 阶段曾内置过的 Agent 启动命令。
 * 升级到 ACP_CONFIG_VERSION=2 时，命中这些签名的条目会被新的默认项替换，
 * 用户自己新增/改过命令的条目则原样保留。
 */
/** 0.2.11 及更早版本的 mock agent 内置项；v3 迁移时替换为 MIR Harness */
const LEGACY_MOCK_SIGNATURE = 'node|{{APP_PATH}}/scripts/acp-mock-agent.mjs'

const LEGACY_DEFAULT_SIGNATURES = new Set([
  'node|{{APP_PATH}}/scripts/acp-mock-agent.mjs',
  'npx|@agentclientprotocol/claude-agent-acp@latest',
  'npx|@google/gemini-cli@latest|--experimental-acp',
  'npx|@zed-industries/codex-acp@latest',
  'npx|@github/copilot-language-server@latest|--acp',
  'npx|@qwen-code/qwen-code@latest|--acp|--experimental-skills',
  'npx|opencode-ai@latest|acp',
  'npx|@augmentcode/auggie@latest|--acp',
  'npx|@qoder-ai/qodercli@latest|--acp',
  'npx|openclaw|acp',
  'kiro-cli|acp',
  'hermes|acp'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function asEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') env[key] = item
  }
  return Object.keys(env).length > 0 ? env : undefined
}

/** 归一化单个 Agent 配置；缺少 id/name/command 视为非法，返回 null */
function normalizeAgent(raw: unknown): AcpAgentConfig | null {
  if (!isRecord(raw)) return null
  const id = asString(raw.id)
  const name = asString(raw.name) ?? id
  const command = asString(raw.command)
  if (!id || !name || !command) return null

  const agent: AcpAgentConfig = {
    id,
    name,
    command,
    enabled: asBoolean(raw.enabled) ?? true
  }

  const args = asArgs(raw.args)
  if (args) agent.args = args

  const env = asEnv(raw.env)
  if (env) agent.env = env

  const description = asString(raw.description)
  if (description) agent.description = description

  return agent
}

/** 归一化 agent 列表并去重；不是数组时返回 null，便于区分「未配置」和「配置成空」 */
function normalizeAgents(rawAgents: unknown): AcpAgentConfig[] | null {
  if (!Array.isArray(rawAgents)) return null
  const agents: AcpAgentConfig[] = []
  const seen = new Set<string>()
  for (const raw of rawAgents) {
    const agent = normalizeAgent(raw)
    if (!agent || seen.has(agent.id)) continue
    agents.push(agent)
    seen.add(agent.id)
  }
  return agents
}

function signatureOf(agent: AcpAgentConfig): string {
  return [agent.command, ...(agent.args ?? [])].join('|')
}

/**
 * 一次性迁移：用新的默认项替换旧的内置项，保留用户自建项。
 *
 * - v1 → v2：替换 12 个历史默认 Agent
 * - v2 → v3：把旧的内置 mock agent 换成内置的 MIR Harness（命令被用户改过的条目保留）
 */
function migrateAgents(stored: AcpAgentConfig[], fromVersion: number): AcpAgentConfig[] {
  const seeded = seedAgents()
  const seededIds = new Set(seeded.map((agent) => agent.id))
  const custom = stored.filter((agent) => {
    const signature = signatureOf(agent)
    if (LEGACY_DEFAULT_SIGNATURES.has(signature)) return false
    if (fromVersion < 3 && signature === LEGACY_MOCK_SIGNATURE) return false
    return !seededIds.has(agent.id)
  })
  return [...seeded, ...custom]
}

function persistConfig(config: AcpConfig): void {
  getStore().set(STORE_KEY, config)
  getStore().set(SCHEMA_VERSION_KEY, ACP_CONFIG_VERSION)
}

function seedAgents(): AcpAgentConfig[] {
  // 走一遍归一化，保证内置项也带上 enabled=true 等默认值
  return normalizeAgents(DEFAULT_ACP_CONFIG.agents) ?? []
}

function normalizeAutoApprove(value: unknown, fallback: AcpAutoApprove): AcpAutoApprove {
  return value === 'ask' || value === 'allowAll' ? value : fallback
}

/** 读取完整配置。只有当 store 里没有可信的 agents 列表（首次运行 / 老版本数据）时才播种内置项 */
export function getAcpConfig(): AcpConfig {
  const config: AcpConfig = {
    agents: seedAgents(),
    autoApprovePermissions: DEFAULT_ACP_CONFIG.autoApprovePermissions,
    logTraffic: DEFAULT_ACP_CONFIG.logTraffic,
    smoothStreaming: DEFAULT_ACP_CONFIG.smoothStreaming
  }

  const raw: unknown = getStore().get(STORE_KEY)
  if (!isRecord(raw)) return config

  // 显式落盘过的 agents 数组（包括用户删到空数组）一律原样尊重，不再补回内置项
  const agents = normalizeAgents(raw.agents)
  config.agents = agents ?? seedAgents()
  config.autoApprovePermissions = normalizeAutoApprove(
    raw.autoApprovePermissions,
    DEFAULT_ACP_CONFIG.autoApprovePermissions
  )
  config.logTraffic = asBoolean(raw.logTraffic) ?? DEFAULT_ACP_CONFIG.logTraffic
  config.smoothStreaming = asBoolean(raw.smoothStreaming) ?? DEFAULT_ACP_CONFIG.smoothStreaming

  const defaultWorkingDirectory = asString(raw.defaultWorkingDirectory)
  if (defaultWorkingDirectory && defaultWorkingDirectory.trim()) {
    config.defaultWorkingDirectory = defaultWorkingDirectory
  }

  // 老版本落盘的 Agent 列表（12 个历史默认项）一次性迁移到新默认项
  const version = asNumber(getStore().get(SCHEMA_VERSION_KEY)) ?? 1
  if (version < ACP_CONFIG_VERSION) {
    if (agents) config.agents = migrateAgents(agents, version)
    persistConfig(config)
  }

  return config
}

/** 合并 patch 后落盘，返回合并后的完整配置 */
export function setAcpConfig(patch: Partial<AcpConfig>): AcpConfig {
  const current = getAcpConfig()
  const next: AcpConfig = { ...current }

  if (patch.agents !== undefined) {
    // 用户提交的列表即最终列表：不合并内置项，也允许删到 0 个
    next.agents = normalizeAgents(patch.agents) ?? []
  }
  if (patch.autoApprovePermissions !== undefined) {
    next.autoApprovePermissions = normalizeAutoApprove(
      patch.autoApprovePermissions,
      current.autoApprovePermissions
    )
  }
  if (patch.logTraffic !== undefined) {
    next.logTraffic = patch.logTraffic === true
  }
  if (patch.smoothStreaming !== undefined) {
    next.smoothStreaming = patch.smoothStreaming === true
  }
  if (patch.defaultWorkingDirectory !== undefined) {
    const value = patch.defaultWorkingDirectory.trim()
    if (value) next.defaultWorkingDirectory = value
    else delete next.defaultWorkingDirectory
  }

  persistConfig(next)
  return next
}

/** 按 id 查 Agent 配置 */
export function getAgentConfig(agentId: string): AcpAgentConfig | undefined {
  return getAcpConfig().agents.find((agent) => agent.id === agentId)
}

/** 启用的 Agent 列表 */
export function getEnabledAgents(): AcpAgentConfig[] {
  return getAcpConfig().agents.filter((agent) => agent.enabled !== false)
}
