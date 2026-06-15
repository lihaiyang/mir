<template>
  <div class="right-pane-inner">
    <!-- Collapsed icon bar: panel icons only, expand/collapse handled by titlebar -->
    <template v-if="layout.rightCollapsed">
      <div class="icon-bar">
        <div
          v-for="panel in panels"
          :key="panel.id"
          class="icon-bar-btn"
          :title="panel.label"
          @click="expandTo(panel.id)"
        >{{ panel.icon }}</div>
      </div>
    </template>

    <!-- Expanded -->
    <template v-else>
      <div class="right-content">
        <FileTreeRight v-if="layout.rightActivePanel === 'files'" />
        <GitPanel v-else-if="layout.rightActivePanel === 'git'" />
        <SearchPanel v-else-if="layout.rightActivePanel === 'search'" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLayoutStore } from '../../stores/layout'
import FileTreeRight from './FileTreeRight.vue'
import GitPanel from './GitPanel.vue'
import SearchPanel from './SearchPanel.vue'

const { t } = useI18n()
const layout = useLayoutStore()

const panels = computed(() => [
  { id: 'files' as const, label: t('rightPane.files'), icon: '📁' },
  { id: 'git' as const, label: t('rightPane.git'), icon: '🔀' },
  { id: 'search' as const, label: t('rightPane.search'), icon: '🔍' }
])

function expandTo(id: 'files' | 'git' | 'search') {
  layout.rightActivePanel = id
  layout.rightCollapsed = false
  layout.persist()
}
</script>

<style scoped>
.right-pane-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-secondary);
}
.icon-bar {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 0;
  gap: 4px;
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
}
.icon-bar-btn:hover { background: var(--bg-hover); }
.right-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
