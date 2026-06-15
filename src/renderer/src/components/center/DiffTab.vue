<template>
  <div class="diff-tab">
    <div class="diff-toolbar">
      <div class="diff-view-btns">
        <button
          class="diff-view-btn"
          :class="{ active: viewMode === 'sideBySide' }"
          @click="viewMode = 'sideBySide'"
        >Side by Side</button>
        <button
          class="diff-view-btn"
          :class="{ active: viewMode === 'inline' }"
          @click="viewMode = 'inline'"
        >Inline</button>
      </div>
      <span class="diff-file-name">{{ tab.diffFilePath || tab.title }}</span>
    </div>
    <div ref="diffEl" class="diff-container" />
    <div v-if="loading" class="diff-loading">Loading...</div>
    <div v-if="error" class="diff-error">{{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, watch, nextTick } from 'vue'
import * as monaco from 'monaco-editor'
import { useProjectStore } from '../../stores/projects'
import { useSettingsStore } from '../../stores/settings'
import type { Tab } from '../../stores/tabs'

const props = defineProps<{ tab: Tab }>()

const projectStore = useProjectStore()
const settingsStore = useSettingsStore()

const diffEl = ref<HTMLDivElement | null>(null)
const viewMode = ref<'sideBySide' | 'inline'>('sideBySide')
const loading = ref(true)
const error = ref('')

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null
let originalModel: monaco.editor.ITextModel | null = null
let modifiedModel: monaco.editor.ITextModel | null = null
let resizeObs: ResizeObserver | null = null

function detectLanguage(fp: string): string {
  const ext = fp.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    vue: 'html', py: 'python', go: 'go', rs: 'rust', java: 'java',
    cpp: 'cpp', c: 'c', h: 'c', cs: 'csharp', rb: 'ruby',
    php: 'php', css: 'css', scss: 'scss', less: 'less',
    html: 'html', json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml',
    sh: 'shell', bash: 'shell', toml: 'ini', xml: 'xml', sql: 'sql',
    kt: 'kotlin', swift: 'swift', dart: 'dart'
  }
  return map[ext] || 'plaintext'
}

onMounted(async () => {
  const fp = props.tab.diffFilePath
  if (!fp) {
    error.value = 'No file path'
    loading.value = false
    return
  }

  const project = projectStore.activeProject
  if (!project) {
    error.value = 'No active project'
    loading.value = false
    return
  }

  const staged = props.tab.diffStaged ?? false
  const lang = detectLanguage(fp)

  try {
    let originalContent = ''
    try {
      originalContent = await window.electronAPI.gitShowFile(project.path, 'HEAD', fp)
    } catch { /* new file */ }

    let modifiedContent = ''
    try {
      if (staged) {
        modifiedContent = await window.electronAPI.gitShowFile(project.path, '', fp)
      } else {
        modifiedContent = await window.electronAPI.readFile(project.path + '/' + fp)
      }
    } catch { /* deleted file */ }

    await nextTick()
    if (!diffEl.value) return

    const tabId = props.tab.id
    const origUri = monaco.Uri.parse(`git-original://${tabId}/${fp}`)
    const modUri = monaco.Uri.parse(`git-modified://${tabId}/${fp}`)

    originalModel = monaco.editor.getModel(origUri)
    if (!originalModel) {
      originalModel = monaco.editor.createModel(originalContent, lang, origUri)
    }
    modifiedModel = monaco.editor.getModel(modUri)
    if (!modifiedModel) {
      modifiedModel = monaco.editor.createModel(modifiedContent, lang, modUri)
    }

    diffEditor = monaco.editor.createDiffEditor(diffEl.value, {
      theme: settingsStore.settings.theme === 'dark' ? 'vs-dark' : 'vs',
      fontSize: settingsStore.settings.fontSize,
      automaticLayout: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'none',
      readOnly: true,
      renderSideBySide: true
    })

    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel
    })

    resizeObs = new ResizeObserver(() => {
      requestAnimationFrame(() => diffEditor?.layout())
    })
    resizeObs.observe(diffEl.value)

    loading.value = false
  } catch (e: any) {
    error.value = e.message || String(e)
    loading.value = false
  }
})

onActivated(() => {
  nextTick(() => diffEditor?.layout())
})

watch(viewMode, (mode) => {
  diffEditor?.updateOptions({ renderSideBySide: mode === 'sideBySide' })
})

watch(() => settingsStore.settings.theme, (t) => {
  monaco.editor.setTheme(t === 'dark' ? 'vs-dark' : 'vs')
})

watch(() => settingsStore.settings.fontSize, (s) => {
  diffEditor?.updateOptions({ fontSize: s })
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  diffEditor?.dispose()
  originalModel?.dispose()
  modifiedModel?.dispose()
})
</script>

<style scoped>
.diff-tab {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.diff-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.diff-view-btns {
  display: flex;
  gap: 0;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--border-color);
}

.diff-view-btn {
  padding: 2px 10px;
  font-size: 11px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
}

.diff-view-btn.active {
  background: var(--text-accent);
  color: #fff;
}

.diff-view-btn:not(.active):hover {
  background: var(--bg-hover);
}

.diff-file-name {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-container {
  flex: 1;
  width: 100%;
  min-height: 0;
  overflow: hidden;
}

.diff-loading,
.diff-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 13px;
}

.diff-error {
  color: var(--text-danger);
}
</style>