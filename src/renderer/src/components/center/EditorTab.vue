<template>
  <div class="editor-tab">
    <div ref="monacoEl" class="monaco-container" />
  </div>
</template>

<script lang="ts">
let untitledCounter = 0
</script>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, watch, nextTick } from 'vue'
import * as monaco from 'monaco-editor'
import { useProjectStore } from '../../stores/projects'
import { useTabStore } from '../../stores/tabs'
import { useSettingsStore } from '../../stores/settings'
import type { Tab } from '../../stores/tabs'

const props = defineProps<{ tab: Tab }>()

const projectStore = useProjectStore()
const tabStore = useTabStore()
const settingsStore = useSettingsStore()

const monacoEl = ref<HTMLDivElement | null>(null)
const currentFilePath = ref<string | null>(null)
const modified = ref(false)

let editor: monaco.editor.IStandaloneCodeEditor | null = null
let model: monaco.editor.ITextModel | null = null
let modelIsOwned = false
let resizeObs: ResizeObserver | null = null
let autoSaveTimer: number | null = null
let initialized = false

function log(msg: string) {
  // Debug logging disabled
  // console.log(`[EditorTab] ${msg}`)
}

function isScratchPath(fp: string): boolean {
  return fp.startsWith('untitled://')
}

onMounted(async () => {
  log('onMounted tabId=' + props.tab.id.slice(0, 8) + ' type=' + props.tab.type)
  log('settingsStore.settings keys=' + Object.keys(settingsStore.settings).join(','))
  log('settingsStore.settings.editorWordWrap=' + (settingsStore.settings as any).editorWordWrap)
  log('settingsStore.settings.wordWrap=' + (settingsStore.settings as any).wordWrap)

  await nextTick()
  const saved = props.tab.editorOpenFiles || []
  const active = props.tab.editorActiveFile || null
  if (saved.length > 0) {
    const fp = active || saved[0]
    try {
      const content = await window.electronAPI.readFile(fp)
      initMonaco(fp, content)
      currentFilePath.value = fp
      initialized = true
    } catch { createScratch() }
  } else {
    createScratch()
  }
  window.addEventListener('editor-toggle-wordwrap', onToggleWordWrapEvent)
})

function createScratch() {
  if (!monacoEl.value || initialized) return
  initialized = true
  untitledCounter++
  const scratchPath = `untitled://${untitledCounter}`
  initMonaco(scratchPath, '')
  currentFilePath.value = scratchPath
  editor?.focus()
}

