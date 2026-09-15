<template>
  <div class="editor-tab">
    <div class="editor-split" :class="{ 'show-preview': isMarkdown && showPreview }">
      <div ref="monacoEl" class="monaco-container" />
      <div v-if="isMarkdown && showPreview" class="md-preview-pane">
        <MarkdownPreview :content="previewContent" />
      </div>
    </div>
    <button
      v-if="isMarkdown"
      class="preview-toggle-btn"
      :title="showPreview ? t('editor.hidePreview') : t('editor.showPreview')"
      @click="togglePreview"
    >{{ showPreview ? '📊' : '📖' }}</button>
  </div>
</template>

<script lang="ts">
let untitledCounter = 0
</script>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, nextTick, computed } from 'vue'
import * as monaco from 'monaco-editor'
import { useI18n } from 'vue-i18n'
import { useProjectStore } from '../../stores/projects'
import { useTabStore } from '../../stores/tabs'
import { useSettingsStore } from '../../stores/settings'
import { useRecentStore } from '../../stores/recent'
import { useFileMetaStore } from '../../stores/fileMeta'
import type { Tab } from '../../stores/tabs'
import { acquireModel, releaseModel } from '../../utils/monacoModels'
import MarkdownPreview from './MarkdownPreview.vue'

const { t } = useI18n()
const props = defineProps<{ tab: Tab }>()

const projectStore = useProjectStore()
const tabStore = useTabStore()
const settingsStore = useSettingsStore()
const _recentStore = useRecentStore()
const fileMetaStore = useFileMetaStore()

const monacoEl = ref<HTMLDivElement | null>(null)
const currentFilePath = ref<string | null>(null)
const modified = ref(false)
const previewContent = ref('')
const showPreview = ref(true)

const isMarkdown = computed(() => {
  const fp = currentFilePath.value || ''
  return fp.endsWith('.md') || fp.endsWith('.markdown') || fp.endsWith('.mdx')
})

let editor: monaco.editor.IStandaloneCodeEditor | null = null
let model: monaco.editor.ITextModel | null = null
// Path of the model currently held via acquireModel(); released on unmount /
// file switch. Shared models are refcounted — see utils/monacoModels.ts.
let acquiredPath: string | null = null
let resizeObs: ResizeObserver | null = null
let autoSaveTimer: number | null = null
let cleanContent = ''
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
      const encoding = props.tab.encoding || fileMetaStore.get(fp)?.encoding
      const { content, encoding: detectedEncoding } = await window.electronAPI.readFile(fp, encoding)
      if (!props.tab.encoding && detectedEncoding) {
        tabStore.updateTab(props.tab.projectId, props.tab.id, { encoding: detectedEncoding })
      }
      initMonaco(fp, content)
      currentFilePath.value = fp
      if (isMarkdown.value && showPreview.value && model) {
        previewContent.value = model.getValue()
      }
      window.dispatchEvent(new CustomEvent('statusbar-editor', { detail: { active: true, language: detectLanguage(fp), encoding: detectedEncoding } }))
      initialized = true
    } catch { createScratch() }
  } else {
    createScratch()
    window.dispatchEvent(new CustomEvent('statusbar-editor', { detail: { active: true, language: '', encoding: 'utf-8' } }))
  }
  window.addEventListener('editor-toggle-wordwrap', onToggleWordWrapEvent)
  window.addEventListener('statusbar-goto-line', onStatusBarGotoLine)
  window.addEventListener('editor-set-language', onSetLanguage)
  window.addEventListener('editor-set-encoding', onSetEncoding)
  window.addEventListener('editor-set-line-ending', onSetLineEnding)
  window.addEventListener('editor-save', onEditorSave)
  window.addEventListener('editor-find', onEditorFind)
})

function onStatusBarGotoLine() {
  editor?.getAction('editor.action.gotoLine')?.run()
}

function onSetLanguage(e: Event) {
  const lang = (e as CustomEvent).detail?.language
  if (!lang || !model) return
  monaco.editor.setModelLanguage(model, lang)
  tabStore.updateTab(props.tab.projectId, props.tab.id, { languageOverride: lang })
  const fp = currentFilePath.value
  if (fp && !isScratchPath(fp)) fileMetaStore.set(fp, { languageOverride: lang })
  window.dispatchEvent(new CustomEvent('statusbar-editor', {
    detail: { active: true, language: lang, encoding: props.tab.encoding || 'utf-8' }
  }))
}

