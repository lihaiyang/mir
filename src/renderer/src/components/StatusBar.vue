<template>
  <div class="status-bar">
    <div class="status-left">
      <span v-if="gitBranch" ref="branchEl" class="status-item git-branch clickable" @click="openBranchPicker">
        <Icon name="git-branch" :size="12" /> {{ gitBranch }}
      </span>
      <span v-if="gitAhead > 0" class="status-badge ahead">↑{{ gitAhead }}</span>
      <span v-if="gitBehind > 0" class="status-badge behind">↓{{ gitBehind }}</span>
      <span v-if="!gitBranch" class="status-item">MIR</span>
    </div>
    <div class="status-right">
      <template v-if="hasEditor">
        <span class="status-item" :title="$t('status.lineColumn') + ' — click to go to line'" @click="goToLine">
          Ln {{ cursorLine }}, Col {{ cursorColumn }}
        </span>
        <span ref="languageEl" class="status-item clickable" :title="$t('status.language')" @click="openLanguagePicker">{{ language || 'Plain Text' }}</span>
        <span ref="encodingEl" class="status-item clickable" :title="$t('status.encoding')" @click="openEncodingPicker">{{ encoding }}</span>
        <span ref="lineEndingEl" class="status-item clickable" :title="$t('status.lineEnding')" @click="toggleLineEnding">{{ lineEnding }}</span>
      </template>
      <template v-else>
        <span class="status-item">Ready</span>
      </template>
    </div>
  </div>

  <StatusBarPicker
    v-if="showPicker && pickerTarget"
    :target="pickerTarget"
    :items="pickerItems"
    :current-value="pickerCurrentValue"
    :placeholder="pickerPlaceholder"
    filterable
    @select="onPickerSelect"
    @close="closePicker"
  >
    <template v-if="pickerMode === 'branch'" #footer>
      <div class="branch-footer">
        <input
          v-model="newBranchName"
          class="branch-input"
          :placeholder="$t('status.newBranchName')"
          @keydown.enter.prevent="createBranchFromPicker"
        />
        <button class="btn-primary branch-create-btn" @click="createBranchFromPicker">
          {{ $t('status.createAndSwitch') }}
        </button>
      </div>
    </template>
  </StatusBarPicker>

  <BranchSwitchConfirm
    v-if="showBranchConfirm"
    :branch="pendingBranch"
    @choice="onBranchConfirmChoice"
  />
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as monaco from 'monaco-editor'
import { useProjectStore } from '../stores/projects'
import { useTabStore } from '../stores/tabs'
import StatusBarPicker from './StatusBarPicker.vue'
import BranchSwitchConfirm from './BranchSwitchConfirm.vue'
import Icon from './ui/Icon.vue'
import type { PickerItem } from './StatusBarPicker.vue'
import type { GitStatus } from '../../main/git'

const { t } = useI18n()
const projectStore = useProjectStore()
const tabStore = useTabStore()

const hasEditor = ref(false)
const language = ref('')
const encoding = ref('UTF-8')
const lineEnding = ref('LF')
const cursorLine = ref(1)
const cursorColumn = ref(1)
const gitBranch = ref<string | null>(null)
const gitAhead = ref(0)
const gitBehind = ref(0)

const languageEl = ref<HTMLElement | null>(null)
const encodingEl = ref<HTMLElement | null>(null)
const lineEndingEl = ref<HTMLElement | null>(null)
const branchEl = ref<HTMLElement | null>(null)

const pickerTarget = ref<HTMLElement | null>(null)
const pickerItems = ref<PickerItem[]>([])
const pickerCurrentValue = ref('')
const pickerPlaceholder = ref('')
const pickerMode = ref<'language' | 'encoding' | 'branch'>('language')
const showPicker = ref(false)
const showBranchConfirm = ref(false)
const pendingBranch = ref('')
const newBranchName = ref('')

function goToLine() {
  window.dispatchEvent(new CustomEvent('statusbar-goto-line'))
}