function initMonaco(fp: string, content: string) {
  if (!monacoEl.value) return

  const uri = monaco.Uri.file(fp)
  const existing = monaco.editor.getModel(uri)
  if (existing) {
    model = existing
    if (existing.getValue() !== content) existing.setValue(content)
  } else {
    model = monaco.editor.createModel(content, detectLanguage(fp), uri)
    modelIsOwned = true
  }

  // Read wordWrap directly from settings
  const rawWW = (settingsStore.settings as any).editorWordWrap
  const rawWW2 = (settingsStore.settings as any).wordWrap
  const ww: 'off' | 'on' | 'wordWrapColumn' | 'bounded' =
    (rawWW === 'off' || rawWW === 'on' || rawWW === 'wordWrapColumn' || rawWW === 'bounded') ? rawWW : 'on'
  const wwc: number = (settingsStore.settings as any).editorWordWrapColumn || 80
  log('initMonaco: rawWW=' + rawWW + ' rawWW2=' + rawWW2 + ' resolvedWW=' + ww + ' wwc=' + wwc)

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
    wordWrap: ww,
    wordWrapColumn: wwc
  })

  // Verify what Monaco actually got
  const actualWW = editor.getOption(monaco.editor.EditorOption.wordWrap)
  log('initMonaco: Monaco actual wordWrap option=' + actualWW + ' (0=off,1=on,2=wordWrapColumn,3=bounded)')

  editor.onDidChangeModelContent(() => {
    if (!modified.value) {
      modified.value = true
      tabStore.updateTab(props.tab.projectId, props.tab.id, { modified: true })
    }
    scheduleAutoSave()
  })

  // Cmd/Ctrl+S save
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveCurrentFile())

  // Ctrl+Shift+P → open global command palette
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => {
    log('Ctrl+Shift+P pressed, dispatching open-command-palette')
    window.dispatchEvent(new CustomEvent('open-command-palette'))
  })

  // Alt+Z → toggle word wrap
  editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => {
    log('Alt+Z pressed, toggling word wrap')
    toggleWordWrap()
  })

  // Register as a Monaco action so F1 command palette can find it
  try {
    editor.addAction({
      id: 'editor.action.toggleWordWrap',
      label: 'Toggle Word Wrap',
      run: () => {
        log('F1 action Toggle Word Wrap triggered')
        toggleWordWrap()
      }
    })
    log('addAction editor.action.toggleWordWrap registered OK')
  } catch (e) {
    log('addAction FAILED: ' + String(e))
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

async function openFile(fp: string) {
  if (!monacoEl.value || !initialized) return
  try {
    const content = await window.electronAPI.readFile(fp)
    const uri = monaco.Uri.file(fp)
    const existing = monaco.editor.getModel(uri)
    if (existing) {
      if (model !== existing) {
        if (modelIsOwned) model?.dispose()
        modelIsOwned = false
      }
      model = existing
      if (existing.getValue() !== content) existing.setValue(content)
    } else {
      if (modelIsOwned) model?.dispose()
      model = monaco.editor.createModel(content, detectLanguage(fp), uri)
      modelIsOwned = true
    }
    editor?.setModel(model)
    currentFilePath.value = fp
    modified.value = false
    tabStore.updateTab(props.tab.projectId, props.tab.id, { modified: false })
    persistTabState()
  } catch (e) {
    console.error('Failed to open file', fp, e)
  }
}

async function saveCurrentFile() {
  const fp = currentFilePath.value
  if (!fp || !editor || !model) return
  const content = model.getValue()

  if (isScratchPath(fp)) {
    const savePath = await window.electronAPI.showSaveDialog()
    if (!savePath) return
    await window.electronAPI.writeFile(savePath, content)
    const saveUri = monaco.Uri.file(savePath)
    const saveExisting = monaco.editor.getModel(saveUri)
    let newModel: monaco.editor.ITextModel
    if (saveExisting) {
      newModel = saveExisting
      if (saveExisting.getValue() !== content) saveExisting.setValue(content)
      modelIsOwned = false
    } else {
      newModel = monaco.editor.createModel(content, detectLanguage(savePath), saveUri)
      modelIsOwned = true
    }
    editor.setModel(newModel)
    if (model !== newModel) model.dispose()
    model = newModel
    currentFilePath.value = savePath
    modified.value = false
    tabStore.updateTab(props.tab.projectId, props.tab.id, { modified: false })
    persistTabState()
    return
  }

  await window.electronAPI.writeFile(fp, content)
  modified.value = false
  tabStore.updateTab(props.tab.projectId, props.tab.id, { modified: false })
}

function scheduleAutoSave() {
  const fp = currentFilePath.value
  if (!fp || isScratchPath(fp)) return
  if (!settingsStore.settings.autoSaveInterval) return
  if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
  autoSaveTimer = window.setTimeout(async () => {
    if (currentFilePath.value === fp) await saveCurrentFile()
  }, settingsStore.settings.autoSaveInterval * 1000)
}

function persistTabState() {
  const fp = currentFilePath.value
  tabStore.updateTab(props.tab.projectId, props.tab.id, {
    editorOpenFiles: fp && !isScratchPath(fp) ? [fp] : [],
    editorActiveFile: fp && !isScratchPath(fp) ? fp : undefined
  })
}

function toggleWordWrap() {
  if (!editor) {
    log('toggleWordWrap: editor is null, skipping')
    return
  }
  const current = editor.getOption(monaco.editor.EditorOption.wordWrap)
  log('toggleWordWrap: current Monaco wordWrap=' + current + ' (0=off,1=on,2=col,3=bounded)')
  const next = current === 0 ? 'on' : 'off'
  log('toggleWordWrap: setting to ' + next)
  editor.updateOptions({ wordWrap: next })
  const after = editor.getOption(monaco.editor.EditorOption.wordWrap)
  log('toggleWordWrap: after updateOptions, Monaco wordWrap=' + after)
}

function onToggleWordWrapEvent() {
  log('received editor-toggle-wordwrap event')
  toggleWordWrap()
}

onActivated(() => {
  editor?.focus()
})

// Watch settings — same pattern that already works for theme/fontSize
watch(() => settingsStore.settings.theme, (t) => {
  monaco.editor.setTheme(t === 'dark' ? 'vs-dark' : 'vs')
})
watch(() => settingsStore.settings.fontSize, (s) => {
  editor?.updateOptions({ fontSize: s })
})

watch(() => settingsStore.settings.editorWordWrap, (newVal, oldVal) => {
  log('watch editorWordWrap fired: oldVal=' + oldVal + ' newVal=' + newVal)
  if (!editor) { log('watch: editor is null, skipping'); return }
  const wwc = (settingsStore.settings as any).editorWordWrapColumn || 80
  editor.updateOptions({ wordWrap: newVal || 'on', wordWrapColumn: wwc })
  const after = editor.getOption(monaco.editor.EditorOption.wordWrap)
  log('watch: after updateOptions, Monaco wordWrap=' + after)
})

watch(() => settingsStore.settings.editorWordWrapColumn, (newVal) => {
  log('watch editorWordWrapColumn fired: newVal=' + newVal)
  if (!editor) return
  editor.updateOptions({ wordWrapColumn: newVal || 80 })
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  editor?.dispose()
  if (modelIsOwned) model?.dispose()
  if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
  window.removeEventListener('editor-toggle-wordwrap', onToggleWordWrapEvent)
})

// Expose openFile so FileTreePanel / FileTreeRight can call it via template ref
defineExpose({ openFile })
</script>

<style scoped>
.editor-tab {
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