async function onSetEncoding(e: Event) {
  const encoding = (e as CustomEvent).detail?.encoding
  if (!encoding) return
  const fp = currentFilePath.value
  if (!fp || isScratchPath(fp)) return
  try {
    const { content } = await window.electronAPI.readFile(fp, encoding)
    model?.setValue(content)
    tabStore.updateTab(props.tab.projectId, props.tab.id, { encoding })
    fileMetaStore.set(fp, { encoding })
    window.dispatchEvent(new CustomEvent('statusbar-editor', {
      detail: { active: true, language: props.tab.languageOverride || detectLanguage(fp), encoding }
    }))
  } catch (err) {
    window.dispatchEvent(new CustomEvent('mir-notification', {
      detail: { type: 'error', text: `Failed to reload file with ${encoding}` }
    }))
  }
}

function onSetLineEnding(e: Event) {
  const le = (e as CustomEvent).detail?.lineEnding
  if (!le || !model) return
  const eol = le === 'crlf'
    ? monaco.editor.EndOfLineSequence.CRLF
    : monaco.editor.EndOfLineSequence.LF
  model.setEOL(eol)
  tabStore.updateTab(props.tab.projectId, props.tab.id, { lineEnding: le })
  const fp = currentFilePath.value
  if (fp && !isScratchPath(fp)) fileMetaStore.set(fp, { lineEnding: le })
  window.dispatchEvent(new CustomEvent('statusbar-editor', {
    detail: { active: true, language: props.tab.languageOverride || detectLanguage(fp || ''), lineEnding: le, encoding: props.tab.encoding || 'utf-8' }
  }))
}

function onEditorSave(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.tabId !== props.tab.id) return
  saveCurrentFile()
}

function onEditorFind(e: Event) {
  const detail = (e as CustomEvent).detail
  if (detail?.tabId !== props.tab.id) return
  editor?.getAction('actions.find')?.run()
}

function createScratch() {
  if (!monacoEl.value || initialized) return
  initialized = true
  untitledCounter++
  const scratchPath = `untitled://${untitledCounter}`
  initMonaco(scratchPath, '')
  currentFilePath.value = scratchPath
  editor?.focus()
  window.dispatchEvent(new CustomEvent('statusbar-editor', { detail: { active: true, language: '' } }))
}

