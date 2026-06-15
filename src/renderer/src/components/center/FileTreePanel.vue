<template>
  <div class="file-tree-panel">
    <div class="file-tree-header">
      <span class="file-tree-title" :title="rootPath">{{ rootName }}</span>
      <button class="icon-btn" title="New file" @click="createFileAt(rootPath, false)">+F</button>
      <button class="icon-btn" title="New folder" @click="createFileAt(rootPath, true)">+D</button>
    </div>
    <div class="file-tree-scroll">
      <FileTreeNode
        v-for="node in rootNodes"
        :key="node.path"
        :node="node"
        :project-id="projectId"
        :depth="0"
        @open-file="$emit('open-file', $event)"
        @refresh="loadTree"
        @file-ops-change="$emit('file-ops-change')"
      />
    </div>

    <!-- New file/folder dialog -->
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
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import FileTreeNode from './FileTreeNode.vue'
import { useFileTree, type FileNode } from '../../composables/useFileTree'

const { t } = useI18n()

const props = defineProps<{
  rootPath: string
  projectId: string
}>()
const emit = defineEmits<{
  (e: 'open-file', path: string): void
  (e: 'file-ops-change'): void
}>()

export type TreeNode = FileNode

const { readDir, joinPath } = useFileTree()
const rootNodes = ref<FileNode[]>([])

const rootName = computed(() => props.rootPath.split('/').pop() || props.rootPath)

async function loadTree() {
  if (!props.rootPath) return
  rootNodes.value = await readDir(props.rootPath)
}

onMounted(loadTree)

let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  pollTimer = setInterval(loadTree, 3000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

// New item dialog
const newItemDialog = ref<{ parent: string; isDir: boolean } | null>(null)
const newItemName = ref('')
const newItemInput = ref<HTMLInputElement | null>(null)

function createFileAt(parent: string, isDir: boolean) {
  newItemDialog.value = { parent, isDir }
  newItemName.value = ''
  nextTick(() => newItemInput.value?.focus())
}

async function confirmNewItem() {
  if (!newItemDialog.value || !newItemName.value.trim()) return
  const fullPath = joinPath(newItemDialog.value.parent, newItemName.value.trim())
  if (newItemDialog.value.isDir) {
    await window.electronAPI.mkdir(fullPath)
  } else {
    await window.electronAPI.writeFile(fullPath, '')
    emit('open-file', fullPath)
  }
  newItemDialog.value = null
  await loadTree()
  emit('file-ops-change')
}

// Provide loadTree so child nodes can trigger refresh
defineExpose({ loadTree, readDir, createFileAt })
</script>

<style scoped>
.file-tree-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-secondary);
}
.file-tree-header {
  display: flex;
  align-items: center;
  padding: 4px 6px;
  border-bottom: 1px solid var(--border-color);
  gap: 2px;
  flex-shrink: 0;
}
.file-tree-title {
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
.file-tree-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
</style>