function formatLanguage(lang: string): string {
  const map: Record<string, string> = {
    typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python',
    go: 'Go', rust: 'Rust', java: 'Java', cpp: 'C++', c: 'C',
    csharp: 'C#', ruby: 'Ruby', php: 'PHP', css: 'CSS', scss: 'SCSS',
    less: 'Less', html: 'HTML', json: 'JSON', markdown: 'Markdown',
    yaml: 'YAML', shell: 'Shell', bash: 'Shell', sql: 'SQL', xml: 'XML',
    kotlin: 'Kotlin', swift: 'Swift', dart: 'Dart', vue: 'Vue',
    plaintext: 'Plain Text', diff: 'Diff'
  }
  return map[lang.toLowerCase()] || lang
}

function detectLanguageFromFile(fp: string): string {
  if (!fp) return ''
  const ext = fp.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    vue: 'vue', py: 'python', go: 'go', rs: 'rust', java: 'java',
    cpp: 'cpp', c: 'c', h: 'c', cs: 'csharp', rb: 'ruby', php: 'php',
    css: 'css', scss: 'scss', less: 'less', html: 'html', json: 'json',
    md: 'markdown', yaml: 'yaml', yml: 'yaml', sh: 'shell', bash: 'shell',
    sql: 'sql', xml: 'xml', kt: 'kotlin', swift: 'swift', dart: 'dart'
  }
  return formatLanguage(map[ext] || '')
}

function activeTabChanged() {
  const pid = projectStore.activeProjectId
  if (!pid) {
    hasEditor.value = false
    return
  }
  const tab = tabStore.getActiveTab(pid)
  if (!tab) {
    hasEditor.value = false
    return
  }
  if (tab.type === 'editor' || tab.type === 'file') {
    const fp = tab.filePath || tab.editorActiveFile || ''
    hasEditor.value = true
    language.value = formatLanguage(tab.languageOverride || detectLanguageFromFile(fp))
    encoding.value = (tab.encoding || 'UTF-8').toUpperCase()
    lineEnding.value = (tab.lineEnding || 'lf').toUpperCase()
  } else if (tab.type === 'diff') {
    hasEditor.value = true
    language.value = 'Diff'
    encoding.value = 'UTF-8'
    lineEnding.value = 'LF'
  } else {
    hasEditor.value = false
  }
}

function onCursorChange(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.line != null) cursorLine.value = detail.line
  if (detail?.column != null) cursorColumn.value = detail.column
}

function onEditorActive(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.active != null) hasEditor.value = detail.active
  if (detail?.language != null) language.value = formatLanguage(detail.language)
  if (detail?.encoding != null) encoding.value = String(detail.encoding).toUpperCase()
  if (detail?.lineEnding != null) lineEnding.value = String(detail.lineEnding).toUpperCase()
}

function onGitInfo(e: Event) {
  const detail = (e as CustomEvent).detail
  gitBranch.value = detail?.branch ?? null
  gitAhead.value = detail?.ahead ?? 0
  gitBehind.value = detail?.behind ?? 0
}

async function loadGitStatus() {
  const p = projectStore.activeProject
  if (!p) return
  try {
    const s = await window.electronAPI.gitStatus(p.path) as { branch: string; ahead: number; behind: number } | null
    if (s) {
      gitBranch.value = s.branch
      gitAhead.value = s.ahead ?? 0
      gitBehind.value = s.behind ?? 0
    }
  } catch { /* ignore */ }
}

onMounted(() => {
  window.addEventListener('statusbar-cursor', onCursorChange)
  window.addEventListener('statusbar-editor', onEditorActive)
  window.addEventListener('statusbar-git', onGitInfo)
  window.addEventListener('statusbar-init', activeTabChanged)
  activeTabChanged()
  loadGitStatus()
})

onUnmounted(() => {
  window.removeEventListener('statusbar-cursor', onCursorChange)
  window.removeEventListener('statusbar-editor', onEditorActive)
  window.removeEventListener('statusbar-git', onGitInfo)
  window.removeEventListener('statusbar-init', activeTabChanged)
})

