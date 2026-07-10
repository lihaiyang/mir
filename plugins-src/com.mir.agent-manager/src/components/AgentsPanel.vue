<template>
  <div class="agents-panel">
    <div class="ap-header">Agents</div>
    <div class="ap-list">
      <button class="ap-btn" @click="openConfig('opencode')">
        <span class="ap-icon">📋</span>
        <span class="ap-text">
          <span class="ap-name">opencode</span>
          <span class="ap-desc">Providers, Models, Skills</span>
        </span>
      </button>
      <button class="ap-btn" @click="openConfig('pi')">
        <span class="ap-icon">🥧</span>
        <span class="ap-text">
          <span class="ap-name">pi</span>
          <span class="ap-desc">Providers, Models, Skills</span>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getApi } from '../api-store'

const api = getApi()

function openConfig(agent: string) {
  const pid = api.app.stores.projects.activeProjectId
  if (pid) {
    api.tabs.add(pid, 'agent-config', { title: 'Agent Manager' })
  }
}
</script>

<style scoped>
.agents-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-secondary);
  color: var(--text-primary);
}
.ap-header {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}
.ap-list {
  display: flex;
  flex-direction: column;
  padding: 8px;
  gap: 6px;
}
.ap-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  color: var(--text-primary);
  font-size: 13px;
}
.ap-btn:hover {
  background: var(--bg-hover);
  border-color: var(--text-accent);
}
.ap-icon { font-size: 18px; }
.ap-text { display: flex; flex-direction: column; gap: 2px; }
.ap-name { font-weight: 500; }
.ap-desc { font-size: 11px; color: var(--text-secondary); }
</style>
