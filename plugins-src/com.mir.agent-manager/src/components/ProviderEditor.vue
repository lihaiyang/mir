<template>
  <div class="provider-editor">
    <!-- Provider list -->
    <div class="pe-provider-bar">
      <select v-model="selectedProviderId" class="pe-select">
        <option value="">— Select provider —</option>
        <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }} ({{ p.id }})</option>
      </select>
      <button class="pe-btn" @click="startAddProvider">+ Add</button>
      <button class="pe-btn pe-btn-danger" :disabled="!selectedProviderId" @click="deleteProvider">Delete</button>
    </div>

    <!-- Provider form -->
    <div v-if="draft" class="pe-form">
      <div class="pe-field">
        <label>ID</label>
        <input v-model="draft.id" :disabled="!isNew" class="pe-input" placeholder="sankuai" />
      </div>
      <div class="pe-field">
        <label>Name</label>
        <input v-model="draft.name" class="pe-input" placeholder="Friday" />
      </div>
      <div class="pe-field">
        <label>Base URL</label>
        <input v-model="draft.baseURL" class="pe-input" placeholder="https://api.example.com/v1/" />
      </div>
      <div class="pe-field">
        <label>API Key</label>
        <div class="pe-apikey-row">
          <input v-model="draft.apiKey" :type="showKey ? 'text' : 'password'" class="pe-input" placeholder="sk-..." />
          <button class="pe-btn pe-btn-icon" @click="showKey = !showKey">{{ showKey ? '🙈' : '👁' }}</button>
        </div>
      </div>

      <!-- Models -->
      <div class="pe-models">
        <div class="pe-models-header">
          <span>Models</span>
          <button class="pe-btn pe-btn-sm" @click="addModel">+ Add Model</button>
        </div>
        <div v-for="(m, idx) in draft.models" :key="idx" class="pe-model-row">
          <input v-model="m.id" class="pe-input pe-input-sm" placeholder="model-id" />
          <input v-model="m.name" class="pe-input pe-input-sm" placeholder="Display Name" />
          <input v-model.number="m.contextLimit" type="number" class="pe-input pe-input-sm pe-input-num" placeholder="Context" />
          <input v-model.number="m.outputLimit" type="number" class="pe-input pe-input-sm pe-input-num" placeholder="Output" />
          <button class="pe-btn pe-btn-icon pe-btn-danger" @click="draft.models.splice(idx, 1)">×</button>
        </div>
      </div>

      <!-- Actions -->
      <div class="pe-actions">
        <button class="pe-btn pe-btn-primary" @click="saveProvider">💾 Save</button>
        <button class="pe-btn" @click="resetDraft">↺ Reset</button>
        <button class="pe-btn" :disabled="!draft.baseURL || !draft.apiKey" @click="testConnection">
          {{ testing ? '⏳ Testing...' : '🔌 Test Connection' }}
        </button>
        <span v-if="testResult" :class="['pe-test-result', testResult.success ? 'ok' : 'fail']">
          {{ testResult.success ? '✓ Connected' : '✗ ' + testResult.error }}
        </span>
        <span v-if="saved" class="pe-saved">✓ Saved</span>
      </div>
    </div>

    <!-- Add new provider form -->
    <div v-else-if="isNew" class="pe-form">
      <p class="pe-hint">Enter provider ID to create a new provider:</p>
      <div class="pe-field">
        <label>ID</label>
        <input v-model="newProviderId" class="pe-input" placeholder="e.g. sankuai" @keydown.enter="confirmAddProvider" />
      </div>
      <div class="pe-actions">
        <button class="pe-btn pe-btn-primary" @click="confirmAddProvider">Create</button>
        <button class="pe-btn" @click="isNew = false">Cancel</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { getApi } from '../api-store'
import * as opencodeAdapter from '../adapters/opencode'
import * as piAdapter from '../adapters/pi'
import type { AgentType, ProviderConfig } from '../types'

const props = defineProps<{
  agent: AgentType
  projectPath?: string
}>()

const api = getApi()
const providers = ref<ProviderConfig[]>([])
const selectedProviderId = ref('')
const draft = ref<ProviderConfig | null>(null)
const isNew = ref(false)
const newProviderId = ref('')
const showKey = ref(false)
const saved = ref(false)
const testing = ref(false)
const testResult = ref<{ success: boolean; error?: string } | null>(null)

// Raw config text (kept in memory for format-preserving edits)
let rawText = ''

async function loadConfig() {
  const scope = props.agent === 'opencode' ? 'global' : 'models'
  const result = await api.ipc.invoke('read-config', props.agent, scope, props.projectPath) as any
  if (!result?.exists) {
    rawText = props.agent === 'opencode' ? '{}' : '{"providers":{}}'
  } else {
    rawText = result.content
  }

  if (props.agent === 'opencode') {
    providers.value = opencodeAdapter.parseProviders(rawText)
  } else {
    let settingsText: string | undefined
    const settingsResult = await api.ipc.invoke('read-config', props.agent, 'settings', props.projectPath) as any
    if (settingsResult?.exists) settingsText = settingsResult.content
    providers.value = piAdapter.parseProviders(rawText, settingsText)
  }

  if (providers.value.length > 0 && !selectedProviderId.value) {
    selectedProviderId.value = providers.value[0].id
  }
}

