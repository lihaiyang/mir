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
            <button class="acp-btn" type="button" @click="addModel">{{ t('harness.models.add') }}</button>
          </div>
        </div>
        <div class="acp-hint">{{ t('harness.models.hint') }}</div>

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

      <!-- Generation ---------------------------------------------------- -->
      <div class="settings-group">
        <label class="settings-label" for="harness-temperature">{{ t('harness.temperature') }}</label>
        <input
          id="harness-temperature"
          v-model.number="draft.temperature"
          class="settings-input harness-number"
          type="number"
          min="0"
          max="2"
          step="0.1"
          @blur="clampField('temperature')"
        />
        <div class="acp-hint">{{ t('harness.temperatureHint') }}</div>
      </div>

      <div class="settings-group">
        <label class="settings-label" for="harness-max-tokens">{{ t('harness.maxTokens') }}</label>
        <input
          id="harness-max-tokens"
          v-model.number="draft.maxTokens"
          class="settings-input harness-number"
          type="number"
          min="1"
          max="200000"
          step="1"
          @blur="clampField('maxTokens')"
        />
        <div class="acp-hint">{{ t('harness.maxTokensHint') }}</div>
      </div>

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
        <label class="settings-label" for="harness-context-window">{{ t('harness.contextWindow') }}</label>
        <input
          id="harness-context-window"
          v-model.number="draft.contextWindow"
          class="settings-input harness-number"
          type="number"
          min="1000"
          max="2000000"
          step="1000"
          @blur="clampField('contextWindow')"
        />
        <div class="acp-hint">{{ t('harness.contextWindowHint') }}</div>
      </div>

      <!-- Behaviour ----------------------------------------------------- -->
      <div class="settings-group">
        <label class="settings-label" for="harness-approval-mode">{{ t('harness.approvalMode') }}</label>
        <select id="harness-approval-mode" v-model="draft.approvalMode" class="settings-select">
          <option value="ask">{{ t('harness.approvalAsk') }}</option>
          <option value="auto">{{ t('harness.approvalAuto') }}</option>
        </select>
        <div class="acp-hint">{{ t('harness.approvalModeHint') }}</div>
      </div>

      <div class="settings-group">
        <div class="settings-group settings-group-row">
          <label class="settings-label" style="flex: 1" for="harness-send-reasoning">
            {{ t('harness.sendReasoningEffort') }}
          </label>
          <input id="harness-send-reasoning" v-model="draft.sendReasoningEffort" type="checkbox" />
        </div>
        <div class="acp-hint">{{ t('harness.sendReasoningEffortHint') }}</div>
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
import { DEFAULT_HARNESS_CONFIG } from '@shared/harness'
import type {
  HarnessApprovalMode,
  HarnessConfig,
  HarnessConfigSnapshot,
  HarnessModelConfig
} from '@shared/harness'

type NumericKey = 'temperature' | 'maxTokens' | 'maxTurns' | 'contextWindow'

/** Draft row: every field is a plain string so empty inputs stay empty. */
interface ModelRowDraft {
  /** Last committed id; keeps the default-model select in sync while renaming. */
  previousId: string
  id: string
  name: string
  apiBase: string
  apiKey: string
}

interface HarnessDraft {
  apiBase: string
  apiKey: string
  model: string
  models: ModelRowDraft[]
  temperature: number | null
  maxTokens: number | null
  maxTurns: number | null
  contextWindow: number | null
  systemPrompt: string
  approvalMode: HarnessApprovalMode
  sendReasoningEffort: boolean
}

const NUMERIC_KEYS: NumericKey[] = ['temperature', 'maxTokens', 'maxTurns', 'contextWindow']

const NUMERIC_LIMITS: Record<NumericKey, { min: number; max: number; integer: boolean }> = {
  temperature: { min: 0, max: 2, integer: false },
  maxTokens: { min: 1, max: 200_000, integer: true },
  maxTurns: { min: 1, max: 100, integer: true },
  contextWindow: { min: 1_000, max: 2_000_000, integer: true }
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
    options.push({ id, label: row.name.trim() || id })
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
      apiKey: model.apiKey ?? ''
    })),
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    maxTurns: config.maxTurns,
    contextWindow: config.contextWindow,
    systemPrompt: config.systemPrompt,
    approvalMode: config.approvalMode,
    sendReasoningEffort: config.sendReasoningEffort
  }
}

function toConfig(source: HarnessDraft): HarnessConfig {
  const models: HarnessModelConfig[] = []
  const seen = new Set<string>()
  for (const row of source.models) {
    const id = row.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const model: HarnessModelConfig = { id }
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
    temperature: clampNumeric('temperature', source.temperature),
    maxTokens: clampNumeric('maxTokens', source.maxTokens),
    maxTurns: clampNumeric('maxTurns', source.maxTurns),
    contextWindow: clampNumeric('contextWindow', source.contextWindow),
    systemPrompt: source.systemPrompt,
    approvalMode: source.approvalMode,
    sendReasoningEffort: source.sendReasoningEffort
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

function normalizeNumbers(): void {
  for (const key of NUMERIC_KEYS) draft.value[key] = clampNumeric(key, draft.value[key])
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

function addModel(): void {
  draft.value.models.push({ previousId: '', id: '', name: '', apiBase: '', apiKey: '' })
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

onMounted(() => {
  void load()
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
