/**
 * ACP Agent Registry：https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
 *
 * 用于「添加 Agent」时列出官方收录、可一键安装的 Agent。网络失败时静默降级
 * 返回上次缓存（或空数组），绝不让 UI 卡住。
 */
import type { AcpRegistryAgent } from '../../shared/acp'

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
const CACHE_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000

interface RegistryCache {
  fetchedAt: number
  agents: AcpRegistryAgent[]
}

let cache: RegistryCache | null = null
let inflight: Promise<AcpRegistryAgent[]> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return items.length > 0 ? items : undefined
}

/** 把 authors 的各种形态（字符串数组 / {name} 数组 / 单个字符串）统一成 string[] */
function authors(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value.trim() ? [value] : undefined
  if (!Array.isArray(value)) return undefined
  const names: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) names.push(item)
    else if (isRecord(item)) {
      const name = str(item.name)
      if (name) names.push(name)
    }
  }
  return names.length > 0 ? names : undefined
}

/** 当前平台的 registry 二进制 key，如 darwin-aarch64 / linux-x86_64 */
function platformKeys(): string[] {
  const archMap: Record<string, string> = {
    arm64: 'aarch64',
    x64: 'x86_64',
    ia32: 'x86'
  }
  const arch = archMap[process.arch] ?? process.arch
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  return [`${platform}-${arch}`, `${platform}-${process.arch}`, `${process.platform}-${arch}`]
}

function pickBinary(distribution: Record<string, unknown>): Record<string, unknown> | undefined {
  const binary = distribution.binary
  if (!isRecord(binary)) return undefined
  for (const key of platformKeys()) {
    const entry = binary[key]
    if (isRecord(entry)) return entry
  }
  return undefined
}

interface LaunchConfig {
  command: string
  args?: string[]
  unavailableReason?: string
}

function parseDistribution(raw: unknown): LaunchConfig | undefined {
  if (!isRecord(raw)) return undefined

  const npx = raw.npx
  if (isRecord(npx)) {
    const pkg = str(npx.package)
    if (pkg) {
      const args = ['-y', pkg, ...(strArray(npx.args) ?? [])]
      return { command: 'npx', args }
    }
  }

  const uvx = raw.uvx
  if (isRecord(uvx)) {
    const pkg = str(uvx.package)
    if (pkg) {
      const args = [pkg, ...(strArray(uvx.args) ?? [])]
      return { command: 'uvx', args }
    }
  }

  const binary = pickBinary(raw)
  if (binary) {
    const command = str(binary.cmd)
    if (command) {
      const args = strArray(binary.args)
      return args ? { command, args } : { command }
    }
  }

  return { command: '', unavailableReason: '当前平台没有可用的分发方式' }
}

function parseAgent(raw: unknown): AcpRegistryAgent | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  if (!id) return null

  const name = str(raw.name) ?? id
  const agent: AcpRegistryAgent = { id, name }

  const version = str(raw.version)
  if (version) agent.version = version
  const description = str(raw.description)
  if (description) agent.description = description
  const repository = str(raw.repository)
  if (repository) agent.repository = repository
  const website = str(raw.website)
  if (website) agent.website = website
  const license = str(raw.license)
  if (license) agent.license = license
  const icon = str(raw.icon)
  if (icon) agent.icon = icon
  const authorList = authors(raw.authors)
  if (authorList) agent.authors = authorList

  const launch = parseDistribution(raw.distribution)
  if (launch?.command) {
    agent.command = launch.command
    if (launch.args) agent.args = launch.args
  } else if (launch?.unavailableReason) {
    agent.unavailableReason = launch.unavailableReason
  }

  return agent
}

function parseRegistry(payload: unknown): AcpRegistryAgent[] {
  let list: unknown[] = []
  if (Array.isArray(payload)) list = payload
  else if (isRecord(payload) && Array.isArray(payload.agents)) list = payload.agents

  const agents: AcpRegistryAgent[] = []
  for (const item of list) {
    const agent = parseAgent(item)
    if (agent) agents.push(agent)
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name))
}

async function fetchRegistry(): Promise<AcpRegistryAgent[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  timer.unref?.()

  try {
    const response = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    })
    if (!response.ok) throw new Error(`registry request failed: ${response.status}`)
    const payload: unknown = await response.json()
    const agents = parseRegistry(payload)
    cache = { fetchedAt: Date.now(), agents }
    return agents
  } finally {
    clearTimeout(timer)
  }
}

/** 带 5 分钟内存缓存；失败时返回旧缓存或空数组 */
export async function getRegistry(): Promise<AcpRegistryAgent[]> {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.agents
  if (inflight) return inflight

  inflight = fetchRegistry().finally(() => {
    inflight = null
  })

  try {
    return await inflight
  } catch {
    return cache?.agents ?? []
  }
}
