<template>
  <div class="skill-manager">
    <!-- Header -->
    <div class="sm-header">
      <div class="sm-search">
        <input v-model="searchQuery" class="sm-search-input" placeholder="Search skills..." />
      </div>
      <button class="sm-btn sm-btn-primary" @click="showInstall = !showInstall">+ Install from GitHub</button>
    </div>

    <!-- Install form -->
    <div v-if="showInstall" class="sm-install-form">
      <input v-model="repoUrl" class="sm-input" placeholder="https://github.com/vercel-labs/skills.git" />
      <input v-model="skillPath" class="sm-input sm-input-sm" placeholder="skills/find-skills (optional)" />
      <button class="sm-btn sm-btn-primary" :disabled="installing || !repoUrl" @click="installSkill">
        {{ installing ? '⏳ Installing...' : 'Install' }}
      </button>
      <button class="sm-btn" @click="showInstall = false">Cancel</button>
      <span v-if="installResult" :class="['sm-install-result', installResult.success ? 'ok' : 'fail']">
        {{ installResult.success ? '✓ Installed: ' + installResult.name : '✗ ' + installResult.error }}
      </span>
    </div>

    <!-- Skill list -->
    <div class="sm-list">
      <div v-if="filteredSkills.length === 0" class="sm-empty">
        No skills found. Install one from GitHub to get started.
      </div>
      <div
        v-for="skill in filteredSkills"
        :key="skill.name"
        class="sm-skill-card"
      >
        <div class="sm-skill-info">
          <div class="sm-skill-name">{{ skill.name }}</div>
          <div class="sm-skill-desc">{{ skill.description }}</div>
          <div class="sm-skill-meta">
            <span v-if="skill.source" class="sm-skill-source">📦 {{ skill.source.repo }}</span>
            <span v-if="skill.installedAt" class="sm-skill-date">Installed: {{ skill.installedAt.slice(0, 10) }}</span>
          </div>
        </div>
        <div class="sm-skill-actions">
          <button class="sm-btn sm-btn-sm" title="View SKILL.md" @click="viewSkill(skill)">👁 View</button>
          <button class="sm-btn sm-btn-sm" title="Edit in editor" @click="editSkill(skill)">📝 Edit</button>
          <button class="sm-btn sm-btn-sm sm-btn-danger" title="Uninstall" @click="uninstallSkill(skill)">🗑 Uninstall</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { getApi } from '../api-store'
import type { SkillInfo } from '../types'

const api = getApi()
const skills = ref<SkillInfo[]>([])
const searchQuery = ref('')
const showInstall = ref(false)
const repoUrl = ref('')
const skillPath = ref('')
const installing = ref(false)
const installResult = ref<{ success: boolean; error?: string; name?: string } | null>(null)

const filteredSkills = computed(() => {
  if (!searchQuery.value) return skills.value
  const q = searchQuery.value.toLowerCase()
  return skills.value.filter(s =>
    s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
  )
})

async function loadSkills() {
  try {
    skills.value = await api.ipc.invoke('list-skills') as SkillInfo[]
  } catch (e) {
    api.logger.error('Failed to load skills:', e)
  }
}

function viewSkill(skill: SkillInfo) {
  const pid = api.app.stores.projects.activeProjectId
  if (pid) {
    api.tabs.add(pid, 'file', { title: skill.name, filePath: skill.skillMdPath })
  }
}

function editSkill(skill: SkillInfo) {
  const pid = api.app.stores.projects.activeProjectId
  if (pid) {
    api.tabs.add(pid, 'editor', { title: skill.name + ' (SKILL.md)', filePath: skill.skillMdPath })
  }
}

async function installSkill() {
  installing.value = true
  installResult.value = null
  try {
    installResult.value = await api.ipc.invoke('install-skill', repoUrl.value, skillPath.value || undefined) as any
    if (installResult.value?.success) {
      await loadSkills()
      repoUrl.value = ''
      skillPath.value = ''
      setTimeout(() => { showInstall.value = false; installResult.value = null }, 2000)
    }
  } catch (e) {
    installResult.value = { success: false, error: String(e) }
  }
  installing.value = false
}

async function uninstallSkill(skill: SkillInfo) {
  if (!confirm(`Uninstall skill "${skill.name}"?`)) return
  await api.ipc.invoke('uninstall-skill', skill.name)
  await loadSkills()
}

onMounted(() => {
  loadSkills()
})
</script>

<style scoped>
.skill-manager { display: flex; flex-direction: column; gap: 12px; }
.sm-header { display: flex; gap: 8px; align-items: center; }
.sm-search { flex: 1; }
.sm-search-input {
  width: 100%;
  padding: 6px 10px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 13px;
}
.sm-search-input:focus { outline: none; border-color: var(--text-accent); }
.sm-install-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.sm-input {
  padding: 6px 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 13px;
}
.sm-input-sm { width: 200px; }
.sm-input:focus { outline: none; border-color: var(--text-accent); }
.sm-list { display: flex; flex-direction: column; gap: 8px; }
.sm-empty { color: var(--text-secondary); padding: 24px; text-align: center; }
.sm-skill-card {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  gap: 12px;
}
.sm-skill-info { flex: 1; min-width: 0; }
.sm-skill-name { font-weight: 500; font-size: 14px; margin-bottom: 4px; }
.sm-skill-desc { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; word-break: break-word; }
.sm-skill-meta { display: flex; gap: 12px; font-size: 11px; color: var(--text-secondary); }
.sm-skill-actions { display: flex; gap: 4px; flex-shrink: 0; }
.sm-btn {
  padding: 5px 10px;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.sm-btn:hover { background: var(--bg-hover); }
.sm-btn-sm { padding: 3px 8px; font-size: 11px; }
.sm-btn-primary { background: var(--text-accent); color: #fff; border-color: var(--text-accent); }
.sm-btn-primary:hover { opacity: 0.9; }
.sm-btn-danger { color: #e55; }
.sm-btn-danger:hover { background: rgba(238,85,85,0.15); }
.sm-install-result { font-size: 12px; }
.sm-install-result.ok { color: #4a4; }
.sm-install-result.fail { color: #e55; }
</style>