function initMonaco(fp: string, content: string) {
  if (!monacoEl.value) return

  const lang = props.tab.languageOverride || fileMetaStore.get(fp)?.languageOverride || detectLanguage(fp)
  model = acquireModel(fp, content, lang)
  if (model.getValue() !== content) model.setValue(content)
  acquiredPath = fp

  const le = props.tab.lineEnding || fileMetaStore.get(fp)?.lineEnding
  if (le && model) {
    model.setEOL(le === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF)
  }
  cleanContent = model.getValue()

  // Initialize preview content for markdown files
  showPreview.value = settingsStore.settings.markdownPreview !== false
  if (isMarkdown.value && showPreview.value) {
    previewContent.value = cleanContent
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
    const dirty = model.getValue() !== cleanContent
    if (dirty !== modified.value) {
      modified.value = dirty
      tabStore.updateTab(props.tab.projectId, props.tab.id, { modified: dirty })
    }
    if (dirty) scheduleAutoSave()
    if (isMarkdown.value && showPreview.value) {
      previewContent.value = model?.getValue() || ''
    }
  })

  editor.onDidChangeCursorPosition((e) => {
    window.dispatchEvent(new CustomEvent('statusbar-cursor', { detail: { line: e.position.lineNumber, column: e.position.column } }))
  })

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

  // Editor keyboard shortcuts
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD, () => {
    const sel = editor.getSelection()
    if (sel && !sel.isEmpty()) {
      editor.trigger('keyboard', 'editor.action.addSelectionToNextFindMatch', null)
    }
  })

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL, () => {
    const sel = editor.getSelection()
    if (sel && !sel.isEmpty()) {
      editor.trigger('keyboard', 'editor.action.selectHighlights', null)
    }
  })

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyK, () => {
    editor.trigger('keyboard', 'editor.action.deleteLines', null)
  })

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash, () => {
    editor.trigger('keyboard', 'editor.action.commentLine', null)
  })

  editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => {
    editor.trigger('keyboard', 'editor.action.moveLinesUpAction', null)
  })

  editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => {
    editor.trigger('keyboard', 'editor.action.moveLinesDownAction', null)
  })

  editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => {
    editor.trigger('keyboard', 'editor.action.copyLinesUpAction', null)
  })

  editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => {
    editor.trigger('keyboard', 'editor.action.copyLinesDownAction', null)
  })

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
    const encoding = props.tab.encoding || fileMetaStore.get(fp)?.encoding
    const { content, encoding: detectedEncoding } = await window.electronAPI.readFile(fp, encoding)
    if (!props.tab.encoding && detectedEncoding) {
      tabStore.updateTab(props.tab.projectId, props.tab.id, { encoding: detectedEncoding })
    }
    const newModel = acquireModel(fp, content, detectLanguage(fp))
    if (newModel.getValue() !== content) newModel.setValue(content)
    editor?.setModel(newModel)
    if (model !== newModel && acquiredPath && acquiredPath !== fp) releaseModel(acquiredPath)
    model = newModel
    acquiredPath = fp
    currentFilePath.value = fp
    cleanContent = model.getValue()
    modified.value = false
    tabStore.updateTab(props.tab.projectId, props.tab.id, { modified: false })
    persistTabState()
    if (isMarkdown.value && showPreview.value) {
      previewContent.value = cleanContent
    }
    try { useRecentStore().touchFile(fp, props.tab.projectId) } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('statusbar-editor', { detail: { active: true, language: detectLanguage(fp), encoding: detectedEncoding } }))
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
    const newModel = acquireModel(savePath, content, detectLanguage(savePath))
    if (newModel.getValue() !== content) newModel.setValue(content)
    editor.setModel(newModel)
    // Release the old scratch model (detached by setModel above) — refcounted,
    // so a shared model is only disposed when the last viewer releases it.
    if (model !== newModel && acquiredPath && acquiredPath !== savePath) releaseModel(acquiredPath)
    model = newModel
    acquiredPath = savePath
    currentFilePath.value = savePath
    cleanContent = model.getValue()
    modified.value = false
    tabStore.updateTab(props.tab.projectId, props.tab.id, { modified: false })
    persistTabState()
    return
  }

  const encoding = props.tab.encoding || fileMetaStore.get(fp)?.encoding
  await window.electronAPI.writeFile(fp, content, encoding)
  cleanContent = content
  modified.value = false
  tabStore.updateTab(props.tab.projectId, props.tab.id, { modified: false })
  window.dispatchEvent(new CustomEvent('mir-notification', {
    detail: { type: 'success', text: `Saved ${fp.split('/').pop()}` }
  }))
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

function togglePreview() {
  showPreview.value = !showPreview.value
  if (showPreview.value && model) {
    previewContent.value = model.getValue()
  }
  nextTick(() => editor?.layout())
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
  window.dispatchEvent(new CustomEvent('statusbar-editor', { detail: { active: true, language: detectLanguage(currentFilePath.value || '') } }))
})

onDeactivated(() => {
  window.dispatchEvent(new CustomEvent('statusbar-editor', { detail: { active: false } }))
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
  // Editor disposed above (model detached) — release our refcount; the model
  // is disposed only when the last viewer of the file goes away.
  if (acquiredPath) releaseModel(acquiredPath)
  acquiredPath = null
  if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
  window.removeEventListener('editor-toggle-wordwrap', onToggleWordWrapEvent)
  window.removeEventListener('statusbar-goto-line', onStatusBarGotoLine)
  window.removeEventListener('editor-set-language', onSetLanguage)
  window.removeEventListener('editor-set-encoding', onSetEncoding)
  window.removeEventListener('editor-set-line-ending', onSetLineEnding)
  window.removeEventListener('editor-save', onEditorSave)
  window.removeEventListener('editor-find', onEditorFind)
})

// Expose openFile so FileTreeRight can call it via template ref
defineExpose({ openFile })
</script>

<style scoped>
.editor-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
}
.editor-split {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.editor-split.show-preview .monaco-container {
  flex: 1;
  min-width: 0;
}
.monaco-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.md-preview-pane {
  flex: 1;
  min-width: 0;
  border-left: 1px solid var(--border-color);
  overflow: hidden;
}
.preview-toggle-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 10;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview-toggle-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