function loadProvider() {
  const p = providers.value.find(p => p.id === selectedProviderId.value)
  if (p) {
    draft.value = JSON.parse(JSON.stringify(p))
    testResult.value = null
    saved.value = false
  } else {
    draft.value = null
  }
}

function startAddProvider() {
  isNew.value = true
  draft.value = null
  selectedProviderId.value = ''
  newProviderId.value = ''
}

function confirmAddProvider() {
  if (!newProviderId.value.trim()) return
  draft.value = {
    id: newProviderId.value.trim(),
    name: newProviderId.value.trim(),
    baseURL: '',
    apiKey: '',
    models: []
  }
  isNew.value = false
  saved.value = false
}

function addModel() {
  if (!draft.value) return
  draft.value.models.push({ id: '', name: '', contextLimit: 0, outputLimit: 0 })
}

function resetDraft() {
  loadProvider()
}

async function saveProvider() {
  if (!draft.value) return
  const scope = props.agent === 'opencode' ? 'global' : 'models'
  const exists = providers.value.some(p => p.id === draft.value!.id)

  if (props.agent === 'opencode') {
    if (exists) {
      rawText = opencodeAdapter.updateProvider(rawText, draft.value)
    } else {
      rawText = opencodeAdapter.addProvider(rawText, draft.value)
    }
    if (draft.value.models.length > 0) {
      rawText = opencodeAdapter.setModels(rawText, draft.value.id, draft.value.models)
    }
  } else {
    if (exists) {
      rawText = piAdapter.updateProvider(rawText, draft.value)
    } else {
      rawText = piAdapter.addProvider(rawText, draft.value)
    }
    if (draft.value.models.length > 0) {
      rawText = piAdapter.setModels(rawText, draft.value.id, draft.value.models)
    }
  }

  await api.ipc.invoke('write-config', props.agent, scope, rawText, props.projectPath)
  saved.value = true
  setTimeout(() => { saved.value = false }, 2000)
  await loadConfig()
  selectedProviderId.value = draft.value.id
}

async function deleteProvider() {
  if (!selectedProviderId.value) return
  const scope = props.agent === 'opencode' ? 'global' : 'models'
  if (props.agent === 'opencode') {
    rawText = opencodeAdapter.deleteProvider(rawText, selectedProviderId.value)
  } else {
    rawText = piAdapter.deleteProvider(rawText, selectedProviderId.value)
  }
  await api.ipc.invoke('write-config', props.agent, scope, rawText, props.projectPath)
  selectedProviderId.value = ''
  draft.value = null
  await loadConfig()
}

async function testConnection() {
  if (!draft.value) return
  testing.value = true
  testResult.value = null
  try {
    const model = draft.value.models[0]?.id || ''
    testResult.value = await api.ipc.invoke('test-connection', draft.value.baseURL, draft.value.apiKey, model) as any
  } catch (e) {
    testResult.value = { success: false, error: String(e) }
  }
  testing.value = false
}

watch(() => props.agent, () => {
  selectedProviderId.value = ''
  draft.value = null
  loadConfig()
})

watch(selectedProviderId, () => {
  isNew.value = false
  loadProvider()
})

onMounted(() => {
  loadConfig()
})
</script>

<style scoped>
.provider-editor { display: flex; flex-direction: column; gap: 16px; }
.pe-provider-bar { display: flex; gap: 8px; align-items: center; }
.pe-select {
  flex: 1;
  padding: 6px 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 13px;
}
.pe-form { display: flex; flex-direction: column; gap: 12px; max-width: 640px; }
.pe-field { display: flex; flex-direction: column; gap: 4px; }
.pe-field label { font-size: 12px; color: var(--text-secondary); }
.pe-input {
  padding: 6px 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 13px;
  outline: none;
}
.pe-input:focus { border-color: var(--text-accent); }
.pe-input:disabled { opacity: 0.6; }
.pe-apikey-row { display: flex; gap: 4px; }
.pe-apikey-row .pe-input { flex: 1; }
.pe-models { display: flex; flex-direction: column; gap: 8px; }
.pe-models-header { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--text-secondary); }
.pe-model-row { display: flex; gap: 4px; align-items: center; }
.pe-input-sm { padding: 4px 6px; font-size: 12px; }
.pe-input-num { width: 90px; }
.pe-btn {
  padding: 5px 12px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.pe-btn:hover { background: var(--bg-hover); }
.pe-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.pe-btn-sm { padding: 3px 8px; font-size: 11px; }
.pe-btn-icon { padding: 4px 8px; }
.pe-btn-primary { background: var(--text-accent); color: #fff; border-color: var(--text-accent); }
.pe-btn-primary:hover { opacity: 0.9; }
.pe-btn-danger { color: #e55; }
.pe-btn-danger:hover { background: rgba(238,85,85,0.15); }
.pe-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.pe-test-result { font-size: 12px; }
.pe-test-result.ok { color: #4a4; }
.pe-test-result.fail { color: #e55; }
.pe-saved { color: #4a4; font-size: 12px; }
.pe-hint { color: var(--text-secondary); font-size: 12px; }
</style>
