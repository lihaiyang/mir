<template>
  <div class="right-pane-inner">
    <!-- Content: only when expanded -->
    <div v-if="!layout.rightCollapsed" class="right-content">
      <component :is="activePanel?.component" v-if="activePanel" />
    </div>

    <!-- Icon bar: always on the far right -->
    <div v-if="showIcons" class="icon-bar">
      <div
        class="icon-bar-btn"
        :title="layout.rightCollapsed ? t('common.expand') : t('common.collapse')"
        @click="toggleCollapse"
      ><Icon :name="layout.rightCollapsed ? 'chevrons-left' : 'chevrons-right'" :size="14" /></div>
      <div
        v-for="panel in panels"
        :key="panel.id"
        class="icon-bar-btn"
        :class="{ active: !layout.rightCollapsed && layout.rightActivePanel === panel.id }"
        :title="panel.label"
        @click="onPanelClick(panel.id)"
      ><Icon :name="panel.icon" :size="16" /></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { getAllRightPanels, getRightPanel } from '../../plugins/registries'
import Icon from '../ui/Icon.vue'

const { t } = useI18n()
const layout = useLayoutStore()
const settingsStore = useSettingsStore()

const showIcons = computed(() =>
  layout.rightCollapsed || settingsStore.settings.showPanelIcons
)

const panels = computed(() => getAllRightPanels().map(p => ({
  id: p.id,
  label: typeof p.label === 'function' ? p.label() : p.label,
  icon: p.icon
})))

const activePanel = computed(() => getRightPanel(layout.rightActivePanel))

function onPanelClick(id: string) {
  if (layout.rightCollapsed) {
    layout.rightActivePanel = id
    layout.rightCollapsed = false
    layout.persist()
  } else if (layout.rightActivePanel === id) {
    layout.rightCollapsed = true
    layout.persist()
  } else {
    layout.rightActivePanel = id
    layout.persist()
  }
}

function toggleCollapse() {
  layout.rightCollapsed = !layout.rightCollapsed
  layout.persist()
}
</script>

<style scoped>
.right-pane-inner {
  display: flex;
  flex-direction: row;
  height: 100%;
  background: var(--bg-secondary);
}
.right-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.icon-bar {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 0;
  gap: 2px;
  flex-shrink: 0;
  width: 32px;
  border-left: 1px solid var(--border-color);
}
.icon-bar-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 4px;
  font-size: 14px;
  color: var(--text-secondary);
  position: relative;
}
.icon-bar-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.icon-bar-btn.active {
  color: var(--text-accent);
}
.icon-bar-btn.active::before {
  content: '';
  position: absolute;
  right: -4px;
  top: 4px;
  bottom: 4px;
  width: 3px;
  background: var(--text-accent);
  border-radius: 2px 0 0 2px;
}
</style>
