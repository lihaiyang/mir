<template>
  <div class="settings-overlay" @click.self="close">
    <div class="settings-overlay-panel" role="dialog" aria-modal="true">
      <div class="settings-overlay-header">
        <span class="settings-overlay-title">
          {{ mode === 'settings' ? t('common.settings') : t('plugins.title') }}
        </span>
        <button class="settings-overlay-close" :title="t('common.close')" @click="close">
          <Icon name="x" :size="14" />
        </button>
      </div>
      <div class="settings-overlay-body">
        <SettingsTab v-if="mode === 'settings'" />
        <PluginManager v-else />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import type { OverlayMode } from '../stores/ui'
import SettingsTab from './SettingsTab.vue'
import PluginManager from './PluginManager.vue'
import Icon from './ui/Icon.vue'

const props = defineProps<{ mode: OverlayMode }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()

function close() {
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}
.settings-overlay-panel {
  display: flex;
  flex-direction: column;
  width: min(860px, 92vw);
  height: min(640px, 86vh);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}
.settings-overlay-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  padding: 0 8px 0 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}
.settings-overlay-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.settings-overlay-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
}
.settings-overlay-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.settings-overlay-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.settings-overlay-body :deep(.settings-tab) {
  height: 100%;
}
.settings-overlay-body :deep(.plugin-manager) {
  height: 100%;
}
</style>
