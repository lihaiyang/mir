<template>
  <div>
    <div
      class="tree-node"
      :style="{ paddingLeft: (depth * 12 + 6) + 'px' }"
      :class="{ selected: node.path === selectedPath }"
      @click="handleClick"
      @dblclick="handleDblClick"
      @contextmenu.prevent="showNodeMenu"
    >
      <span class="node-arrow" v-if="node.isDirectory">{{ expanded ? '▾' : '▸' }}</span>
      <span v-else class="node-no-arrow" />
      <span class="node-icon">{{ node.isDirectory ? (expanded ? '📂' : '📁') : fileIcon(node.name) }}</span>
      <span
        v-if="!renaming"
        class="node-name"
      >{{ node.name }}</span>
      <input
        v-else
        ref="renameInput"
        v-model="renameValue"
        class="node-rename-input"
        @blur="commitRename"
        @keydown.enter="commitRename"
        @keydown.esc="cancelRename"
        @click.stop
      />
    </div>

    <template v-if="expanded && node.isDirectory">
      <FileTreeNode
        v-for="child in children"
        :key="child.path"
        :node="child"
        :project-id="projectId"
        :depth="depth + 1"
        @open-file="$emit('open-file', $event)"
        @refresh="$emit('refresh')"
        @file-ops-change="$emit('file-ops-change')"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLayoutStore } from '../../stores/layout'
import { useContextMenu } from '../../composables/useContextMenu'
import { EXCLUDE_DIRS, fileIcon } from '../../constants'
import { useFileTree, type FileNode } from '../../composables/useFileTree'

const { t } = useI18n()

const props = defineProps<{
  node: FileNode
  projectId: string
  depth: number
}>()
const emit = defineEmits<{
  (e: 'open-file', path: string): void
  (e: 'refresh'): void
  (e: 'file-ops-change'): void
}>()

const layoutStore = useLayoutStore()
const { show: showMenu } = useContextMenu()

const { readDir, joinPath } = useFileTree()
const expanded = ref(false)
const children = ref<FileNode[]>([])
const selectedPath = ref<string | null>(null)

onMounted(() => {
  if (props.node.isDirectory) {
    expanded.value = layoutStore.getExpandedState(props.projectId, props.node.path)
    if (expanded.value) loadChildren()
  }
})

async function loadChildren() {
  children.value = await readDir(props.node.path)
}

function handleClick() {
  selectedPath.value = props.node.path
  if (props.node.isDirectory) {
    expanded.value = !expanded.value
    layoutStore.setExpandedState(props.projectId, props.node.path, expanded.value)
    if (expanded.value) loadChildren()
  }
}

function handleDblClick() {
  if (!props.node.isDirectory) {
    emit('open-file', props.node.path)
  }
}

// Rename inline
const renaming = ref(false)
const renameValue = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

function startRename() {
  renaming.value = true
  renameValue.value = props.node.name
  nextTick(() => renameInput.value?.select())
}

async function commitRename() {
  const newName = renameValue.value.trim()
  if (newName && newName !== props.node.name) {
    const parent = props.node.path.split('/').slice(0, -1).join('/')
    const newPath = joinPath(parent, newName)
    await window.electronAPI.rename(props.node.path, newPath)
    emit('refresh')
    emit('file-ops-change')
  }
  renaming.value = false
}

function cancelRename() { renaming.value = false }

function showNodeMenu(e: MouseEvent) {
  showMenu(e, [
    { label: t('fileTree.open'), action: () => !props.node.isDirectory && emit('open-file', props.node.path), disabled: props.node.isDirectory },
    { label: t('fileTree.rename'), action: startRename },
    { label: t('fileTree.copyPath'), action: () => navigator.clipboard.writeText(props.node.path) },
    { label: t('fileTree.revealInFinder'), action: () => window.electronAPI.showItemInFolder(props.node.path) },
    { separator: true },
    { label: t('fileTree.newFileHere'), action: () => createHere(false) },
    { label: t('fileTree.newFolderHere'), action: () => createHere(true) },
    { separator: true },
    { label: t('fileTree.delete'), danger: true, action: deleteNode }
  ])
}

async function deleteNode() {
  const name = props.node.name
  if (!confirm(t('fileTree.deleteConfirmDetail', { name }))) return
  await window.electronAPI.deleteFile(props.node.path)
  emit('refresh')
  emit('file-ops-change')
}

async function createHere(isDir: boolean) {
  const parent = props.node.isDirectory ? props.node.path : props.node.path.split('/').slice(0, -1).join('/')
  const name = prompt(isDir ? t('fileTree.folderName') : t('fileTree.fileName'))
  if (!name) return
  const newPath = joinPath(parent, name)
  if (isDir) {
    await window.electronAPI.mkdir(newPath)
  } else {
    await window.electronAPI.writeFile(newPath, '')
    emit('open-file', newPath)
  }
  emit('refresh')
}

</script>

<style scoped>
.tree-node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  cursor: pointer;
  font-size: 12px;
  user-select: none;
  white-space: nowrap;
}
.tree-node:hover { background: var(--bg-hover); }
.tree-node.selected { background: var(--bg-active); }
.node-arrow { width: 12px; font-size: 10px; flex-shrink: 0; }
.node-no-arrow { width: 12px; flex-shrink: 0; }
.node-icon { font-size: 11px; flex-shrink: 0; }
.node-name { overflow: hidden; text-overflow: ellipsis; }
.node-rename-input {
  font-size: 12px;
  padding: 1px 4px;
  background: var(--bg-tertiary);
  border: 1px solid var(--text-accent);
  color: var(--text-primary);
  border-radius: 2px;
  flex: 1;
}
</style>
