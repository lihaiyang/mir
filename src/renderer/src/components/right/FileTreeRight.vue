<template>
  <div class="file-tree-right">
    <div v-if="!activeProject" class="no-project">{{ $t('fileTree.noProject') }}</div>
    <template v-else>
      <div class="tree-header">
        <span class="tree-root-name" :title="activeProject.path">{{ rootName }}</span>
        <label class="show-hidden-toggle" title="Show hidden files">
          <input type="checkbox" v-model="showHidden" @change="loadTree" />
          <span class="toggle-label">.</span>
        </label>
        <button class="icon-btn" :title="$t('fileTree.refresh')" @click="loadTree">↺</button>
      </div>
      <div class="tree-scroll" @contextmenu.prevent="showRootMenu">
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

    <!-- New item dialog -->
    <div v-if="newItemDialog" class="modal-overlay" @click.self="newItemDialog = null">
      <div class="modal">
        <div class="modal-title">{{ newItemDialog.isDir ? $t('fileTree.newFolder') : $t('fileTree.newFile') }}</div>
        <input
          ref="newItemInput"
          v-model="newItemName"
          :placeholder="newItemDialog.isDir ? 'folder-name' : 'filename.ts'"
          style="width:100%"
          @keydown.enter="confirmNewItem"
          @keydown.esc="newItemDialog = null"
        />
        <div class="modal-actions">
          <button class="btn-secondary" @click="newItemDialog = null">{{ $t('common.cancel') }}</button>
          <button class="btn-primary" @click="confirmNewItem">{{ $t('fileTree.create') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProjectStore } from '../../stores/projects'
import { useTabStore } from '../../stores/tabs'
import { useFileTree, type FileNode } from '../../composables/useFileTree'
import { useContextMenu } from '../../composables/useContextMenu'
import RightTreeNode from './RightTreeNode.vue'

const { t } = useI18n()
const projectStore = useProjectStore()
const tabStore = useTabStore()
const { readDir, joinPath } = useFileTree()
const { show: showMenu } = useContextMenu()

const activeProject = computed(() => projectStore.activeProject)
const rootName = computed(() => activeProject.value?.path.split('/').pop() || '')

const nodes = ref<FileNode[]>([])
const showHidden = ref(false)
const refreshNonce = ref(0)

async function loadTree() {
  if (!activeProject.value) return
  nodes.value = await readDir(activeProject.value.path, showHidden.value)
  refreshNonce.value++
}

watch(() => activeProject.value?.id, () => loadTree(), { immediate: true })

let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  pollTimer = setInterval(loadTree, 3000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function showRootMenu(e: MouseEvent) {
  showMenu(e, [
    { label: t('fileTree.newFile'), action: () => createItem(false) },
    { label: t('fileTree.newFolder'), action: () => createItem(true) }
  ])
}

const newItemDialog = ref<{ isDir: boolean } | null>(null)
const newItemName = ref('')
const newItemInput = ref<HTMLInputElement | null>(null)

function createItem(isDir: boolean) {
  newItemDialog.value = { isDir }
  newItemName.value = ''
  nextTick(() => newItemInput.value?.focus())
}

async function confirmNewItem() {
  if (!activeProject.value || !newItemDialog.value || !newItemName.value.trim()) return
  const p = joinPath(activeProject.value.path, newItemName.value.trim())
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
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
}
.tree-header {
  display: flex;
  align-items: center;
  padding: 4px 6px;
  border-bottom: 1px solid var(--border-color);
  gap: 2px;
  flex-shrink: 0;
}
.tree-root-name {
  flex: 1;
  font-size: 11px;
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
  padding: 2px 4px;
  border-radius: 3px;
  flex-shrink: 0;
}
.show-hidden-toggle:hover { background: var(--bg-hover); }
.show-hidden-toggle input { display: none; }
.toggle-label {
  font-size: 12px;
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
