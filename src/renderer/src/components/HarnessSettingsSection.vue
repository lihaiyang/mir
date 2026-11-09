<template>
  <div class="harness-settings">
    <header class="harness-settings-head">
      <h2 class="harness-settings-title">{{ t('harness.title') }}</h2>
      <p class="harness-settings-desc">{{ t('harness.description') }}</p>

      <div class="harness-path">
        <span class="harness-path-label">{{ t('harness.configPath') }}</span>
        <code class="harness-path-value" :title="configPath">{{ configPath || t('harness.configPathUnknown') }}</code>
        <span v-if="snapshot && !snapshot.exists" class="harness-path-tag">
          {{ t('harness.configMissing') }}
        </span>
      </div>

      <div v-if="envOverrides.length > 0" class="harness-notice">
        {{ t('harness.envOverride', { vars: envOverrides.join(', ') }) }}
      </div>
      <div v-if="configError" class="acp-error">{{ t('harness.parseError', { error: configError }) }}</div>
      <div v-if="loadError" class="acp-error">{{ loadError }}</div>
    </header>

    <div class="harness-actions">
      <span v-if="saved" class="acp-saved">{{ t('harness.saved') }}</span>
      <button class="acp-btn" type="button" :disabled="loading || saving" @click="reload">
        {{ t('harness.reload') }}
      </button>
      <button
        class="acp-btn acp-btn-primary"
        type="button"
        :disabled="loading || saving || !snapshot"
        @click="save"
      >
        {{ saving ? t('harness.saving') : t('harness.save') }}
      </button>
    </div>

    <div v-if="saveError" class="acp-error">{{ saveError }}</div>
    <div v-if="saved" class="acp-hint">{{ t('harness.newSessionHint') }}</div>
    <div v-if="loading && !snapshot" class="acp-hint">{{ t('harness.loading') }}</div>

    <template v-if="snapshot">
      <!-- Endpoint ------------------------------------------------------ -->
      <div class="settings-group">
        <label class="settings-label" for="harness-api-base">{{ t('harness.apiBase') }}</label>
        <input
          id="harness-api-base"
          v-model="draft.apiBase"
          class="settings-input"
          type="text"
          spellcheck="false"
          placeholder="https://api.deepseek.com/v1"
          @blur="onEndpointBlur"
        />
        <div class="acp-hint">{{ t('harness.apiBaseHint') }}</div>
      </div>

      <div class="settings-group">
        <label class="settings-label" for="harness-api-key">{{ t('harness.apiKey') }}</label>
        <div class="acp-row">
          <input
            id="harness-api-key"
            v-model="draft.apiKey"
            class="settings-input"
            :type="showApiKey ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('harness.apiKeyPlaceholder')"
            @blur="onEndpointBlur"
          />
          <button class="acp-btn" type="button" @click="showApiKey = !showApiKey">
            {{ showApiKey ? t('harness.apiKeyHide') : t('harness.apiKeyShow') }}
          </button>
        </div>
        <div class="acp-hint">{{ t('harness.apiKeyHint') }}</div>
      </div>

      <div class="settings-group">
        <label class="settings-label" for="harness-model">{{ t('harness.model') }}</label>
        <select id="harness-model" v-model="draft.model" class="settings-select">
          <option v-for="option in modelOptions" :key="option.id" :value="option.id">
            {{ option.label }}
          </option>
        </select>
        <div class="acp-hint">{{ t('harness.modelHint') }}</div>
      </div>

      <!-- Models -------------------------------------------------------- -->
      <div class="acp-block">
        <div class="acp-block-head">
          <span class="acp-block-title">{{ t('harness.models.title') }}</span>
          <div class="acp-block-actions">
            <button
              class="acp-btn"
              type="button"
              :disabled="fetchingModels || loading || saving || !draft.apiBase.trim()"
              :title="t('harness.models.fetchHint')"
              @click="fetchModels()"
            >
              {{ fetchingModels ? t('harness.models.fetching') : t('harness.models.fetch') }}
            </button>
            <button class="acp-btn" type="button" @click="addModel">{{ t('harness.models.add') }}</button>
          </div>
        </div>
        <div class="acp-hint">{{ t('harness.models.hint') }}</div>
        <div v-if="fetchMessage" class="acp-hint harness-fetch-status">{{ fetchMessage }}</div>
        <div v-if="fetchError" class="acp-error">{{ fetchError }}</div>

        <div v-for="(row, index) in draft.models" :key="index" class="harness-model-row">
          <input
            v-model="row.id"
            class="settings-input"
            type="text"
            spellcheck="false"
            :placeholder="t('harness.models.idPlaceholder')"
            @change="onModelIdChange(index)"
          />
          <input
            v-model="row.name"
            class="settings-input"
            type="text"
            :placeholder="t('harness.models.namePlaceholder')"
          />
          <button
            class="acp-btn acp-btn-sm acp-btn-danger"
            type="button"
            :disabled="draft.models.length <= 1"
            :title="draft.models.length <= 1 ? t('harness.models.keepOne') : t('common.remove')"
            @click="removeModel(index)"
          >
            {{ t('common.remove') }}
          </button>
          <div class="harness-model-grid">
            <label class="harness-model-field">
              <span>{{ t('harness.models.reasoningEffort') }}</span>
              <select v-model="row.reasoningEffort" class="settings-select">
                <option value="max">Max</option>
                <option value="high">High</option>
              </select>
            </label>
            <label class="harness-model-field">
              <span>{{ t('harness.models.contextWindow') }}</span>
              <input
                v-model="row.contextWindow"
                class="settings-input"
                type="number"
                min="1000"
                max="10000000"
                step="1000"
                @blur="clampModelField(index, 'contextWindow')"
              />
            </label>
            <label class="harness-model-field">
              <span>{{ t('harness.models.maxTokens') }}</span>
              <input
                v-model="row.maxTokens"
                class="settings-input"
                type="number"
                min="1"
                max="1000000"
                step="1"
                @blur="clampModelField(index, 'maxTokens')"
              />
            </label>
            <label class="harness-model-field harness-model-check">
              <input v-model="row.supportsImages" type="checkbox" />
              <span>{{ t('harness.models.supportsImages') }}</span>
            </label>
          </div>
          <input
            v-model="row.apiBase"
            class="settings-input harness-model-override"
            type="text"
            spellcheck="false"
            :placeholder="t('harness.models.apiBasePlaceholder')"
          />
          <input
            v-model="row.apiKey"
            class="settings-input harness-model-override"
            type="password"
            autocomplete="off"
            :placeholder="t('harness.models.apiKeyPlaceholder')"
          />
        </div>
      </div>

      <!-- Behaviour ----------------------------------------------------- -->
      <div class="settings-group">
        <label class="settings-label" for="harness-max-turns">{{ t('harness.maxTurns') }}</label>
        <input
          id="harness-max-turns"
          v-model.number="draft.maxTurns"
          class="settings-input harness-number"
          type="number"
          min="1"
          max="100"
          step="1"
          @blur="clampField('maxTurns')"
        />
        <div class="acp-hint">{{ t('harness.maxTurnsHint') }}</div>
      </div>

      <div class="settings-group">
        <label class="settings-label" for="harness-approval-mode">{{ t('harness.approvalMode') }}</label>
        <select id="harness-approval-mode" v-model="draft.approvalMode" class="settings-select">
          <option value="ask">{{ t('harness.approvalAsk') }}</option>
          <option value="auto">{{ t('harness.approvalAuto') }}</option>
        </select>
        <div class="acp-hint">{{ t('harness.approvalModeHint') }}</div>
      </div>

      <div class="settings-group">
        <label class="settings-label" for="harness-system-prompt">{{ t('harness.systemPrompt') }}</label>
        <textarea
          id="harness-system-prompt"
          v-model="draft.systemPrompt"
          class="settings-input acp-textarea"
          rows="8"
          spellcheck="false"
        />
        <div class="acp-hint">{{ t('harness.systemPromptHint') }}</div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  DEFAULT_HARNESS_CONFIG,
  DEFAULT_HARNESS_REASONING_EFFORT,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  DEFAULT_MODEL_SUPPORTS_IMAGES
} from '@shared/harness'
import type {
  HarnessApprovalMode,
  HarnessConfig,
  HarnessConfigSnapshot,
  HarnessModelConfig,
  HarnessReasoningEffort
} from '@shared/harness'
import type { DiscoveredHarnessModel, HarnessModelFormat } from '@shared/harnessModels'

