<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal ws-modal">
      <div class="modal-title">{{ $t('workspace.title') }}</div>

      <!-- Save current as a new workspace -->
      <div class="ws-save">
        <input
          v-model="newName"
          class="modal-input"
          :placeholder="$t('workspace.namePlaceholder')"
          @keydown.enter="save"
        />
        <button class="btn-primary" :disabled="!newName.trim()" @click="save">
          {{ $t('workspace.saveAs') }}
        </button>
      </div>

      <!-- Workspace list -->
      <div class="ws-list">
        <div v-if="names.length === 0" class="ws-empty">{{ $t('workspace.empty') }}</div>
        <div
          v-for="name in names"
          :key="name"
          class="ws-item"
          :class="{ active: name === workspaceStore.activeName }"
        >
          <input
            v-if="editingName === name"
            v-model="editValue"
            class="modal-input ws-edit"
            @keydown.enter="commitRename(name)"
            @keydown.esc="editingName = ''"
            @blur="commitRename(name)"
          />
          <template v-else>
            <span class="ws-name" @click="switchTo(name)">{{ name }}</span>
            <span class="ws-time">{{ formatTime(workspaceStore.workspaces[name].updatedAt) }}</span>
          </template>
          <button class="ws-btn" :title="$t('common.rename')" @click="startRename(name)"><Icon name="file-text" :size="12" /></button>
          <button class="ws-btn danger" :title="$t('common.remove')" @click="remove(name)"><Icon name="x" :size="12" /></button>
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn-secondary" @click="emit('close')">{{ $t('common.close') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useWorkspaceStore } from '../stores/workspaces'
import Icon from './ui/Icon.vue'

const emit = defineEmits<{ (e: 'close'): void }>()

const workspaceStore = useWorkspaceStore()
const newName = ref('')
const editingName = ref('')
const editValue = ref('')

const names = computed(() => Object.keys(workspaceStore.workspaces).sort((a, b) => {
  return (workspaceStore.workspaces[b].updatedAt ?? 0) - (workspaceStore.workspaces[a].updatedAt ?? 0)
}))

async function save() {
  const n = newName.value.trim()
  if (!n) return
  await workspaceStore.saveAs(n)
  newName.value = ''
}

async function switchTo(name: string) {
  await workspaceStore.switchTo(name)
  window.dispatchEvent(new CustomEvent('statusbar-init'))
  emit('close')
}

async function remove(name: string) {
  await workspaceStore.remove(name)
}

function startRename(name: string) {
  editingName.value = name
  editValue.value = name
}

async function commitRename(name: string) {
  if (editingName.value !== name) return
  const val = editValue.value.trim()
  editingName.value = ''
  if (val && val !== name) await workspaceStore.rename(name, val)
}

function formatTime(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : ''
}
</script>

<style scoped>
.ws-modal {
  width: 480px;
  max-width: 90vw;
}
.ws-save {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}
.ws-save .modal-input {
  flex: 1;
}
.ws-list {
  max-height: 340px;
  overflow-y: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}
.ws-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-faint);
  font-size: var(--text-sm);
}
.ws-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  font-size: var(--text-md);
}
.ws-item + .ws-item {
  border-top: 1px solid var(--border-subtle);
}
.ws-item.active {
  background: var(--bg-selected);
}
.ws-name {
  flex: 1;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-name:hover { color: var(--accent-strong); }
.ws-time {
  font-size: var(--text-xs);
  color: var(--text-faint);
  white-space: nowrap;
}
.ws-edit {
  flex: 1;
}
.ws-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
}
.ws-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.ws-btn.danger:hover { color: var(--text-danger); }
</style>
