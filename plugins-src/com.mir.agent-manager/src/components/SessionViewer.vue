<template>
  <div class="session-viewer">
    <div v-if="sessions.length === 0" class="sv-empty">No sessions found.</div>
    <div v-for="s in sessions" :key="s.id" class="sv-session-card" @click="openSession(s)">
      <div class="sv-session-name">{{ s.name }}</div>
      <div class="sv-session-meta">
        <span v-if="s.modified">Modified: {{ s.modified.slice(0, 19).replace('T', ' ') }}</span>
        <span class="sv-session-dir">{{ s.dir }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { getApi } from '../api-store'
import type { AgentType } from '../types'

const props = defineProps<{ agent: AgentType }>()
const api = getApi()
const sessions = ref<Array<{ id: string; dir: string; name: string; modified?: string }>>([])

async function load() {
  try {
    sessions.value = await api.ipc.invoke('list-sessions', props.agent) as any[]
  } catch { sessions.value = [] }
}

function openSession(s: { dir: string; name: string }) {
  const pid = api.app.stores.projects.activeProjectId
  if (pid) {
    // Try to open the session directory in a terminal
    api.tabs.add(pid, 'terminal', { title: s.name, terminalCwd: s.dir })
  }
}

watch(() => props.agent, () => load())
onMounted(() => load())
</script>

<style scoped>
.session-viewer { display: flex; flex-direction: column; gap: 8px; }
.sv-empty { color: var(--text-secondary); padding: 24px; text-align: center; }
.sv-session-card {
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
}
.sv-session-card:hover { background: var(--bg-hover); }
.sv-session-name { font-weight: 500; font-size: 13px; margin-bottom: 4px; }
.sv-session-meta { font-size: 11px; color: var(--text-secondary); display: flex; gap: 12px; }
.sv-session-dir { word-break: break-all; }
</style>
