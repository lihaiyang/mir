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
// Track the live word-wrap state per editor instance so toggle is reliable.
// (Monaco's getOption returns the string value, but comparing against the
// internal enum is fragile — we track it ourselves instead.)
let currentWordWrap: 'off' | 'on' | 'wordWrapColumn' | 'bounded' = 'on'

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
    bracketPairColorization: { enabled: true },
    wordWrap: resolveWordWrap(),
    wordWrapColumn: resolveWordWrapColumn()
  })

  editor.onDidChangeModelContent(() => {
    if (!modified.value) {
      modified.value = true
      tabStore.updateTab(props.tab.projectId, props.tab.id, { modified: true })
    }
    scheduleAutoSave()
  })

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save())

  // Ctrl+Shift+P → open the global command palette instead of Monaco's built-in one
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => {
    window.dispatchEvent(new CustomEvent('open-command-palette'))
  })

  // Register Toggle Word Wrap as a single Monaco action — this covers three entry
  // points at once: the F1 command palette, the editor right-click (context) menu,
  // and the Alt+Z keyboard shortcut (same as VS Code). On macOS Alt maps to Option (⌥).
  editor.addAction({
    id: 'editor.action.toggleWordWrap',
    label: 'Toggle Word Wrap',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
    contextMenuGroupId: '2_view',
    contextMenuOrder: 1,
    run: () => toggleWordWrap()
  })

  // Jump to line if specified (e.g. from search results)
  if (props.tab.fileLine) {
    editor.revealLineInCenter(props.tab.fileLine)
    editor.setPosition({ lineNumber: props.tab.fileLine, column: 1 })
  }

  resizeObs = new ResizeObserver(() => editor?.layout())
  if (monacoEl.value) resizeObs.observe(monacoEl.value)

  currentWordWrap = resolveWordWrap()
}

function resolveWordWrap(): 'off' | 'on' | 'wordWrapColumn' | 'bounded' {
  const v = settingsStore.settings.editorWordWrap
  if (v === 'off' || v === 'on' || v === 'wordWrapColumn' || v === 'bounded') return v
  return 'on'
}

function resolveWordWrapColumn(): number {
  return settingsStore.settings.editorWordWrapColumn || 80
}

function toggleWordWrap() {
  if (!editor) return
  const next: 'off' | 'on' = currentWordWrap === 'off' ? 'on' : 'off'
  currentWordWrap = next
  editor.updateOptions({ wordWrap: next })
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
watch(() => settingsStore.settings.editorWordWrap, () => {
  const ww = resolveWordWrap()
  currentWordWrap = ww
  editor?.updateOptions({ wordWrap: ww, wordWrapColumn: resolveWordWrapColumn() })
})
watch(() => settingsStore.settings.editorWordWrapColumn, () => {
  editor?.updateOptions({ wordWrapColumn: resolveWordWrapColumn() })
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
