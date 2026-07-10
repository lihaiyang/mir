<template>
  <div class="agent-manager">
    <!-- Agent switcher -->
    <div class="am-header">
      <div class="am-agent-tabs">
        <button
          v-for="a in agents"
          :key="a.id"
          class="am-agent-btn"
          :class="{ active: activeAgent === a.id }"
          @click="activeAgent = a.id; activeView = 'providers'"
        >{{ a.icon }} {{ a.label }}</button>
      </div>
      <button class="am-refresh-btn" title="Reload" @click="loadAll">↻</button>
    </div>

    <div class="am-body">
      <!-- Left nav -->
      <div class="am-nav">
        <div
          v-for="v in views"
          :key="v.id"
          class="am-nav-item"
          :class="{ active: activeView === v.id }"
          @click="activeView = v.id"
        >
          <span class="am-nav-icon">{{ v.icon }}</span>
          <span>{{ v.label }}</span>
          <span v-if="v.count !== undefined" class="am-nav-badge">{{ v.count }}</span>
        </div>
      </div>

      <!-- Content -->
      <div class="am-content">
        <template v-if="activeView === 'providers'">
          <ProviderEditor :agent="activeAgent" :project-path="projectPath" />
        </template>
        <template v-else-if="activeView === 'skills'">
          <SkillManager />
        </template>
        <template v-else-if="activeView === 'sessions'">
          <SessionViewer :agent="activeAgent" />
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { getApi } from '../api-store'
import ProviderEditor from './ProviderEditor.vue'
import SkillManager from './SkillManager.vue'
import SessionViewer from './SessionViewer.vue'
import type { AgentType } from '../types'

const props = defineProps<{ tab: any }>()

const api = getApi()
const activeAgent = ref<AgentType>('opencode')
const activeView = ref('providers')
const skillsCount = ref(0)

const projectPath = computed(() => {
  const pid = props.tab?.projectId
  if (!pid) return undefined
  const project = api.app.stores.projects.activeProject
  return project?.path
})

const agents = [
  { id: 'opencode' as AgentType, label: 'opencode', icon: '📋' },
  { id: 'pi' as AgentType, label: 'pi', icon: '🥧' }
]

const views = computed(() => [
  { id: 'providers', label: 'Providers', icon: '🔌' },
  { id: 'skills', label: 'Skills', icon: '⚡', count: skillsCount.value || undefined },
  { id: 'sessions', label: 'Sessions', icon: '💬' }
])

async function loadAll() {
  try {
    const skills = await api.ipc.invoke('list-skills') as any[]
    skillsCount.value = skills.length
  } catch { /* ignore */ }
}

onMounted(() => {
  loadAll()
})
</script>

<style scoped>
.agent-manager {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
}
.am-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-color);
  height: 38px;
  flex-shrink: 0;
}
.am-agent-tabs { display: flex; gap: 4px; }
.am-agent-btn {
  padding: 4px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  font-size: 13px;
}
.am-agent-btn:hover { background: var(--bg-hover); }
.am-agent-btn.active {
  background: var(--bg-hover);
  color: var(--text-primary);
  font-weight: 500;
}
.am-refresh-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  padding: 4px 8px;
  border-radius: 4px;
}
.am-refresh-btn:hover { background: var(--bg-hover); }
.am-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.am-nav {
  width: 160px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color);
  padding: 8px 0;
  overflow-y: auto;
}
.am-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 16px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 13px;
}
.am-nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.am-nav-item.active { background: var(--bg-hover); color: var(--text-primary); font-weight: 500; }
.am-nav-icon { width: 18px; text-align: center; }
.am-nav-badge {
  margin-left: auto;
  background: var(--bg-tertiary, #333);
  color: var(--text-secondary);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 11px;
  min-width: 18px;
  text-align: center;
}
.am-content {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 16px;
}
</style>