type NumericKey = 'maxTurns'

type ModelNumericKey = 'contextWindow' | 'maxTokens'

/**
 * Draft row: text-ish fields stay strings so empty inputs stay empty.
 * Per-model reasoning effort / image support / context window / max output live here.
 */
interface ModelRowDraft {
  /** Last committed id; keeps the default-model select in sync while renaming. */
  previousId: string
  id: string
  name: string
  apiBase: string
  apiKey: string
  reasoningEffort: HarnessReasoningEffort
  supportsImages: boolean
  contextWindow: string
  maxTokens: string
}

interface HarnessDraft {
  apiBase: string
  apiKey: string
  model: string
  models: ModelRowDraft[]
  maxTurns: number | null
  systemPrompt: string
  approvalMode: HarnessApprovalMode
}

const NUMERIC_KEYS: NumericKey[] = ['maxTurns']

const NUMERIC_LIMITS: Record<NumericKey, { min: number; max: number; integer: boolean }> = {
  maxTurns: { min: 1, max: 100, integer: true }
}

const MODEL_NUMERIC_LIMITS: Record<ModelNumericKey, { min: number; max: number; fallback: number }> = {
  contextWindow: { min: 1_000, max: 10_000_000, fallback: DEFAULT_MODEL_CONTEXT_WINDOW },
  maxTokens: { min: 1, max: 1_000_000, fallback: DEFAULT_MODEL_MAX_TOKENS }
}

