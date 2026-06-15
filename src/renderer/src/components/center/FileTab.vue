<template>
  <div class="file-tab">
    <div ref="monacoEl" class="monaco-container" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, watch } from 'vue'
import * as monaco from 'monaco-editor'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import { useProjectStore } from '../../stores/projects'
import type { Tab } from '../../stores/tabs'

const props = defineProps<{ tab: Tab }>()

const settingsStore = useSettingsStore()
const tabStore = useTabStore()
const projectStore = useProjectStore()

const monacoEl = ref<HTMLDivElement | null>(null)
const modified = ref(false)

const filePath = props.tab.filePath || ''
const fileName = filePath.split('/').pop() || filePath

let editor: monaco.editor.IStandaloneCodeEditor | null = null
let model: monaco.editor.ITextModel | null = null
let resizeObs: ResizeObserver | null = null
let autoSaveTimer: number | null = null

onMounted(async () => {
  if (!filePath) return
  try {
    const content = await window.electronAPI.readFile(filePath)
    initEditor(content)
  } catch (e) {
    console.error('Failed to open file', filePath, e)
  }
})

function initEditor(content: string) {
  if (!monacoEl.value) return

  const lang = detectLanguage(filePath)
  const uri = monaco.Uri.file(filePath)
  const existing = monaco.editor.getModel(uri)
  if (existing) {
    model = existing
    if (existing.getValue() !== content) existing.setValue(content)
  } else {
    model = monaco.editor.createModel(content, lang, uri)
  }

  editor = monaco.editor.create(monacoEl.value, {
    model,
    theme: settingsStore.settings.theme === 'dark' ? 'vs-dark' : 'vs',
    fontSize: settingsStore.settings.fontSize,
    automaticLayout: false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderWhitespace: 'none',
    lineNumbers: 'on',
    glyphMargin: false,
    folding: true,
    bracketPairColorization: { enabled: true }
  })

  editor.onDidChangeModelContent(() => {
    if (!modified.value) {
      modified.value = true
      tabStore.updateTab(props.tab.projectId, props.tab.id, { modified: true })
    }
    scheduleAutoSave()
  })

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save())

  // Jump to line if specified (e.g. from search results)
  if (props.tab.fileLine) {
    editor.revealLineInCenter(props.tab.fileLine)
    editor.setPosition({ lineNumber: props.tab.fileLine, column: 1 })
  }

  resizeObs = new ResizeObserver(() => editor?.layout())
  if (monacoEl.value) resizeObs.observe(monacoEl.value)
}

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

async function save() {
  if (!model) return
  const content = model.getValue()
  await window.electronAPI.writeFile(filePath, content)
  modified.value = false
  tabStore.updateTab(props.tab.projectId, props.tab.id, { modified: false })
}

function scheduleAutoSave() {
  if (!settingsStore.settings.autoSaveInterval) return
  if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
  autoSaveTimer = window.setTimeout(async () => {
    await save()
  }, settingsStore.settings.autoSaveInterval * 1000)
}

watch(() => settingsStore.settings.theme, (t) => {
  monaco.editor.setTheme(t === 'dark' ? 'vs-dark' : 'vs')
})
watch(() => settingsStore.settings.fontSize, (s) => {
  editor?.updateOptions({ fontSize: s })
})
watch(() => props.tab.fileLine, (line) => {
  if (line && editor) {
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: 1 })
  }
})

onActivated(() => {
  editor?.focus()
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  editor?.dispose()
  // Don't dispose model — it may be shared by other FileTab instances
  // (e.g. split pane opens the same file). Monaco manages model cache internally.
  if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
})
</script>

<style scoped>
.file-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.monaco-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
