import { createApp } from 'vue'
import { createPinia } from 'pinia'
import * as Vue from 'vue'
import * as Pinia from 'pinia'
import * as VueI18n from 'vue-i18n'
import App from './App.vue'
import i18n from './i18n'
import { registerBuiltin } from './plugins/builtin'
import './assets/main.css'

// Expose shared instances for plugins — plugins import 'vue' etc. via import map
// which resolves to mir-plugin://__shared/*.js modules that re-export from here.
// This ensures plugins use the SAME Vue/Pinia instances as MIR (component registry,
// reactive system, pinia stores all share state).
;(globalThis as any).__MIR_SHARED__ = { vue: Vue, pinia: Pinia, 'vue-i18n': VueI18n }

// Send the full export key lists to the main process so the mir-plugin:// protocol
// handler can generate accurate ESM re-export shims. The main process can't access
// these modules directly (they live in the renderer), so we must provide the keys.
// This must happen synchronously before any plugin import() to avoid races.
const _shared = (globalThis as any).__MIR_SHARED__
;(window as any).electronAPI?.pluginSetSharedKeys('vue', Object.keys(_shared.vue))
;(window as any).electronAPI?.pluginSetSharedKeys('pinia', Object.keys(_shared.pinia))
;(window as any).electronAPI?.pluginSetSharedKeys('vue-i18n', Object.keys(_shared['vue-i18n']))

// Configure Monaco workers
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    return new editorWorker()
  }
}

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
registerBuiltin()
app.mount('#app')