watch(() => projectStore.activeProjectId, activeTabChanged)
watch(
  () => {
    const pid = projectStore.activeProjectId
    return pid ? tabStore.getActiveTabId(pid) : null
  },
  activeTabChanged
)

// --- Pickers ---

function openLanguagePicker() {
  if (!languageEl.value) return
  const langs = monaco.languages.getLanguages().map(l => ({
    value: l.id,
    label: l.aliases?.[0] ? `${l.aliases[0]} (${l.id})` : l.id
  }))
  pickerItems.value = langs.sort((a, b) => a.label.localeCompare(b.label))
  pickerCurrentValue.value = formatLanguageToMonacoId(language.value)
  pickerPlaceholder.value = t('status.selectLanguage')
  pickerMode.value = 'language'
  pickerTarget.value = languageEl.value
  showPicker.value = true
}

function openEncodingPicker() {
  if (!encodingEl.value) return
  const encodings = [
    { value: 'utf-8', label: 'UTF-8' },
    { value: 'utf-8-bom', label: 'UTF-8 with BOM' },
    { value: 'gbk', label: 'GBK' },
    { value: 'gb2312', label: 'GB2312' },
    { value: 'gb18030', label: 'GB18030' },
    { value: 'big5', label: 'Big5' },
    { value: 'shift_jis', label: 'Shift_JIS' },
    { value: 'euc-kr', label: 'EUC-KR' },
    { value: 'latin1', label: 'Latin1' }
  ]
  pickerItems.value = encodings
  pickerCurrentValue.value = encoding.value.toLowerCase()
  pickerPlaceholder.value = t('status.selectEncoding')
  pickerMode.value = 'encoding'
  pickerTarget.value = encodingEl.value
  showPicker.value = true
}

function toggleLineEnding() {
  const next = lineEnding.value === 'LF' ? 'crlf' : 'lf'
  window.dispatchEvent(new CustomEvent('editor-set-line-ending', { detail: { lineEnding: next } }))
}

function formatLanguageToMonacoId(displayName: string): string {
  const map: Record<string, string> = {
    typescript: 'typescript', javascript: 'javascript', python: 'python',
    go: 'go', rust: 'rust', java: 'java', 'c++': 'cpp', c: 'c',
    'c#': 'csharp', ruby: 'ruby', php: 'php', css: 'css', scss: 'scss',
    less: 'less', html: 'html', json: 'json', markdown: 'markdown',
    yaml: 'yaml', shell: 'shell', sql: 'sql', xml: 'xml',
    kotlin: 'kotlin', swift: 'swift', dart: 'dart', vue: 'vue',
    'plain text': 'plaintext', diff: 'diff'
  }
  return map[displayName.toLowerCase()] || displayName
}

function onPickerSelect(value: string) {
  showPicker.value = false
  if (pickerMode.value === 'language') {
    window.dispatchEvent(new CustomEvent('editor-set-language', { detail: { language: value } }))
  } else if (pickerMode.value === 'encoding') {
    window.dispatchEvent(new CustomEvent('editor-set-encoding', { detail: { encoding: value } }))
  } else if (pickerMode.value === 'branch') {
    handleBranchSwitch(value)
  }
}

function closePicker() {
  showPicker.value = false
}

async function openBranchPicker() {
  if (!branchEl.value || !projectStore.activeProject) return
  try {
    const r = await window.electronAPI.gitBranches(projectStore.activeProject.path)
    pickerItems.value = r.all.map(b => ({ value: b, label: b }))
    pickerCurrentValue.value = gitBranch.value || ''
    pickerPlaceholder.value = t('status.switchBranch')
    pickerMode.value = 'branch'
    pickerTarget.value = branchEl.value
    newBranchName.value = ''
    showPicker.value = true
  } catch (e) {
    window.dispatchEvent(new CustomEvent('mir-notification', {
      detail: { type: 'error', text: 'Failed to load branches' }
    }))
  }
}

