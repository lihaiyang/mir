<template>
  <div>
    <div
      class="tree-node"
      role="treeitem"
      :tabindex="isTabStop ? 0 : -1"
      :aria-expanded="node.isDirectory ? expanded : undefined"
      :aria-level="depth + 1"
      :style="{ paddingLeft: (depth * 12 + 6) + 'px' }"
      @click="handleClick"
      @dblclick="handleDblClick"
      @contextmenu.prevent="showNodeMenu"
      @keydown="onKeydown"
      @focus="onFocus"
    >
      <span v-if="node.isDirectory" class="node-arrow"><Icon :name="expanded ? 'chevron-down' : 'chevron-right'" :size="14" /></span>
      <span v-else class="node-no-arrow" />
      <span class="node-icon">
        <Icon v-if="node.isDirectory" :name="expanded ? 'folder-open' : 'folder'" :size="16" class="folder-icon" />
        <span v-else class="file-emoji">{{ fileIcon(node.name) }}</span>
      </span>
      <span class="node-name" :class="{ 'is-agent-modified': isModified }">{{ node.name }}</span>
      <span v-if="isModified" class="agent-badge" :title="t('acp.fileModified', 'Modified by Agent')">M</span>
      <span v-else-if="hasModifiedChild" class="agent-dot" :title="t('acp.dirHasModified', 'Contains Agent-modified files')" />
    </div>

    <template v-if="expanded && node.isDirectory">
      <RightTreeNode
        v-for="child in children"
        :key="child.path"
        :node="child"
        :project-id="projectId"
        :depth="depth + 1"
        :show-hidden="showHidden"
        :refresh-nonce="refreshNonce"
        @open-in-editor="$emit('open-in-editor', $event)"
        @refresh="$emit('refresh')"
      />
    </template>

    <PromptDialog
      :open="promptMode !== null"
      :title="promptTitle"
      :placeholder="promptPlaceholder"
      :initial-value="promptInitial"
      :confirm-text="promptConfirmText"
      @confirm="onPromptConfirm"
      @cancel="promptMode = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, inject, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLayoutStore } from '../../stores/layout'
import { useContextMenu } from '../../composables/useContextMenu'
import { useTabStore } from '../../stores/tabs'
import { useProjectStore } from '../../stores/projects'
import { useAcpStore } from '../../stores/acp'
import { fileIcon } from '../../constants'
import { useFileTree, type FileNode } from '../../composables/useFileTree'
import Icon from '../ui/Icon.vue'
import PromptDialog from '../ui/PromptDialog.vue'

const { t } = useI18n()

const props = defineProps<{ node: FileNode; projectId: string; depth: number; showHidden: boolean; refreshNonce: number }>()
const emit = defineEmits<{
  (e: 'open-in-editor', path: string): void
  (e: 'refresh'): void
}>()

const layoutStore = useLayoutStore()
const { show: showMenu } = useContextMenu()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const acpStore = useAcpStore()
const { readDir, joinPath } = useFileTree()

const isModified = computed(() => !props.node.isDirectory && acpStore.isFileModified(props.node.path))
const hasModifiedChild = computed(() => props.node.isDirectory && acpStore.hasModifiedDescendant(props.node.path))

const expanded = ref(false)
const children = ref<FileNode[]>([])

onMounted(() => {
  if (props.node.isDirectory) {
    expanded.value = layoutStore.getExpandedState(props.projectId, props.node.path)
    if (expanded.value) loadChildren()
  }
})

// When the parent triggers a refresh (refreshNonce changes), reload children
// of any expanded directory so the whole tree stays in sync, not just the root.
watch(() => props.refreshNonce, () => {
  if (props.node.isDirectory && expanded.value) loadChildren()
})

async function loadChildren() {
  children.value = await readDir(props.node.path, props.showHidden)
}

function toggleDir() {
  if (!props.node.isDirectory) return
  expanded.value = !expanded.value
  layoutStore.setExpandedState(props.projectId, props.node.path, expanded.value)
  if (expanded.value) loadChildren()
}

function handleClick() {
  // Files open on single click; openInEditor dedupes by filePath so an
  // additional double click is a no-op instead of opening a second tab.
  if (props.node.isDirectory) toggleDir()
  else emit('open-in-editor', props.node.path)
}

function handleDblClick() {
  if (!props.node.isDirectory) {
    emit('open-in-editor', props.node.path)
  }
}

const treeFocus = inject<{ focusedPath: Ref<string>; setFocus: (p: string) => void } | null>(
  'fileTreeFocus',
  null
)

// Roving tabindex: the tree is a single tab stop, arrows move inside it.
const isTabStop = computed(() =>
  !treeFocus || treeFocus.focusedPath.value === ''
    ? props.depth === 0
    : treeFocus.focusedPath.value === props.node.path
)

function onFocus() {
  treeFocus?.setFocus(props.node.path)
}

