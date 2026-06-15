<template>
  <div class="git-panel">
    <div v-if="!activeProject" class="git-empty">{{ $t('git.noProject') }}</div>
    <template v-else>
      <!-- Branch / status header -->
      <div class="git-header">
        <div class="git-branch" @click="showBranchMenu">
          <span>🔀</span>
          <span class="branch-name">{{ status?.branch || '...' }}</span>
          <span v-if="(status?.ahead ?? 0) > 0" class="badge-up">↑{{ status!.ahead }}</span>
          <span v-if="(status?.behind ?? 0) > 0" class="badge-down">↓{{ status!.behind }}</span>
        </div>
        <div class="git-actions">
          <button class="icon-btn" :title="$t('git.fetch')" @click="runFetch" :disabled="running">⬇</button>
          <button class="icon-btn" :title="$t('git.pull')" @click="runPull" :disabled="running">⇩</button>
          <button class="icon-btn" :title="$t('git.push')" @click="runPush" :disabled="running">⇧</button>
          <button class="icon-btn" :title="$t('git.refresh')" @click="loadStatus">↺</button>
        </div>
      </div>

      <div v-if="running" class="git-progress">{{ runningMsg }}</div>
      <div v-if="errorMsg" class="git-error">{{ errorMsg }}</div>

      <!-- Staged changes -->
      <div class="git-section" v-if="stagedFiles.length > 0">
        <div class="git-section-header" @click="stagedCollapsed = !stagedCollapsed">
          <span>{{ stagedCollapsed ? '▸' : '▾' }}</span>
          <span>{{ $t('git.staged') }} ({{ stagedFiles.length }})</span>
          <button class="mini-btn" :title="$t('git.unstage') + ' all'" @click.stop="unstageAll">−</button>
        </div>
        <template v-if="!stagedCollapsed">
          <div
            v-for="f in stagedFiles"
            :key="f.path"
            class="git-file"
            @click="viewDiff(f.path, true)"
            @contextmenu.prevent="showFileMenu($event, f, true)"
          >
            <span class="git-file-status" :class="statusClass(f.indexStatus)">{{ f.indexStatus }}</span>
            <span class="git-file-name">{{ f.path }}</span>
            <button class="mini-btn" :title="$t('git.unstage')" @click.stop="unstageFile(f.path)">−</button>
          </div>
        </template>
      </div>

      <!-- Changes (unstaged) -->
      <div class="git-section">
        <div class="git-section-header" @click="changesCollapsed = !changesCollapsed">
          <span>{{ changesCollapsed ? '▸' : '▾' }}</span>
          <span>{{ $t('git.changes') }} ({{ unstagedFiles.length }})</span>
          <button class="mini-btn" :title="$t('git.stage') + ' all'" @click.stop="stageAll">+</button>
        </div>
        <template v-if="!changesCollapsed">
          <div v-if="unstagedFiles.length === 0" class="git-file-empty">{{ $t('git.noUnstagedChanges') }}</div>
          <div
            v-for="f in unstagedFiles"
            :key="f.path"
            class="git-file"
            @click="viewDiff(f.path, false)"
            @contextmenu.prevent="showFileMenu($event, f, false)"
          >
            <span class="git-file-status" :class="statusClass(f.workingStatus)">{{ f.workingStatus }}</span>
            <span class="git-file-name">{{ f.path }}</span>
            <button class="mini-btn" :title="$t('git.stage')" @click.stop="stageFile(f.path)">+</button>
          </div>
        </template>
      </div>

      <!-- Commit box -->
      <div class="commit-box">
        <textarea
          v-model="commitMsg"
          :placeholder="$t('git.commitMessage')"
          class="commit-input"
          rows="2"
        />
        <button class="btn-primary commit-btn" :disabled="!commitMsg.trim() || running" @click="runCommit">
          {{ $t('git.commit') }}
        </button>
      </div>

      <!-- History -->
      <div class="git-section">
        <div class="git-section-header" @click="historyCollapsed = !historyCollapsed">
          <span>{{ historyCollapsed ? '▸' : '▾' }}</span>
          <span>{{ $t('git.history') }}</span>
        </div>
        <template v-if="!historyCollapsed">
          <div
            v-for="commit in commits"
            :key="commit.hash"
            class="commit-item"
            @click="selectedCommit = selectedCommit?.hash === commit.hash ? null : commit"
          >
            <div class="commit-hash">{{ commit.hash.slice(0, 7) }}</div>
            <div class="commit-msg">{{ commit.message }}</div>
            <div class="commit-meta">{{ commit.author_name }} · {{ formatDate(commit.date) }}</div>
          </div>
          <div v-if="selectedCommit" class="commit-detail">
            <div class="commit-detail-hash">{{ selectedCommit.hash }}</div>
            <pre class="commit-detail-body">{{ selectedCommit.body }}</pre>
          </div>
        </template>
      </div>
    </template>

    <!-- Branch picker -->
    <div v-if="showBranches" class="modal-overlay" @click.self="showBranches = false">
      <div class="modal">
        <div class="modal-title">{{ $t('git.switchBranch') }}</div>
        <div class="branch-list">
          <div
            v-for="b in branchList"
            :key="b"
            class="branch-item"
            :class="{ active: b === status?.branch }"
            @click="checkoutBranch(b)"
          >{{ b }}</div>
        </div>
        <div style="margin-top:12px">
          <input v-model="newBranchName" :placeholder="$t('git.newBranchName')" style="width:100%"/>
          <button class="btn-primary" style="margin-top:8px;width:100%" @click="createBranch">{{ $t('git.createAndSwitch') }}</button>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="showBranches = false">{{ $t('common.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProjectStore } from '../../stores/projects'
import { useTabStore } from '../../stores/tabs'
import { useContextMenu } from '../../composables/useContextMenu'
import type { GitStatus, GitCommit } from '../../../main/git'

const { t } = useI18n()
const projectStore = useProjectStore()
const tabStore = useTabStore()
const { show: showMenu } = useContextMenu()
const activeProject = computed(() => projectStore.activeProject)

interface GitFile { path: string; indexStatus: string; workingStatus: string }
const status = ref<GitStatus | null>(null)
const commits = ref<GitCommit[]>([])
const running = ref(false)
const runningMsg = ref('')
const errorMsg = ref('')
const commitMsg = ref('')
const stagedCollapsed = ref(false)
const changesCollapsed = ref(false)
const historyCollapsed = ref(false)
const showBranches = ref(false)
const branchList = ref<string[]>([])
const newBranchName = ref('')
const selectedCommit = ref<GitCommit | null>(null)

const stagedFiles = computed<GitFile[]>(() => {
  if (!status.value) return []
  const s = status.value
  const result: GitFile[] = []
  s.files.forEach((f) => {
    if (f.index && f.index !== ' ' && f.index !== '?') {
      result.push({ path: f.path, indexStatus: f.index, workingStatus: f.working_dir })
    }
  })
  return result
})

const unstagedFiles = computed<GitFile[]>(() => {
  if (!status.value) return []
  return status.value.files
    .filter((f) => f.working_dir && f.working_dir !== ' ')
    .map((f) => ({ path: f.path, indexStatus: f.index, workingStatus: f.working_dir }))
})

async function loadStatus() {
  if (!activeProject.value) return
  try {
    status.value = await window.electronAPI.gitStatus(activeProject.value.path) as GitStatus
    commits.value = (await window.electronAPI.gitLog(activeProject.value.path)) as GitCommit[]
    errorMsg.value = ''
  } catch (e: any) {
    status.value = null
    commits.value = []
    const msg = e.message || String(e)
    if (/not a git repository/i.test(msg)) {
      errorMsg.value = t('git.notARepo')
    } else {
      errorMsg.value = msg
    }
  }
}

watch(() => activeProject.value?.id, () => loadStatus(), { immediate: true })

let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  pollTimer = setInterval(loadStatus, 3000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

async function run(fn: () => Promise<void>, msg: string) {
  running.value = true
  runningMsg.value = msg
  errorMsg.value = ''
  try {
    await fn()
    await loadStatus()
  } catch (e: any) {
    errorMsg.value = e.message || String(e)
  } finally {
    running.value = false
    runningMsg.value = ''
  }
}

const runFetch = () => run(() => window.electronAPI.gitFetch(activeProject.value!.path), t('git.fetching'))
const runPull = () => run(() => window.electronAPI.gitPull(activeProject.value!.path) as Promise<void>, t('git.pulling'))
const runPush = () => run(() => window.electronAPI.gitPush(activeProject.value!.path) as Promise<void>, t('git.pushing'))

async function runCommit() {
  if (!commitMsg.value.trim()) return
  await run(() => window.electronAPI.gitCommit(activeProject.value!.path, commitMsg.value.trim()), t('git.committing'))
  commitMsg.value = ''
}

async function stageFile(fp: string) {
  await run(() => window.electronAPI.gitStage(activeProject.value!.path, fp), t('git.staging', { file: fp }))
}

async function unstageFile(fp: string) {
  await run(() => window.electronAPI.gitUnstage(activeProject.value!.path, fp), t('git.unstaging', { file: fp }))
}

async function stageAll() {
  await run(() => window.electronAPI.gitStageAll(activeProject.value!.path), t('git.staging', { file: 'all' }))
}

async function unstageAll() {
  for (const f of stagedFiles.value) {
    await window.electronAPI.gitUnstage(activeProject.value!.path, f.path)
  }
  await loadStatus()
}

async function viewDiff(fp: string, staged: boolean) {
  if (!activeProject.value) return
  await tabStore.addTab(activeProject.value.id, 'diff', {
    title: fp,
    diffFilePath: fp,
    diffStaged: staged
  })
}

function showFileMenu(e: MouseEvent, f: GitFile, staged: boolean) {
  showMenu(e, [
    { label: staged ? t('git.unstage') : t('git.stage'), action: () => staged ? unstageFile(f.path) : stageFile(f.path) },
    { label: t('git.viewDiff'), action: () => viewDiff(f.path, staged) },
    { label: t('fileTree.copyPath'), action: () => navigator.clipboard.writeText(f.path) }
  ])
}

async function showBranchMenu() {
  const r = await window.electronAPI.gitBranches(activeProject.value!.path)
  branchList.value = r.all
  showBranches.value = true
}

async function checkoutBranch(branch: string) {
  showBranches.value = false
  await run(() => window.electronAPI.gitCheckout(activeProject.value!.path, branch), t('git.switchingTo', { branch }))
}

async function createBranch() {
  if (!newBranchName.value.trim()) return
  showBranches.value = false
  await run(() => window.electronAPI.gitCreateBranch(activeProject.value!.path, newBranchName.value.trim()), t('git.creatingBranch', { branch: newBranchName.value }))
  newBranchName.value = ''
}

function statusClass(s: string): string {
  switch (s) {
    case 'M': return 'status-m'
    case 'A': return 'status-a'
    case 'D': return 'status-d'
    case 'R': return 'status-r'
    case '?': return 'status-u'
    case 'C': return 'status-c'
    default: return ''
  }
}

function formatDate(d: string): string {
  try { return new Date(d).toLocaleDateString() } catch { return d }
}
</script>

<style scoped>
.git-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  font-size: 12px;
}
.git-empty { padding: 16px; color: var(--text-secondary); text-align: center; }
.git-header {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-color);
  gap: 4px;
}
.git-branch {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
}
.git-branch:hover { background: var(--bg-hover); }
.branch-name { font-weight: 600; color: var(--text-accent); }
.badge-up { color: var(--text-success); font-size: 10px; }
.badge-down { color: #f59e0b; font-size: 10px; }
.git-actions { display: flex; gap: 2px; }
.git-progress { padding: 4px 8px; font-size: 11px; color: var(--text-secondary); font-style: italic; }
.git-error { padding: 4px 8px; font-size: 11px; color: var(--text-danger); background: rgba(244,67,71,0.1); }
.git-section { border-bottom: 1px solid var(--border-color); }
.git-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-weight: 600;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.git-section-header:hover { background: var(--bg-hover); }
.mini-btn {
  margin-left: auto;
  font-size: 13px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  color: var(--text-secondary);
}
.mini-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.git-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px 2px 20px;
  cursor: pointer;
}
.git-file:hover { background: var(--bg-hover); }
.git-file-status {
  width: 16px;
  text-align: center;
  font-weight: 700;
  font-size: 11px;
  flex-shrink: 0;
}
.status-m { color: #f59e0b; }
.status-a { color: var(--text-success); }
.status-d { color: var(--text-danger); }
.status-r { color: #7c3aed; }
.status-u { color: var(--text-secondary); }
.status-c { color: var(--text-danger); }
.git-file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.git-file-empty { padding: 4px 20px; color: var(--text-secondary); font-size: 11px; }
.commit-box {
  padding: 8px;
  border-bottom: 1px solid var(--border-color);
}
.commit-input {
  width: 100%;
  resize: vertical;
  font-size: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: 3px;
  padding: 4px 6px;
}
.commit-btn { width: 100%; margin-top: 6px; padding: 5px; }
.commit-item { padding: 5px 8px; cursor: pointer; border-bottom: 1px solid var(--border-color); }
.commit-item:hover { background: var(--bg-hover); }
.commit-hash { color: var(--text-accent); font-family: monospace; font-size: 11px; }
.commit-msg { font-weight: 500; }
.commit-meta { font-size: 10px; color: var(--text-secondary); }
.commit-detail { padding: 8px; background: var(--bg-tertiary); font-size: 11px; }
.commit-detail-hash { font-family: monospace; color: var(--text-accent); margin-bottom: 4px; }
.commit-detail-body { white-space: pre-wrap; color: var(--text-secondary); }
.branch-list { max-height: 200px; overflow-y: auto; }
.branch-item {
  padding: 5px 8px;
  cursor: pointer;
  border-radius: 3px;
  font-size: 12px;
}
.branch-item:hover { background: var(--bg-hover); }
.branch-item.active { color: var(--text-accent); font-weight: 600; }
</style>