const MODEL_FORMAT_LABEL_KEYS: Record<HarnessModelFormat, string> = {
  openai: 'harness.models.format.openai',
  anthropic: 'harness.models.format.anthropic',
  google: 'harness.models.format.google',
  ollama: 'harness.models.format.ollama',
  generic: 'harness.models.format.generic'
}

const { t } = useI18n()

const snapshot = ref<HarnessConfigSnapshot | null>(null)
const draft = ref<HarnessDraft>(toDraft(DEFAULT_HARNESS_CONFIG))
const loading = ref(false)
const saving = ref(false)
const saved = ref(false)
const loadError = ref('')
const saveError = ref('')
const showApiKey = ref(false)
const fetchingModels = ref(false)
const fetchMessage = ref('')
const fetchError = ref('')
/** 上一次成功拉取时的 apiBase + apiKey，避免同一配置重复请求。 */
let lastFetchSignature = ''
/** 上一次拉取写入的模型 id，用于判断「列表是不是自动拉出来的」。 */
let lastFetchedIds: string[] = []

let savedTimer: ReturnType<typeof setTimeout> | null = null

const defaults = computed<HarnessConfig>(() => snapshot.value?.defaults ?? DEFAULT_HARNESS_CONFIG)
const configPath = computed(() => snapshot.value?.path ?? '')
const envOverrides = computed(() => snapshot.value?.envOverrides ?? [])
const configError = computed(() => snapshot.value?.error ?? '')

const modelOptions = computed<Array<{ id: string; label: string }>>(() => {
  const options: Array<{ id: string; label: string }> = []
  const seen = new Set<string>()
  for (const row of draft.value.models) {
    const id = row.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = row.name.trim()
    options.push({ id, label: name && name !== id ? `${name} — ${id}` : id })
  }
  // Keep the select usable even when the list is mid-edit.
  const selected = draft.value.model.trim()
  if (selected && !seen.has(selected)) options.unshift({ id: selected, label: selected })
  return options
})

/* ------------------------------- helpers -------------------------------- */

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  return typeof e === 'string' ? e : String(e)
}

function toDraft(config: HarnessConfig): HarnessDraft {
  return {
    apiBase: config.apiBase,
    apiKey: config.apiKey,
    model: config.model,
    models: config.models.map((model) => ({
      previousId: model.id,
      id: model.id,
      name: model.name ?? '',
      apiBase: model.apiBase ?? '',
      apiKey: model.apiKey ?? '',
      reasoningEffort: model.reasoningEffort ?? DEFAULT_HARNESS_REASONING_EFFORT,
      supportsImages:
        typeof model.supportsImages === 'boolean' ? model.supportsImages : DEFAULT_MODEL_SUPPORTS_IMAGES,
      contextWindow: String(model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW),
      maxTokens: String(model.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS)
    })),
    maxTurns: config.maxTurns,
    systemPrompt: config.systemPrompt,
    approvalMode: config.approvalMode
  }
}

