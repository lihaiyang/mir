<template>
  <div class="userscripts-settings">
    <header class="userscripts-head">
      <h2 class="userscripts-title">{{ t('userscripts.title') }}</h2>
      <p class="userscripts-desc">{{ t('userscripts.description') }}</p>
    </header>

    <div v-if="errorMsg" class="userscripts-error">{{ errorMsg }}</div>
    <div v-if="noticeMsg" class="userscripts-notice">{{ noticeMsg }}</div>

    <!-- Actions ------------------------------------------------------- -->
    <div class="userscripts-actions">
      <button class="us-btn us-btn-primary" :disabled="busy" @click="installFromFile">
        {{ t('userscripts.installFromFile') }}
      </button>
      <button class="us-btn" :disabled="busy" @click="openDir">{{ t('userscripts.openDir') }}</button>
      <button class="us-btn" :disabled="busy" @click="rescan">{{ t('userscripts.rescan') }}</button>
      <button class="us-btn" :disabled="busy" @click="showPaste = !showPaste">
        {{ showPaste ? t('userscripts.cancelPaste') : t('userscripts.pasteInstall') }}
      </button>
    </div>

    <!-- Paste import -------------------------------------------------- -->
    <div v-if="showPaste" class="userscripts-paste">
      <textarea
        v-model="pasteText"
        class="us-textarea"
        spellcheck="false"
        :placeholder="t('userscripts.pastePlaceholder')"
      />
      <div class="userscripts-paste-foot">
        <span class="userscripts-hint">{{ t('userscripts.pasteHint') }}</span>
        <button class="us-btn us-btn-primary" :disabled="busy || !pasteText.trim()" @click="installFromText">
          {{ t('userscripts.install') }}
        </button>
      </div>
    </div>

    <!-- List ---------------------------------------------------------- -->
    <div v-if="loading" class="userscripts-empty">{{ t('common.loading') }}</div>
    <div v-else-if="scripts.length === 0" class="userscripts-empty">
      <p>{{ t('userscripts.empty') }}</p>
      <p class="userscripts-hint">{{ t('userscripts.emptyHint') }}</p>
    </div>

    <div v-else class="userscripts-list">
      <div v-for="script in scripts" :key="script.id" class="us-card" :class="{ disabled: !script.enabled }">
        <div class="us-card-main">
          <div class="us-card-title-row">
            <span class="us-card-name">{{ script.meta.name }}</span>
            <span v-if="script.meta.version" class="us-card-version">v{{ script.meta.version }}</span>
            <span v-if="script.meta.namespace" class="us-card-ns">{{ script.meta.namespace }}</span>
          </div>
          <p v-if="script.meta.description" class="us-card-desc">{{ script.meta.description }}</p>
          <div class="us-card-meta">
            <span v-if="script.meta.author">{{ t('userscripts.author') }}: {{ script.meta.author }}</span>
            <span>{{ t('userscripts.matchCount', { count: script.meta.matches.length + script.meta.includes.length }) }}</span>
            <span>{{ t('userscripts.size', { size: formatSize(script.size) }) }}</span>
          </div>
          <div v-if="script.cacheError" class="us-card-warn">{{ script.cacheError }}</div>
        </div>

        <div class="us-card-actions">
          <label class="us-toggle" :title="t('userscripts.enable')">
            <input type="checkbox" :checked="script.enabled" @change="toggle(script, $event)" />
            <span>{{ t('userscripts.enabled') }}</span>
          </label>
          <button class="us-btn us-btn-sm" :disabled="busy" @click="edit(script)">{{ t('common.edit') }}</button>
          <button class="us-btn us-btn-sm" :disabled="busy" @click="refreshCache(script)">
            {{ t('userscripts.refreshCache') }}
          </button>
          <button class="us-btn us-btn-sm us-btn-danger" :disabled="busy" @click="remove(script)">
            {{ t('common.delete') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Editor -------------------------------------------------------- -->
    <div v-if="editing" class="userscripts-editor">
      <div class="userscripts-editor-head">
        <span class="userscripts-editor-title">{{ editing.meta.name }}</span>
        <span class="userscripts-hint">{{ t('userscripts.editorHint') }}</span>
      </div>
      <textarea v-model="editorSource" class="us-textarea us-textarea-code" spellcheck="false" />
      <div class="userscripts-editor-foot">
        <button class="us-btn" :disabled="busy" @click="closeEditor">{{ t('common.cancel') }}</button>
        <button class="us-btn us-btn-primary" :disabled="busy" @click="saveEditor">{{ t('common.save') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { UserScriptDetail, UserScriptSummary } from '@shared/userscripts'

const { t } = useI18n()

const scripts = ref<UserScriptSummary[]>([])
const loading = ref(true)
const busy = ref(false)
const errorMsg = ref('')
const noticeMsg = ref('')

const showPaste = ref(false)
const pasteText = ref('')

const editing = ref<UserScriptDetail | null>(null)
const editorSource = ref('')

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function clearMessages(): void {
  errorMsg.value = ''
  noticeMsg.value = ''
}

async function run<T>(fn: () => Promise<T>): Promise<T | null> {
  clearMessages()
  busy.value = true
  try {
    return await fn()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
    return null
  } finally {
    busy.value = false
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    scripts.value = await window.electronAPI.userscriptsList()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function installFromFile(): Promise<void> {
  const added = await run(() => window.electronAPI.userscriptsInstallFromFile())
  if (!added) return
  if (added.length === 0) return
  noticeMsg.value = t('userscripts.installed', { count: added.length })
  await load()
}

async function installFromText(): Promise<void> {
  const text = pasteText.value
  const summary = await run(() => window.electronAPI.userscriptsInstall(text))
  if (!summary) return
  pasteText.value = ''
  showPaste.value = false
  noticeMsg.value = t('userscripts.installedOne', { name: summary.meta.name })
  await load()
}

async function openDir(): Promise<void> {
  await run(() => window.electronAPI.userscriptsOpenDir())
}

async function rescan(): Promise<void> {
  const list = await run(() => window.electronAPI.userscriptsRescan())
  if (list) scripts.value = list
}

async function toggle(script: UserScriptSummary, event: Event): Promise<void> {
  const enabled = (event.target as HTMLInputElement).checked
  const updated = await run(() => window.electronAPI.userscriptsSetEnabled(script.id, enabled))
  if (updated) await load()
}

async function refreshCache(script: UserScriptSummary): Promise<void> {
  const updated = await run(() => window.electronAPI.userscriptsRefreshCache(script.id))
  if (!updated) return
  noticeMsg.value = updated.cacheError
    ? updated.cacheError
    : t('userscripts.cacheReady', { name: updated.meta.name })
  await load()
}

async function remove(script: UserScriptSummary): Promise<void> {
  if (!window.confirm(t('userscripts.confirmRemove', { name: script.meta.name }))) return
  const done = await run(async () => {
    await window.electronAPI.userscriptsRemove(script.id)
    return true
  })
  if (!done) return
  if (editing.value?.id === script.id) closeEditor()
  await load()
}

async function edit(script: UserScriptSummary): Promise<void> {
  const detail = await run(() => window.electronAPI.userscriptsDetail(script.id))
  if (!detail) return
  editing.value = detail
  editorSource.value = detail.source
}

function closeEditor(): void {
  editing.value = null
  editorSource.value = ''
}

async function saveEditor(): Promise<void> {
  const current = editing.value
  if (!current) return
  const saved = await run(() => window.electronAPI.userscriptsSave(current.id, editorSource.value))
  if (!saved) return
  noticeMsg.value = t('userscripts.saved', { name: saved.meta.name })
  closeEditor()
  await load()
}

onMounted(load)
</script>

<style scoped>
.userscripts-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  max-width: 100%;
  color: var(--text-primary);
  font-size: var(--text-md);
}

.userscripts-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.userscripts-title {
  font-size: var(--text-lg);
  font-weight: 600;
}
.userscripts-desc {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.5;
}

.userscripts-error,
.userscripts-notice {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  line-height: 1.5;
  word-break: break-word;
}
.userscripts-error {
  color: var(--danger-color, #e5534b);
  background: color-mix(in srgb, var(--danger-color, #e5534b) 12%, transparent);
}
.userscripts-notice {
  color: var(--text-secondary);
  background: var(--bg-hover, rgba(127, 127, 127, 0.1));
}

.userscripts-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.us-btn {
  padding: 5px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary, transparent);
  color: var(--text-primary);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.us-btn:hover:not(:disabled) {
  background: var(--bg-hover, rgba(127, 127, 127, 0.12));
}
.us-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.us-btn-primary {
  border-color: var(--accent-color, #3b82f6);
  color: var(--accent-color, #3b82f6);
}
.us-btn-sm {
  padding: 3px 8px;
  font-size: var(--text-xs);
}
.us-btn-danger:hover:not(:disabled) {
  border-color: var(--danger-color, #e5534b);
  color: var(--danger-color, #e5534b);
}

.userscripts-paste {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.userscripts-paste-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.us-textarea {
  width: 100%;
  min-height: 110px;
  padding: var(--space-2);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-input, transparent);
  color: var(--text-primary);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-sm);
  line-height: 1.5;
  resize: vertical;
  box-sizing: border-box;
}
.us-textarea-code {
  min-height: 320px;
  white-space: pre;
  overflow: auto;
}

.userscripts-hint {
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: 1.5;
}

.userscripts-empty {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4) 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.userscripts-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.us-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-secondary, transparent);
}
.us-card.disabled {
  opacity: 0.6;
}
.us-card-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.us-card-title-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
  min-width: 0;
}
.us-card-name {
  font-weight: 600;
  font-size: var(--text-md);
  word-break: break-word;
}
.us-card-version,
.us-card-ns {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.us-card-desc {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.5;
  word-break: break-word;
}
.us-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.us-card-warn {
  color: var(--warning-color, #d29922);
  font-size: var(--text-xs);
  line-height: 1.5;
  word-break: break-word;
}

.us-card-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  flex-shrink: 0;
}
.us-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
  white-space: nowrap;
}

.userscripts-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 6px);
}
.userscripts-editor-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}
.userscripts-editor-title {
  font-weight: 600;
  font-size: var(--text-md);
}
.userscripts-editor-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
