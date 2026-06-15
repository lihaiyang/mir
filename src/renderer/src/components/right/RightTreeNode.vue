<template>
  <div>
    <div
      class="tree-node"
      :style="{ paddingLeft: (depth * 12 + 6) + 'px' }"
      @click="handleClick"
      @dblclick="handleDblClick"
      @contextmenu.prevent="showNodeMenu"
    >
      <span v-if="node.isDirectory" class="node-arrow">{{ expanded ? '▾' : '▸' }}</span>
      <span v-else class="node-no-arrow" />
      <span class="node-icon">{{ node.isDirectory ? (expanded ? '📂' : '📁') : fileIcon(node.name) }}</span>
      <span class="node-name">{{ node.name }}</span>
    </div>

    <template v-if="expanded && node.isDirectory">
      <RightTreeNode
        v-for="child in children"
        :key="child.path"
        :node="child"
        :project-id="projectId"
        :depth="depth + 1"
        :show-hidden="showHidden"
        @open-in-editor="$emit('open-in-editor', $event)"
        @refresh="$emit('refresh')"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLayoutStore } from '../../stores/layout'
import { useContextMenu } from '../../composables/useContextMenu'
import { useTabStore } from '../../stores/tabs'
import { useProjectStore } from '../../stores/projects'
import { fileIcon } from '../../constants'
import { useFileTree, type FileNode } from '../../composables/useFileTree'

const { t } = useI18n()

const props = defineProps<{ node: FileNode; projectId: string; depth: number; showHidden: boolean }>()
const emit = defineEmits<{
  (e: 'open-in-editor', path: string): void
  (e: 'refresh'): void
}>()

const layoutStore = useLayoutStore()
const { show: showMenu } = useContextMenu()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const { readDir, joinPath } = useFileTree()

const expanded = ref(false)
const children = ref<FileNode[]>([])

onMounted(() => {
  if (props.node.isDirectory) {
    expanded.value = layoutStore.getExpandedState(props.projectId, props.node.path)
    if (expanded.value) loadChildren()
  }
})

async function loadChildren() {
  children.value = await readDir(props.node.path, props.showHidden)
}

function handleClick() {
  if (props.node.isDirectory) {
    expanded.value = !expanded.value
    layoutStore.setExpandedState(props.projectId, props.node.path, expanded.value)
    if (expanded.value) loadChildren()
  }
}

function handleDblClick() {
  if (!props.node.isDirectory) {
    emit('open-in-editor', props.node.path)
  }
}

function showNodeMenu(e: MouseEvent) {
  showMenu(e, [
    { label: t('fileTree.openInEditor'), disabled: props.node.isDirectory, action: () => emit('open-in-editor', props.node.path) },
    { label: t('fileTree.openInTerminal'), action: openInTerminal },
    { label: t('fileTree.revealInFinder'), action: () => window.electronAPI.showItemInFolder(props.node.path) },
    { label: t('fileTree.copyPath'), action: () => navigator.clipboard.writeText(props.node.path) },
    { separator: true },
    { label: t('fileTree.newFile'), action: () => createHere(false) },
    { label: t('fileTree.newFolder'), action: () => createHere(true) },
    { label: t('fileTree.rename'), action: renameNode },
    { separator: true },
    { label: t('fileTree.delete'), danger: true, action: deleteNode }
  ])
}

async function openInTerminal() {
  const p = projectStore.activeProject
  if (!p) return
  const dir = props.node.isDirectory ? props.node.path : props.node.path.split('/').slice(0, -1).join('/')
  await tabStore.addTab(p.id, 'terminal', { terminalCwd: dir, title: props.node.name })
}

async function deleteNode() {
  if (!confirm(t('fileTree.deleteConfirm', { name: props.node.name }))) return
  await window.electronAPI.deleteFile(props.node.path)
  emit('refresh')
}

async function createHere(isDir: boolean) {
  const parent = props.node.isDirectory ? props.node.path : props.node.path.split('/').slice(0, -1).join('/')
  const name = prompt(isDir ? t('fileTree.folderName') : t('fileTree.fileName'))
  if (!name) return
  const np = joinPath(parent, name)
  if (isDir) {
    await window.electronAPI.mkdir(np)
  } else {
    await window.electronAPI.writeFile(np, '')
    emit('open-in-editor', np)
  }
  if (props.node.isDirectory) {
    expanded.value = true
    children.value = await readDir(props.node.path, props.showHidden)
  } else {
    emit('refresh')
  }
}

async function renameNode() {
  const newName = prompt(t('fileTree.newName'), props.node.name)
  if (!newName || newName === props.node.name) return
  const parent = props.node.path.split('/').slice(0, -1).join('/')
  await window.electronAPI.rename(props.node.path, joinPath(parent, newName))
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
.node-arrow { width: 12px; font-size: 10px; flex-shrink: 0; }
.node-no-arrow { width: 12px; flex-shrink: 0; }
.node-icon { font-size: 11px; flex-shrink: 0; }
.node-name { overflow: hidden; text-overflow: ellipsis; }
</style>