function toConfig(source: HarnessDraft): HarnessConfig {
  const models: HarnessModelConfig[] = []
  const seen = new Set<string>()
  for (const row of source.models) {
    const id = row.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const model: HarnessModelConfig = {
      id,
      reasoningEffort: row.reasoningEffort === 'high' ? 'high' : 'max',
      supportsImages: row.supportsImages,
      contextWindow: clampModelNumber('contextWindow', row.contextWindow),
      maxTokens: clampModelNumber('maxTokens', row.maxTokens)
    }
    const name = row.name.trim()
    if (name) model.name = name
    const apiBase = row.apiBase.trim()
    if (apiBase) model.apiBase = apiBase
    const apiKey = row.apiKey.trim()
    if (apiKey) model.apiKey = apiKey
    models.push(model)
  }

  // Never save an empty model list: the main process would then insert the
  // defaults, silently changing what the user picked.
  if (models.length === 0) {
    for (const model of defaults.value.models) models.push({ ...model })
  }

  const selected = source.model.trim()
  const model = models.some((item) => item.id === selected)
    ? selected
    : (models[0]?.id ?? defaults.value.model)

  return {
    apiBase: source.apiBase.trim(),
    apiKey: source.apiKey.trim(),
    model,
    models,
    maxTurns: clampNumeric('maxTurns', source.maxTurns),
    systemPrompt: source.systemPrompt,
    approvalMode: source.approvalMode
  }
}

function clampNumeric(key: NumericKey, raw: unknown): number {
  const limits = NUMERIC_LIMITS[key]
  const fallback = defaults.value[key]
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN
  if (!Number.isFinite(value)) return fallback
  const clamped = Math.min(limits.max, Math.max(limits.min, value))
  return limits.integer ? Math.round(clamped) : Math.round(clamped * 10) / 10
}

/** Called on blur: an empty / invalid input falls back to the default value. */
function clampField(key: NumericKey): void {
  draft.value[key] = clampNumeric(key, draft.value[key])
}

function clampModelNumber(key: ModelNumericKey, raw: unknown): number {
  const limits = MODEL_NUMERIC_LIMITS[key]
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN
  if (!Number.isFinite(value)) return limits.fallback
  return Math.round(Math.min(limits.max, Math.max(limits.min, value)))
}

/** 每个模型的数字项失焦时归一化（空值回落默认值） */
function clampModelField(index: number, key: ModelNumericKey): void {
  const row = draft.value.models[index]
  if (!row) return
  row[key] = String(clampModelNumber(key, row[key]))
}

function normalizeNumbers(): void {
  for (const key of NUMERIC_KEYS) draft.value[key] = clampNumeric(key, draft.value[key])
  for (const row of draft.value.models) {
    row.contextWindow = String(clampModelNumber('contextWindow', row.contextWindow))
    row.maxTokens = String(clampModelNumber('maxTokens', row.maxTokens))
  }
}

function flashSaved(): void {
  saved.value = true
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => {
    saved.value = false
    savedTimer = null
  }, 4000)
}

/* ------------------------------- persistence ---------------------------- */

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  saveError.value = ''
  saved.value = false
  if (savedTimer) {
    clearTimeout(savedTimer)
    savedTimer = null
  }
  try {
    const result = await window.electronAPI.acpGetHarnessConfig()
    snapshot.value = result
    draft.value = toDraft(result.config)
  } catch (e) {
    loadError.value = errorText(e)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (saving.value || !snapshot.value) return
  normalizeNumbers()
  const config = toConfig(draft.value)
  // Keep the select and the list consistent with what is about to be written.
  draft.value.model = config.model
  saving.value = true
  saveError.value = ''
  saved.value = false
  try {
    const result = await window.electronAPI.acpSetHarnessConfig(config)
    snapshot.value = result
    draft.value = toDraft(result.config)
    flashSaved()
  } catch (e) {
    saveError.value = errorText(e)
  } finally {
    saving.value = false
  }
}

async function reload(): Promise<void> {
  await load()
}

/* ------------------------------- model list ----------------------------- */

function newModelRow(model: { id?: string; name?: string } = {}): ModelRowDraft {
  const id = model.id ?? ''
  return {
    previousId: id,
    id,
    name: model.name ?? '',
    apiBase: '',
    apiKey: '',
    reasoningEffort: DEFAULT_HARNESS_REASONING_EFFORT,
    supportsImages: DEFAULT_MODEL_SUPPORTS_IMAGES,
    contextWindow: String(DEFAULT_MODEL_CONTEXT_WINDOW),
    maxTokens: String(DEFAULT_MODEL_MAX_TOKENS)
  }
}