async function createBranchFromPicker() {
  const name = newBranchName.value.trim()
  if (!name || !projectStore.activeProject) return
  showPicker.value = false
  try {
    await window.electronAPI.gitCreateBranch(projectStore.activeProject.path, name)
    await refreshGitStatus()
    window.dispatchEvent(new CustomEvent('git-refreshed'))
    window.dispatchEvent(new CustomEvent('mir-notification', {
      detail: { type: 'success', text: `Switched to new branch ${name}` }
    }))
  } catch (e: any) {
    window.dispatchEvent(new CustomEvent('mir-notification', {
      detail: { type: 'error', text: e.message || 'Failed to create branch' }
    }))
  }
}

async function handleBranchSwitch(branch: string) {
  if (branch === gitBranch.value) return
  const project = projectStore.activeProject
  if (!project) return

  try {
    const status = await window.electronAPI.gitStatus(project.path) as GitStatus
    const dirty = status.staged.length + status.modified.length + status.notAdded.length + status.deleted.length + status.renamed.length + status.conflicted.length > 0

    if (dirty) {
      pendingBranch.value = branch
      showBranchConfirm.value = true
      return
    }

    await doBranchSwitch(branch)
  } catch (e: any) {
    window.dispatchEvent(new CustomEvent('mir-notification', {
      detail: { type: 'error', text: e.message || 'Failed to switch branch' }
    }))
  }
}

async function onBranchConfirmChoice(choice: 'stash' | 'discard' | 'cancel') {
  showBranchConfirm.value = false
  if (choice === 'cancel') return
  await doBranchSwitch(pendingBranch.value, choice)
}

async function doBranchSwitch(branch: string, mode?: 'stash' | 'discard') {
  const project = projectStore.activeProject
  if (!project) return

  try {
    if (mode === 'stash') {
      await window.electronAPI.gitStashPush(project.path, `WIP before switching to ${branch}`)
      await window.electronAPI.gitCheckout(project.path, branch)
      await window.electronAPI.gitStashPop(project.path).catch((err: any) => {
        window.dispatchEvent(new CustomEvent('mir-notification', {
          detail: { type: 'warning', text: err?.message || 'Stash pop failed. Resolve conflicts manually.' }
        }))
      })
    } else if (mode === 'discard') {
      await window.electronAPI.gitCheckoutDiscard(project.path)
      await window.electronAPI.gitCheckout(project.path, branch)
    } else {
      await window.electronAPI.gitCheckout(project.path, branch)
    }

    await refreshGitStatus()
    window.dispatchEvent(new CustomEvent('git-refreshed'))
    window.dispatchEvent(new CustomEvent('mir-notification', {
      detail: { type: 'success', text: `Switched to ${branch}` }
    }))
  } catch (e: any) {
    window.dispatchEvent(new CustomEvent('mir-notification', {
      detail: { type: 'error', text: e.message || 'Failed to switch branch' }
    }))
  }
}

async function refreshGitStatus() {
  const project = projectStore.activeProject
  if (!project) return
  try {
    const s = await window.electronAPI.gitStatus(project.path) as GitStatus
    gitBranch.value = s.branch
    gitAhead.value = s.ahead ?? 0
    gitBehind.value = s.behind ?? 0
    window.dispatchEvent(new CustomEvent('statusbar-git', {
      detail: { branch: s.branch, ahead: s.ahead ?? 0, behind: s.behind ?? 0 }
    }))
  } catch { /* ignore */ }
}
</script>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 22px;
  padding: 0 8px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
  user-select: none;
}

.status-left,
.status-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-item {
  cursor: default;
  padding: 1px 4px;
  border-radius: 2px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.status-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.status-item.clickable {
  cursor: pointer;
}

.git-branch {
  font-weight: 600;
  color: var(--text-accent);
}

.status-badge {
  font-size: 10px;
  font-weight: 600;
}

.ahead { color: var(--text-success); }
.behind { color: #f59e0b; }

.branch-footer {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.branch-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 12px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  outline: none;
}

.branch-create-btn {
  width: 100%;
  padding: 5px 8px;
  font-size: 12px;
}
</style>