function moveFocus(dir: 1 | -1, el: HTMLElement) {
  const root = el.closest('[role="tree"]')
  if (!root) return
  const items = Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]')).filter(
    (n) => n.offsetParent !== null
  )
  const next = items[items.indexOf(el) + dir]
  if (next) next.focus()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    if (props.node.isDirectory) toggleDir()
    else emit('open-in-editor', props.node.path)
  } else if (e.key === ' ') {
    e.preventDefault()
    if (props.node.isDirectory) toggleDir()
    else emit('open-in-editor', props.node.path)
  } else if (e.key === 'ArrowRight') {
    if (props.node.isDirectory && !expanded.value) {
      e.preventDefault()
      toggleDir()
    }
  } else if (e.key === 'ArrowLeft') {
    if (props.node.isDirectory && expanded.value) {
      e.preventDefault()
      toggleDir()
    }
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    moveFocus(e.key === 'ArrowDown' ? 1 : -1, e.currentTarget as HTMLElement)
  }
}

function showNodeMenu(e: MouseEvent) {
  showMenu(e, [
    { label: t('fileTree.openInEditor'), icon: 'file-text', disabled: props.node.isDirectory, action: () => emit('open-in-editor', props.node.path) },
    { label: t('fileTree.openInTerminal'), icon: 'terminal', action: openInTerminal },
    { label: t('fileTree.revealInFinder'), icon: 'external-link', action: () => window.electronAPI.showItemInFolder(props.node.path) },
    { label: t('fileTree.copyPath'), icon: 'copy', action: () => navigator.clipboard.writeText(props.node.path) },
    { separator: true },
    { label: t('fileTree.newFile'), icon: 'file-plus', action: () => createHere(false) },
    { label: t('fileTree.newFolder'), icon: 'folder-plus', action: () => createHere(true) },
    { label: t('fileTree.rename'), icon: 'file-text', action: renameNode },
    { separator: true },
    { label: t('fileTree.delete'), icon: 'trash', danger: true, action: deleteNode }
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

type PromptMode = 'create-file' | 'create-folder' | 'rename'

const promptMode = ref<PromptMode | null>(null)
const promptTitle = ref('')
const promptPlaceholder = ref('')
const promptInitial = ref('')
const promptConfirmText = ref('')
let createParent = ''

function dirname(p: string): string {
  return p.split('/').slice(0, -1).join('/')
}

function createHere(isDir: boolean) {
  createParent = props.node.isDirectory ? props.node.path : dirname(props.node.path)
  promptMode.value = isDir ? 'create-folder' : 'create-file'
  promptTitle.value = isDir ? t('fileTree.newFolder') : t('fileTree.newFile')
  promptPlaceholder.value = isDir ? t('fileTree.folderName') : t('fileTree.fileName')
  promptInitial.value = ''
  promptConfirmText.value = t('fileTree.create')
}

function renameNode() {
  promptMode.value = 'rename'
  promptTitle.value = t('fileTree.rename')
  promptPlaceholder.value = t('fileTree.newName')
  promptInitial.value = props.node.name
  promptConfirmText.value = t('fileTree.rename')
}

async function refreshAfterCreate() {
  if (props.node.isDirectory) {
    expanded.value = true
    children.value = await readDir(props.node.path, props.showHidden)
  } else {
    emit('refresh')
  }
}

async function onPromptConfirm(rawName: string) {
  const mode = promptMode.value
  promptMode.value = null
  const name = rawName.trim()
  if (!mode || !name) return

  if (mode === 'rename') {
    if (name === props.node.name) return
    await window.electronAPI.rename(props.node.path, joinPath(dirname(props.node.path), name))
    emit('refresh')
    return
  }

  const np = joinPath(createParent, name)
  if (mode === 'create-folder') {
    await window.electronAPI.mkdir(np)
  } else {
    await window.electronAPI.writeFile(np, '')
    emit('open-in-editor', np)
  }
  await refreshAfterCreate()
}

</script>

<style scoped>
.tree-node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  cursor: pointer;
  font-size: var(--text-xs);
  user-select: none;
  white-space: nowrap;
}
.tree-node:hover { background: var(--bg-hover); }
.tree-node:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--radius-sm);
}
.node-arrow { width: 14px; display: inline-flex; align-items: center; color: var(--text-faint); flex-shrink: 0; }
.node-no-arrow { width: 14px; flex-shrink: 0; }
.node-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex-shrink: 0;
}
.folder-icon { color: var(--text-accent); }
.file-emoji { font-size: var(--text-2xs); line-height: 1; }
.node-name { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.node-name.is-agent-modified { color: var(--accent-strong); font-weight: 500; }
.agent-badge {
  flex-shrink: 0;
  margin-right: 6px;
  font-size: var(--text-3xs);
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--accent-strong);
}
.agent-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  margin-right: 7px;
  border-radius: 50%;
  background: var(--accent-strong);
  opacity: 0.7;
}
</style>
