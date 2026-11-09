/**
 * MIR Harness 配置文件（~/.mir-harness/config.json）的加载。
 *
 * agent 每个会话 / 每轮开始时都重新读一次磁盘，用户在 MIR 设置里改完配置后
 * 新建会话即可生效，不需要重启 agent 进程。
 *
 * 与主进程侧（src/main/acp/harnessConfig.ts）读同一个文件、走同一套
 * normalizeHarnessConfig()，保证设置界面里看到的就是 agent 实际使用的配置。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_HARNESS_CONFIG,
  HARNESS_API_BASE_ENV,
  HARNESS_API_KEY_ENV,
  HARNESS_CONFIG_ENV,
  HARNESS_CONFIG_FILE_NAME,
  HARNESS_DIR_NAME,
  HARNESS_MODEL_ENV,
  harnessModelLabel,
  normalizeHarnessConfig,
  resolveHarnessModel
} from '../shared/harness'
import type { HarnessConfig, ResolvedHarnessModel } from '../shared/harness'

/** 加载结果：读取失败时也一定带一份可用的配置（默认值 + 环境变量覆盖） */
export interface LoadedHarnessConfig {
  config: HarnessConfig
  path: string
  exists: boolean
  /** 读取 / 解析失败的原因；文件不存在不算错误（首次运行就是默认值） */
  error?: string
}

/**
 * 配置文件路径：默认 ~/.mir-harness/config.json。
 * 环境变量 MIR_HARNESS_CONFIG 可以整体替换路径（测试 / 多实例时用）。
 */
export function harnessConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HARNESS_CONFIG_ENV]?.trim()
  if (override) return override
  return join(homedir(), HARNESS_DIR_NAME, HARNESS_CONFIG_FILE_NAME)
}

/** 默认配置的副本：models 是数组，避免调用方改到共享的 DEFAULT_HARNESS_CONFIG */
function defaultHarnessConfig(): HarnessConfig {
  return {
    ...DEFAULT_HARNESS_CONFIG,
    models: DEFAULT_HARNESS_CONFIG.models.map((model) => ({ ...model }))
  }
}

/**
 * 应用字段级环境变量覆盖。
 *
 * 模型被覆盖时要保证它出现在 models 里，否则下拉框 / 展示名都找不到它；
 * 与主进程侧保持同一行为。
 */
export function applyHarnessEnvOverrides(
  config: HarnessConfig,
  env: NodeJS.ProcessEnv = process.env
): HarnessConfig {
  const next: HarnessConfig = { ...config }

  const apiBase = env[HARNESS_API_BASE_ENV]?.trim()
  if (apiBase) next.apiBase = apiBase

  const apiKey = env[HARNESS_API_KEY_ENV]?.trim()
  if (apiKey) next.apiKey = apiKey

  const model = env[HARNESS_MODEL_ENV]?.trim()
  if (model) {
    next.model = model
    if (!next.models.some((item) => item.id === model)) {
      next.models = [{ id: model, name: model }, ...next.models]
    }
  }

  return next
}

/**
 * 读取配置。
 *
 * 任何失败（文件缺失、JSON 损坏、权限不足……）都回落到 DEFAULT_HARNESS_CONFIG
 * 再叠加环境变量，并把原因放进 error，让 agent 可以提示用户而不是直接崩掉。
 */
export function loadHarnessConfig(env: NodeJS.ProcessEnv = process.env): LoadedHarnessConfig {
  const path = harnessConfigPath(env)
  const exists = existsSync(path)
  const fallback = applyHarnessEnvOverrides(defaultHarnessConfig(), env)

  if (!exists) return { config: fallback, path, exists }

  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return { config: applyHarnessEnvOverrides(normalizeHarnessConfig(raw), env), path, exists }
  } catch (error) {
    return {
      config: fallback,
      path,
      exists,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** ACP 会话配置项里的模型下拉选项（value = 模型 id，name = 展示名） */
export function modelChoices(config: HarnessConfig): { value: string; name: string }[] {
  return config.models.map((model) => ({ value: model.id, name: harnessModelLabel(model) }))
}

/**
 * 解析某个会话当前模型实际要用的接口地址与密钥。
 *
 * modelId 为空或不在 config.models 里时回落到配置的默认模型，避免会话带着
 * 一个被用户从列表里删掉的 id 去发请求。
 */
export function resolveModelForSession(
  config: HarnessConfig,
  modelId: string
): ResolvedHarnessModel {
  const requested = modelId.trim()
  const target = requested && config.models.some((item) => item.id === requested) ? requested : config.model
  return resolveHarnessModel(config, target)
}
