<template>
  <div class="plugin-manager">
    <!-- Header -->
    <div class="pm-header">
      <span class="pm-title">{{ t('plugins.title') }}</span>
      <div class="pm-header-actions">
        <button class="pm-btn" @click="openFolder" :disabled="!pluginsDir" :title="t('plugins.openFolder')"><Icon name="folder-open" :size="13" /> {{ t('plugins.openFolder') }}</button>
        <button class="pm-btn" @click="showGitModal = true"><Icon name="git-branch" :size="13" /> {{ t('plugins.installFromGit') }}</button>
        <button class="pm-btn pm-btn-primary" @click="installFromDir"><Icon name="folder-plus" :size="13" /> {{ t('plugins.installFromFolder') }}</button>
        <button class="pm-btn" @click="reload" title="Refresh"><Icon name="refresh" :size="13" /></button>
      </div>
    </div>

    <!-- Git install modal -->
    <div v-if="showGitModal" class="pm-modal-overlay" @click.self="showGitModal = false">
      <div class="pm-modal">
        <div class="pm-modal-title"><Icon name="git-branch" :size="15" /> {{ t('plugins.installFromGit') }}</div>
        <div class="pm-modal-field">
          <label>{{ t('plugins.gitUrl') }}</label>
          <input
            v-model="gitUrl"
            class="pm-input"
            :placeholder="t('plugins.gitUrlPlaceholder')"
            @keydown.enter="installFromGit"
          />
        </div>
        <div class="pm-modal-field">
          <label>{{ t('plugins.subPath') }}</label>
          <input
            v-model="gitSubPath"
            class="pm-input"
            :placeholder="t('plugins.subPathPlaceholder')"
            @keydown.enter="installFromGit"
          />
        </div>
        <div v-if="gitInstalling" class="pm-modal-status">{{ t('plugins.scanning') }}</div>
        <div class="pm-modal-actions">
          <button class="pm-btn" @click="showGitModal = false" :disabled="gitInstalling">{{ t('common.cancel') }}</button>
          <button
            class="pm-btn pm-btn-primary"
            :disabled="!gitUrl.trim() || gitInstalling"
            @click="installFromGit"
          >{{ t('plugins.installFromGit') }}</button>
        </div>
      </div>
    </div>

    <!-- Plugins dir hint -->
    <div class="pm-hint">
      {{ t('plugins.dropHint') }} <code>{{ pluginsDir }}</code>
    </div>

    <!-- Install result -->
    <div v-if="installMsg" :class="['pm-msg', installMsg.success ? 'ok' : 'fail']">
      {{ installMsg.success ? '✓ ' : '✗ ' }}{{ installMsg.text }}
    </div>

    <!-- Plugin list -->
    <div v-if="plugins.length === 0" class="pm-empty">
      {{ t('plugins.noPlugins') }}
    </div>
    <div
      v-for="p in plugins"
      :key="p.manifest.id"
      class="pm-card"
      :class="{ disabled: !p.enabled }"
    >
      <div class="pm-card-info">
        <div class="pm-card-name">
          {{ p.manifest.name }}
          <span class="pm-card-version">v{{ p.manifest.version }}</span>
        </div>
        <div class="pm-card-id">{{ p.manifest.id }}</div>
        <div v-if="p.manifest.description" class="pm-card-desc">{{ p.manifest.description }}</div>
        <div v-if="p.manifest.author" class="pm-card-author">by {{ p.manifest.author }}</div>
      </div>
      <div class="pm-card-actions">
        <button
          class="pm-btn pm-btn-sm"
          :class="{ 'pm-btn-primary': !p.enabled }"
          @click="toggleEnabled(p)"
        >{{ p.enabled ? t('plugins.disable') : t('plugins.enable') }}</button>
        <button
          class="pm-btn pm-btn-sm pm-btn-danger"
          @click="uninstall(p)"
        >{{ t('plugins.uninstall') }}</button>
      </div>
    </div>

    <!-- Restart hint -->
    <div v-if="needsRestart" class="pm-restart-hint">
      <Icon name="alert-triangle" :size="14" /> {{ t('plugins.restartHint') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './ui/Icon.vue'

const { t } = useI18n()

interface PluginEntry {
  manifest: {
    id: string
    name: string
    version: string
    description?: string
    author?: string
    main?: string
    mainMain?: string
  }
  enabled: boolean
}

const plugins = ref<PluginEntry[]>([])
const pluginsDir = ref('')
const installMsg = ref<{ success: boolean; text: string } | null>(null)
const needsRestart = ref(false)
const showGitModal = ref(false)
const gitUrl = ref('')
const gitSubPath = ref('')
const gitInstalling = ref(false)

async function load() {
  plugins.value = await window.electronAPI.pluginList() as PluginEntry[]
  pluginsDir.value = await window.electronAPI.pluginPluginsDir() as string
}

async function installFromDir() {
  const dir = await window.electronAPI.openFolder()
  if (!dir) return
  const result = await window.electronAPI.pluginInstall(dir) as { success: boolean; error?: string; pluginId?: string }
  if (result.success) {
    installMsg.value = { success: true, text: t('plugins.installed', { id: result.pluginId }) }
    needsRestart.value = true
  } else {
    installMsg.value = { success: false, text: result.error || 'Installation failed' }
  }
  await load()
  setTimeout(() => { installMsg.value = null }, 5000)
}

async function uninstall(p: PluginEntry) {
  if (!confirm(t('plugins.uninstallConfirm', { name: p.manifest.name }))) return
  const result = await window.electronAPI.pluginUninstall(p.manifest.id) as { success: boolean; error?: string }
  if (result.success) {
    needsRestart.value = true
  } else {
    installMsg.value = { success: false, text: result.error || 'Uninstall failed' }
  }
  await load()
}

async function toggleEnabled(p: PluginEntry) {
  if (p.enabled) {
    await window.electronAPI.pluginDisable(p.manifest.id)
  } else {
    await window.electronAPI.pluginEnable(p.manifest.id)
  }
  needsRestart.value = true
  await load()
}

function openFolder() {
  if (pluginsDir.value) {
    window.electronAPI.openPath(pluginsDir.value)
  }
}

async function installFromGit() {
  if (!gitUrl.value.trim() || gitInstalling.value) return
  gitInstalling.value = true
  const result = await window.electronAPI.pluginInstallGit(gitUrl.value.trim(), gitSubPath.value.trim()) as { success: boolean; error?: string; pluginId?: string }
  gitInstalling.value = false
  if (result.success) {
    installMsg.value = { success: true, text: t('plugins.installed', { id: result.pluginId }) }
    needsRestart.value = true
    showGitModal.value = false
    gitUrl.value = ''
    gitSubPath.value = ''
    await load()
    setTimeout(() => { installMsg.value = null }, 5000)
  } else {
    installMsg.value = { success: false, text: result.error || 'Installation failed' }
  }
}

function reload() {
  load()
}

onMounted(() => {
  load()
})
</script>

<style scoped>
.plugin-manager {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  height: 100%;
  overflow: auto;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
}
.pm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pm-title { font-size: 16px; font-weight: 600; }
.pm-header-actions { display: flex; gap: 8px; }
.pm-hint {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-radius: 4px;
  word-break: break-all;
}
.pm-hint code { color: var(--text-accent); font-family: monospace; }
.pm-msg {
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 12px;
}
.pm-msg.ok { background: rgba(68,170,68,0.15); color: #4a4; }
.pm-msg.fail { background: rgba(238,85,85,0.15); color: #e55; }
.pm-empty {
  color: var(--text-secondary);
  padding: 32px;
  text-align: center;
}
.pm-card {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  gap: 12px;
}
.pm-card.disabled { opacity: 0.5; }
.pm-card-info { flex: 1; min-width: 0; }
.pm-card-name { font-weight: 600; font-size: 14px; }
.pm-card-version { font-weight: 400; font-size: 11px; color: var(--text-secondary); margin-left: 6px; }
.pm-card-id { font-size: 11px; color: var(--text-secondary); font-family: monospace; margin-top: 2px; }
.pm-card-desc { font-size: 12px; color: var(--text-secondary); margin-top: 6px; }
.pm-card-author { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
.pm-card-actions { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
.pm-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.pm-btn:hover { background: var(--bg-hover); }
.pm-btn-sm { padding: 3px 10px; font-size: 11px; }
.pm-btn-primary { background: var(--text-accent); color: #fff; border-color: var(--text-accent); }
.pm-btn-primary:hover { opacity: 0.9; }
.pm-btn-danger { color: #e55; }
.pm-btn-danger:hover { background: rgba(238,85,85,0.15); }
.pm-restart-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: rgba(255,180,0,0.12);
  color: #e90;
  border-radius: 4px;
  font-size: 12px;
}
.pm-modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.pm-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 20px;
  width: 480px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.pm-modal-title { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.pm-modal-field { display: flex; flex-direction: column; gap: 4px; }
.pm-modal-field label { font-size: 12px; color: var(--text-secondary); }
.pm-input {
  padding: 6px 8px;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 13px;
  outline: none;
}
.pm-input:focus { border-color: var(--text-accent); }
.pm-modal-status { font-size: 12px; color: var(--text-secondary); }
.pm-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
