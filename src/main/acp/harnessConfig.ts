/**
 * MIR Harness 配置文件（~/.mir-harness/config.json）的读写。
 *
 * agent 进程启动时自己也会读同一个文件（见 src/agent/config.ts），
 * 主进程这边只负责让 MIR 的设置界面能查看 / 编辑它。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_HARNESS_CONFIG,
  HARNESS_API_BASE_ENV,
  HARNESS_API_KEY_ENV,
  HARNESS_CONFIG_ENV,
  HARNESS_CONFIG_FILE_NAME,
  HARNESS_DIR_NAME,
  HARNESS_MODEL_ENV,
  normalizeHarnessConfig
} from '../../shared/harness'
import type { HarnessConfig, HarnessConfigSnapshot } from '../../shared/harness'

export type { HarnessConfigSnapshot }

const ENV_OVERRIDES = [HARNESS_API_BASE_ENV, HARNESS_API_KEY_ENV, HARNESS_MODEL_ENV] as const

export function harnessConfigPath(): string {
  const override = process.env[HARNESS_CONFIG_ENV]?.trim()
  if (override) return override
  return join(homedir(), HARNESS_DIR_NAME, HARNESS_CONFIG_FILE_NAME)
}

/** 把环境变量覆盖应用到配置上（与 agent 侧行为保持一致） */
export function applyHarnessEnvOverrides(config: HarnessConfig): HarnessConfig {
  const next: HarnessConfig = { ...config }
  const apiBase = process.env[HARNESS_API_BASE_ENV]?.trim()
  if (apiBase) next.apiBase = apiBase
  const apiKey = process.env[HARNESS_API_KEY_ENV]?.trim()
  if (apiKey) next.apiKey = apiKey
  const model = process.env[HARNESS_MODEL_ENV]?.trim()
  if (model) {
    next.model = model
    if (!next.models.some((item) => item.id === model)) {
      next.models = [{ id: model, name: model }, ...next.models]
    }
  }
  return next
}

function activeEnvOverrides(): string[] {
  return ENV_OVERRIDES.filter((key) => Boolean(process.env[key]?.trim()))
}

/** 读取配置；文件不存在 / 解析失败都返回默认值，并把原因带回界面 */
export function readHarnessConfig(): HarnessConfigSnapshot {
  const path = harnessConfigPath()
  const snapshot: HarnessConfigSnapshot = {
    path,
    exists: existsSync(path),
    config: applyHarnessEnvOverrides(DEFAULT_HARNESS_CONFIG),
    defaults: DEFAULT_HARNESS_CONFIG,
    envOverrides: activeEnvOverrides()
  }

  if (!snapshot.exists) return snapshot

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    snapshot.config = applyHarnessEnvOverrides(normalizeHarnessConfig(raw))
  } catch (error) {
    snapshot.error = error instanceof Error ? error.message : String(error)
  }
  return snapshot
}

/**
 * 保存配置：先归一化，再原子写入（先写临时文件再 rename），避免写坏用户已有的配置。
 * 返回保存后的快照，界面可以直接用它刷新。
 */
export function saveHarnessConfig(raw: unknown): HarnessConfigSnapshot {
  const path = harnessConfigPath()
  const config = normalizeHarnessConfig(raw)
  const payload = `${JSON.stringify(config, null, 2)}\n`

  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, payload, 'utf8')
  renameSync(temp, path)

  return {
    path,
    exists: true,
    config: applyHarnessEnvOverrides(config),
    defaults: DEFAULT_HARNESS_CONFIG,
    envOverrides: activeEnvOverrides()
  }
}
