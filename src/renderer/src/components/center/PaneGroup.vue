<template>
  <div
    class="pane-group"
    :class="{ focused }"
    @mousedown.capture="onPaneFocus"
  >
    <!-- TabBar: shown for panes NOT in the first row (first row TabBars are in titlebar) -->
    <TabBar v-if="!isFirstRow" :project-id="projectId" :group-id="groupId" />

    <!-- Content: browser tabs stay local, others rendered via Teleport from CenterPane -->
    <div class="tab-content">
      <div :id="`pane-content-${groupId}`" class="pane-teleport-target" />
      <div
        v-for="tab in browserTabs"
        :key="tab.id"
        class="browser-pane-wrapper"
        :class="{ 'browser-pane-hidden': tab.id !== activeTabId }"
      >
        <BrowserTab :tab="tab" />
      </div>
      <div v-if="tabs.length === 0" class="no-tabs-hint">
        <p>{{ $t('tab.noTabs') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTabStore, type TabType } from '../../stores/tabs'
import { useProjectStore } from '../../stores/projects'
import TabBar from './TabBar.vue'
import BrowserTab from './BrowserTab.vue'

const props = defineProps<{
  projectId: string
  groupId: string
  focused: boolean
}>()

const { t } = useI18n()
const tabStore = useTabStore()
const projectStore = useProjectStore()

const tabs = computed(() => tabStore.getGroupTabs(props.projectId, props.groupId))
const activeTabId = computed(() => tabStore.getGroupActiveTabId(props.projectId, props.groupId))
const browserTabs = computed(() => tabs.value.filter(t => t.type === 'browser'))
const isFirstRow = computed(() => tabStore.getFirstRowPaneIds(props.projectId).includes(props.groupId))

function onPaneFocus() {
  if (!props.focused) {
    tabStore.focusPane(props.projectId, props.groupId)
  }
}

async function createTab(type: TabType) {
  const extra: Record<string, unknown> = {}
  if (type === 'terminal') extra.terminalCwd = projectStore.activeProject?.path
  if (type === 'browser') extra.browserUrl = 'https://www.google.com'
  const labelMap: Record<TabType, string> = {
    terminal: t('tab.terminal'),
    editor: t('tab.fileEditor'),
    browser: t('tab.browser'),
    file: t('tab.file')
  }
  extra.title = labelMap[type]
  await tabStore.addTab(props.projectId, type, extra as any)
}
</script>

<style scoped>
.pane-group {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
  position: relative;
}

.tab-content {
  flex: 1;
  min-height: 0;
  position: relative;
}

/* Active browser tab wrapper: fill the tab-content container */
.browser-pane-wrapper {
  height: 100%;
}

/* Move hidden browser tabs off-screen so webview keeps its compositor state,
   while the active tab fills the container normally without blocking anything */
.browser-pane-hidden {
  position: fixed;
  top: -9999px;
  left: -9999px;
  width: 100vw;
  height: 100vh;
  visibility: hidden;
  pointer-events: none;
}

.pane-teleport-target {
  position: absolute;
  inset: 0;
}

.no-tabs-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  gap: 12px;
}
</style>