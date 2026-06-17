<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal settings-modal">
      <div class="modal-title">{{ $t('settings.title') }}</div>

      <div class="settings-layout">
        <!-- Sections nav -->
        <div class="settings-nav">
          <div
            v-for="sec in sections"
            :key="sec.id"
            class="settings-nav-item"
            :class="{ active: activeSection === sec.id }"
            @click="activeSection = sec.id"
          >{{ sec.label }}</div>
        </div>

        <!-- Content -->
        <div class="settings-content">
          <!-- Appearance -->
          <template v-if="activeSection === 'appearance'">
            <div class="settings-group">
              <label class="settings-label">{{ $t('settings.language') }}</label>
              <select v-model="draft.language" class="settings-select">
                <option value="en">English</option>
                <option value="zh-CN">中文（简体）</option>
              </select>
            </div>
            <div class="settings-group">
              <label class="settings-label">{{ $t('settings.theme') }}</label>
              <select v-model="draft.theme" class="settings-select">
                <option value="dark">{{ $t('settings.dark') }}</option>
                <option value="light">{{ $t('settings.light') }}</option>
              </select>
            </div>
            <div class="settings-group">
              <label class="settings-label">{{ $t('settings.uiFontSize') }}</label>
              <input type="number" v-model.number="draft.fontSize" min="10" max="24" class="settings-input" />
            </div>
          </template>

          <!-- Terminal -->
          <template v-if="activeSection === 'terminal'">
            <div class="settings-group">
              <label class="settings-label">{{ $t('settings.shellPath') }}</label>
              <input v-model="draft.terminalShell" placeholder="/bin/zsh" class="settings-input" />
            </div>
            <div class="settings-group">
              <label class="settings-label">{{ $t('settings.terminalFontSize') }}</label>
              <input type="number" v-model.number="draft.terminalFontSize" min="8" max="24" class="settings-input" />
            </div>
          </template>

          <!-- Editor -->
          <template v-if="activeSection === 'editor'">
            <div class="settings-group">
              <label class="settings-label">{{ $t('settings.autoSave') }}</label>
              <input type="number" v-model.number="draft.autoSaveInterval" min="0" max="60" class="settings-input" />
            </div>
            <div class="settings-group">
              <label class="settings-label">{{ $t('settings.wordWrap') }}</label>
              <select v-model="draft.editorWordWrap" class="settings-select">
                <option value="off">{{ $t('settings.wordWrapOff') }}</option>
                <option value="on">{{ $t('settings.wordWrapOn') }}</option>
                <option value="wordWrapColumn">{{ $t('settings.wordWrapColumn') }}</option>
                <option value="bounded">{{ $t('settings.wordWrapBounded') }}</option>
              </select>
            </div>
            <div v-if="draft.editorWordWrap === 'wordWrapColumn' || draft.editorWordWrap === 'bounded'" class="settings-group">
              <label class="settings-label">{{ $t('settings.wordWrapColumn') }}</label>
              <input type="number" v-model.number="draft.editorWordWrapColumn" min="20" max="500" class="settings-input" />
            </div>
          </template>

          <!-- Git -->
          <template v-if="activeSection === 'git'">
            <div class="settings-group">
              <label class="settings-label">{{ $t('settings.gitExecutablePath') }}</label>
              <input v-model="draft.gitExecutable" placeholder="git" class="settings-input" />
            </div>
          </template>

          <!-- Browser -->
          <template v-if="activeSection === 'browser'">
            <div class="settings-group">
              <label class="settings-label">{{ $t('settings.searchEngine') }}</label>
              <input v-model="draft.defaultSearchEngine" class="settings-input" />
            </div>
          </template>

          <!-- Shortcuts -->
          <template v-if="activeSection === 'shortcuts'">
            <div
              v-for="(value, key) in draft.shortcuts"
              :key="key"
              class="settings-group settings-group-row"
            >
              <label class="settings-label" style="width:160px">{{ shortcutLabel(key) }}</label>
              <input
                v-model="draft.shortcuts[key]"
                class="settings-input"
                style="flex:1"
              />
            </div>
          </template>
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn-secondary" @click="$emit('close')">{{ $t('common.cancel') }}</button>
        <button class="btn-primary" @click="save">{{ $t('common.save') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore, type Settings } from '../stores/settings'

const emit = defineEmits<{ (e: 'close'): void }>()
const settingsStore = useSettingsStore()
const { t } = useI18n()

const draft = reactive<Settings>(JSON.parse(JSON.stringify(settingsStore.settings)))

const sections = computed(() => [
  { id: 'appearance', label: t('settings.appearance') },
  { id: 'terminal', label: t('settings.terminal') },
  { id: 'editor', label: t('settings.editor') },
  { id: 'git', label: t('settings.git') },
  { id: 'browser', label: t('settings.browser') },
  { id: 'shortcuts', label: t('settings.shortcuts') }
])
const activeSection = ref('appearance')

async function save() {
  await settingsStore.update({ ...draft })
  emit('close')
}

function shortcutLabel(key: string): string {
  const labels: Record<string, string> = {
    newTab: t('settings.newTab'),
    closeTab: t('settings.closeTab'),
    nextTab: t('settings.nextTab'),
    prevTab: t('settings.prevTab'),
    commandPalette: t('settings.commandPalette'),
    settings: t('settings.title'),
    find: t('settings.find'),
    save: t('settings.save_')
  }
  return labels[key] || key
}
</script>

<style scoped>
.settings-modal {
  width: 640px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}
.settings-layout {
  display: flex;
  gap: 0;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  overflow: hidden;
  margin: 4px 0;
}
.settings-nav {
  width: 140px;
  background: var(--bg-tertiary);
  flex-shrink: 0;
  padding: 8px 0;
  border-right: 1px solid var(--border-color);
}
.settings-nav-item {
  padding: 7px 14px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
}
.settings-nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.settings-nav-item.active { background: var(--bg-active); color: #fff; }
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.settings-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.settings-group-row {
  flex-direction: row;
  align-items: center;
}
.settings-label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 600;
}
.settings-input {
  font-size: 13px;
  padding: 5px 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: 3px;
  width: 100%;
}
.settings-select {
  font-size: 13px;
  padding: 5px 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: 3px;
}
</style>