function addModel(): void {
  draft.value.models.push(newModelRow())
}

function removeModel(index: number): void {
  if (draft.value.models.length <= 1) return
  const removed = draft.value.models[index]
  draft.value.models.splice(index, 1)
  const stillListed = draft.value.models.some((row) => row.id.trim() === draft.value.model.trim())
  if (removed && !stillListed) {
    // The deleted row was the selected model: fall back to the first one.
    draft.value.model = draft.value.models[0]?.id.trim() ?? ''
  }
}

function onModelIdChange(index: number): void {
  const row = draft.value.models[index]
  if (!row) return
  const next = row.id.trim()
  if (next && next !== row.previousId && draft.value.model === row.previousId) {
    draft.value.model = next
  }
  row.previousId = next
}

/* ------------------------- 从接口拉取模型列表 -------------------------- */

function currentModelSignature(): string {
  return `${draft.value.apiBase.trim()}\u0000${draft.value.apiKey.trim()}`
}

/** 模型列表还是默认那两条时，可以放心用接口结果整表替换。 */
function rowsLookPristine(): boolean {
  const rows = draft.value.models.filter((row) => row.id.trim())
  const base = defaults.value.models
  if (rows.length !== base.length) return false
  return base.every((model, index) => {
    const row = rows[index]
    if (!row) return false
    return (
      row.id.trim() === model.id &&
      row.name.trim() === (model.name ?? '') &&
      !row.apiBase.trim() &&
      !row.apiKey.trim() &&
      row.reasoningEffort === (model.reasoningEffort ?? DEFAULT_HARNESS_REASONING_EFFORT) &&
      row.supportsImages ===
        (typeof model.supportsImages === 'boolean' ? model.supportsImages : DEFAULT_MODEL_SUPPORTS_IMAGES) &&
      clampModelNumber('contextWindow', row.contextWindow) ===
        (model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW) &&
      clampModelNumber('maxTokens', row.maxTokens) === (model.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS)
    )
  })
}

/** 列表与上次自动拉取的结果一致时，换地址重拉可以直接替换。 */
function rowsMatchLastFetch(): boolean {
  if (lastFetchedIds.length === 0) return false
  const ids = draft.value.models.map((row) => row.id.trim()).filter(Boolean)
  return ids.length === lastFetchedIds.length && ids.every((id, index) => id === lastFetchedIds[index])
}

function mergeFetchedModels(models: DiscoveredHarnessModel[]): void {
  const replace =
    rowsLookPristine() || rowsMatchLastFetch() || draft.value.models.every((row) => !row.id.trim())
  if (replace) {
    draft.value.models = models.map((model) => newModelRow({ id: model.id, name: model.name ?? '' }))
  } else {
    // 用户自己维护过列表：只补新出现的模型，不动已有条目（保留自定义名字 / 覆盖项）。
    const existing = new Set(draft.value.models.map((row) => row.id.trim()).filter(Boolean))
    for (const model of models) {
      if (existing.has(model.id)) continue
      draft.value.models.push(newModelRow({ id: model.id, name: model.name ?? '' }))
    }
  }

  lastFetchedIds = draft.value.models.map((row) => row.id.trim()).filter(Boolean)
  const selected = draft.value.model.trim()
  if (!selected || !draft.value.models.some((row) => row.id.trim() === selected)) {
    draft.value.model = draft.value.models[0]?.id.trim() ?? ''
  }
}

async function fetchModels(options: { auto?: boolean } = {}): Promise<void> {
  if (fetchingModels.value) return
  const apiBase = draft.value.apiBase.trim()
  if (!apiBase) {
    if (!options.auto) fetchError.value = t('harness.models.fetchNoBase')
    return
  }

  fetchingModels.value = true
  fetchError.value = ''
  fetchMessage.value = ''
  try {
    const result = await window.electronAPI.acpDiscoverHarnessModels({
      apiBase,
      apiKey: draft.value.apiKey.trim() || undefined
    })
    if (!result.ok || result.models.length === 0) {
      fetchError.value = t('harness.models.fetchFailed', {
        error: result.error || t('harness.models.fetchEmpty')
      })
      return
    }
    mergeFetchedModels(result.models)
    lastFetchSignature = currentModelSignature()
    const formatKey = MODEL_FORMAT_LABEL_KEYS[result.format ?? 'generic'] ?? MODEL_FORMAT_LABEL_KEYS.generic
    fetchMessage.value = t('harness.models.fetchSuccess', {
      count: result.models.length,
      format: t(formatKey)
    })
  } catch (e) {
    fetchError.value = t('harness.models.fetchFailed', { error: errorText(e) })
  } finally {
    fetchingModels.value = false
  }
}

