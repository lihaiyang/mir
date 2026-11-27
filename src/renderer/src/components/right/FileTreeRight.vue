<template>
  <div class="file-tree-right">
    <div v-if="!activeProject" class="no-project">{{ $t('fileTree.noProject') }}</div>
    <template v-else>
      <div class="tree-header">
        <span class="tree-root-name" :title="activeProject.path">{{ rootName }}</span>
        <label class="show-hidden-toggle" :title="$t('fileTree.showHidden')">
          <input
            type="checkbox"
            v-model="showHidden"
            :aria-label="$t('fileTree.showHidden')"
            @change="loadTree"
          />
          <span class="toggle-label">.</span>
        </label>
        <button
          v-if="hasModifiedFiles"
          class="icon-btn"
          :title="$t('acp.clearModified', 'Clear agent modified markers')"
          :aria-label="$t('acp.clearModified', 'Clear agent modified markers')"
          @click="acpStore.clearModifiedFiles()"
        ><Icon name="check-circle" :size="16" /></button>
        <button
          class="icon-btn"
          :title="$t('fileTree.refresh')"
          :aria-label="$t('fileTree.refresh')"
          @click="loadTree"
        ><Icon name="refresh" :size="16" /></button>
      </div>
      <div
        class="tree-scroll"
        role="tree"
        :aria-label="rootName"
        @contextmenu.prevent="showRootMenu"
      >
        <RightTreeNode
          v-for="node in nodes"
          :key="node.path"
          :node="node"
          :project-id="activeProject.id"
          :depth="0"
          :show-hidden="showHidden"
          :refresh-nonce="refreshNonce"
          @open-in-editor="openInEditor"
          @refresh="loadTree"
        />
      </div>
    </template>

    <!-- New item dialog (shared implementation) -->
    <PromptDialog
      :open="newItemDialog !== null"
      :title="newItemDialog?.isDir ? $t('fileTree.newFolder') : $t('fileTree.newFile')"
      :placeholder="newItemDialog?.isDir ? 'folder-name' : 'filename.ts'"
      :confirm-text="$t('fileTree.create')"
      @confirm="confirmNewItem"
      @cancel="newItemDialog = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProjectStore } from '../../stores/projects'
import { useTabStore } from '../../stores/tabs'
import { useAcpStore } from '../../stores/acp'
import { useFileTree, type FileNode } from '../../composables/useFileTree'
import { useContextMenu } from '../../composables/useContextMenu'
import RightTreeNode from './RightTreeNode.vue'
import Icon from '../ui/Icon.vue'
import PromptDialog from '../ui/PromptDialog.vue'

const { t } = useI18n()
const projectStore = useProjectStore()
const tabStore = useTabStore()
const acpStore = useAcpStore()
const hasModifiedFiles = computed(() => Object.keys(acpStore.agentModifiedFiles).length > 0)
const { readDir, joinPath } = useFileTree()
const { show: showMenu } = useContextMenu()

const activeProject = computed(() => projectStore.activeProject)
const rootName = computed(() => activeProject.value?.path.split('/').pop() || '')

const nodes = ref<FileNode[]>([])
const showHidden = ref(false)
const refreshNonce = ref(0)

// Roving tabindex for the tree: one tab stop, arrow keys move within.
const focusedPath = ref('')
provide('fileTreeFocus', {
  focusedPath,
  setFocus: (p: string) => {
    focusedPath.value = p
  }
})

async function loadTree() {
  if (!activeProject.value) return
  nodes.value = await readDir(activeProject.value.path, showHidden.value)
  refreshNonce.value++
}

watch(() => activeProject.value?.id, () => loadTree(), { immediate: true })

let pollTimer: ReturnType<typeof setInterval> | null = null
function onExternalFileWritten() {
  void loadTree()
}
onMounted(() => {
  pollTimer = setInterval(() => {
    if (!document.hidden) void loadTree()
  }, 3000)
  window.addEventListener('mir-file-written', onExternalFileWritten)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  window.removeEventListener('mir-file-written', onExternalFileWritten)
})

function showRootMenu(e: MouseEvent) {
  showMenu(e, [
    { label: t('fileTree.newFile'), icon: 'file-plus', action: () => createItem(false) },
    { label: t('fileTree.newFolder'), icon: 'folder-plus', action: () => createItem(true) }
  ])
}

const newItemDialog = ref<{ isDir: boolean } | null>(null)

function createItem(isDir: boolean) {
  newItemDialog.value = { isDir }
}

async function confirmNewItem(name: string) {
  if (!activeProject.value || !newItemDialog.value || !name.trim()) return
  const p = joinPath(activeProject.value.path, name.trim())
  if (newItemDialog.value.isDir) await window.electronAPI.mkdir(p)
  else await window.electronAPI.writeFile(p, '')
  newItemDialog.value = null
  await loadTree()
}

async function openInEditor(fp: string) {
  if (!activeProject.value) return
  const pid = activeProject.value.id
  const fileName = fp.split('/').pop() || fp
  // Reuse existing file tab for same path, or create new one
  const existing = tabStore.getProjectTabs(pid).find(t => t.type === 'file' && t.filePath === fp)
  if (existing) {
    tabStore.setActiveTab(pid, existing.id)
  } else {
    await tabStore.addTab(pid, 'file', { title: fileName, filePath: fp })
  }
}
</script>

<style scoped>
.file-tree-right {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.no-project {
  padding: 16px;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  text-align: center;
}
.tree-header {
  display: flex;
  align-items: center;
  min-height: var(--pane-header-height);
  padding: 8px 8px 4px 14px;
  gap: 4px;
  flex-shrink: 0;
}
.tree-root-name {
  flex: 1;
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.show-hidden-toggle {
  display: flex;
  align-items: center;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: var(--radius-xs);
  flex-shrink: 0;
}
.show-hidden-toggle:hover { background: var(--bg-hover); }
.show-hidden-toggle input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.show-hidden-toggle input:focus-visible + .toggle-label {
  box-shadow: var(--focus-ring);
  border-radius: 3px;
}
.toggle-label {
  font-size: var(--text-xs);
  font-weight: 700;
  color: var(--text-secondary);
  width: 16px;
  text-align: center;
  line-height: 1;
}
.show-hidden-toggle:has(input:checked) .toggle-label {
  color: var(--text-accent);
}
.tree-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
</style>