/** 地址 / 密钥失焦时自动拉一次；用户手改过模型列表后不再自动覆盖。 */
function onEndpointBlur(): void {
  const apiBase = draft.value.apiBase.trim()
  if (!apiBase) return
  if (currentModelSignature() === lastFetchSignature) return
  if (!rowsLookPristine() && !rowsMatchLastFetch() && draft.value.models.some((row) => row.id.trim())) return
  void fetchModels({ auto: true })
}

onMounted(() => {
  void (async () => {
    await load()
    // 首次打开设置（模型列表还是默认值）时自动拉一次，省掉手动点按钮。
    if (snapshot.value && draft.value.apiBase.trim() && rowsLookPristine()) {
      void fetchModels({ auto: true })
    }
  })()
})

onBeforeUnmount(() => {
  if (savedTimer) {
    clearTimeout(savedTimer)
    savedTimer = null
  }
})
</script>

<style scoped>
/* Mirrors AcpSettingsSection.vue: the settings-* / acp-* classes are scoped to
   their own components, so this section has to re-declare the ones it reuses. */
.harness-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  max-width: 100%;
  color: var(--text-primary);
  font-size: var(--text-md);
}

.harness-settings-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.harness-settings-title {
  font-size: var(--text-lg);
  font-weight: 600;
}
.harness-settings-desc {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.5;
}

.harness-path {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-size: var(--text-xs);
}
.harness-path-label {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-weight: 600;
}
.harness-path-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  color: var(--text-faint);
}
.harness-path-tag {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-faint);
}

.harness-notice {
  padding: 5px 8px;
  font-size: var(--text-xs);
  line-height: 1.5;
  color: var(--text-warning);
  background: rgba(229, 192, 123, 0.12);
  border-radius: var(--radius-sm);
  word-break: break-word;
}

.harness-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  min-width: 0;
}

/* Mirrors the settings-tab form classes; see the note above. */
.settings-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.settings-group-row {
  flex-direction: row;
  align-items: center;
}
.settings-label {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  font-weight: 600;
}
.settings-input {
  width: 100%;
  min-width: 0;
  padding: 4px 8px;
  font-size: var(--text-md);
}
.settings-select {
  padding: 4px 8px;
  font-size: var(--text-md);
  align-self: flex-start;
  max-width: 100%;
}
.harness-number {
  max-width: 180px;
}

.acp-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.acp-error {
  padding: 5px 8px;
  font-size: var(--text-xs);
  color: var(--text-danger);
  background: rgba(244, 112, 112, 0.1);
  border-radius: var(--radius-sm);
  word-break: break-word;
  white-space: pre-wrap;
}

.acp-hint {
  font-size: var(--text-xs);
  color: var(--text-faint);
  line-height: 1.5;
}

.harness-fetch-status {
  color: var(--text-success);
}

.acp-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 3px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.acp-btn:not(:disabled):hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}
.acp-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.acp-btn-primary {
  background: var(--bg-active);
  border-color: transparent;
}
.acp-btn-primary:not(:disabled):hover {
  background: var(--bg-selected);
}
.acp-btn-sm {
  padding: 1px 8px;
  font-size: var(--text-xs);
}
.acp-btn-danger {
  color: var(--text-danger);
}
.acp-btn-danger:not(:disabled):hover {
  background: rgba(244, 112, 112, 0.12);
}

.acp-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-color);
}
.acp-block-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.acp-block-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.acp-block-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-left: auto;
}
.acp-saved {
  font-size: var(--text-xs);
  color: var(--text-success);
}

.harness-model-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-2);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}
.harness-model-grid {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-2);
  align-items: end;
}
.harness-model-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
.harness-model-check {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
}
.harness-model-override {
  grid-column: 1 / -1;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.acp-textarea {
  resize: vertical;
  min-height: 120px;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.5;
}
</style>
