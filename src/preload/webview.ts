/**
 * 内嵌浏览器（<webview>）的 preload。
 *
 * 两件事：
 *  1. 修补 navigator.serviceWorker.register 在 Electron webview 里的
 *     "document is in an invalid state" 竞态（原有逻辑）。
 *  2. 用户脚本（油猴脚本）引擎：preload 在页面任何脚本之前运行，
 *     用同步 IPC 向主进程要「这个 URL 该注入哪些脚本」，然后通过
 *     webFrame.executeJavaScript 把脚本注入页面主世界。
 *
 * GM_* API 需要跨 world 调用：preload 用 contextBridge 把 __mirUserscriptBridge
 * 暴露到主世界，脚本里的 GM_* 只是桥的薄封装；键值走同步快照 + 异步落盘，
 * GM_xmlhttpRequest 走主进程代理（与内嵌浏览器共享 Cookie）。
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron'
import {
  USERSCRIPT_CHANNELS,
  USERSCRIPT_HOST_CHANNEL,
  type GmXhrRequest,
  type UserScriptInjection,
  type UserScriptMenuCommand,
  type UserScriptsForUrlPayload
} from '../shared/userscripts'

/* --------------------------------------------------- service worker 竞态修补 */

// Patch navigator.serviceWorker.register in the page's main world to handle
// Electron webview's transient "document is in an invalid state" race.
// Injected via webFrame so it runs in the page's main world even with
// contextIsolation enabled, and executes before any page script.
const patchCode = `(function () {
  if (window.__mirSwPatched) return
  window.__mirSwPatched = true
  if (!('serviceWorker' in navigator)) return

  var sw = navigator.serviceWorker
  var origRegister = sw.register.bind(sw)

  function isInvalidState(err) {
    if (!err) return false
    if (err.name === 'InvalidStateError') return true
    var m = err.message || ''
    return m.toLowerCase().indexOf('invalid state') !== -1
  }

  function waitForActive() {
    return new Promise(function (resolve) {
      function settle() { requestAnimationFrame(function () { resolve() }) }
      if (document.readyState === 'complete') return settle()
      window.addEventListener('load', settle, { once: true })
    })
  }

  sw.register = function (url, opts) {
    var attempt = 0
    var delays = [100, 300, 800, 1500]
    function tryOnce() {
      return origRegister(url, opts).catch(function (err) {
        if (!isInvalidState(err) || attempt >= delays.length) throw err
        var delay = delays[attempt++]
        return waitForActive()
          .then(function () { return new Promise(function (r) { setTimeout(r, delay) }) })
          .then(tryOnce)
      })
    }
    return tryOnce()
  }
})()`

webFrame.executeJavaScript(patchCode).catch(() => {})

/* ------------------------------------------------------------ 用户脚本引擎 */

/** 每份脚本的 GM 值本地镜像：脚本是同步 API，只能靠快照 + 回写 */
const valuesByScript: Record<string, Record<string, unknown>> = {}

/** 当前页面已注册的脚本菜单项，随脚本注册/注销整体刷新给宿主 */
const menuCommands: UserScriptMenuCommand[] = []

/** preload 运行在页面上下文，但 tsconfig 用 node lib 检查，这里取最小形状避免引入 DOM 类型 */
function currentHref(): string {
  const loc = (globalThis as { location?: { href?: string } }).location
  return typeof loc?.href === 'string' ? loc.href : ''
}

function readPayload(): UserScriptsForUrlPayload | null {
  try {
    const payload = ipcRenderer.sendSync(USERSCRIPT_CHANNELS.forUrl, currentHref()) as UserScriptsForUrlPayload
    if (!payload || !Array.isArray(payload.scripts)) return null
    return payload
  } catch (err) {
    console.error('[userscripts] 读取注入列表失败', err)
    return null
  }
}

function exposeBridge(): void {
  contextBridge.exposeInMainWorld('__mirUserscriptBridge', {
    getValue: (scriptId: string, key: string, fallback: unknown) => {
      const bucket = valuesByScript[scriptId]
      if (bucket && Object.prototype.hasOwnProperty.call(bucket, key)) return bucket[key]
      return fallback
    },
    setValue: (scriptId: string, key: string, value: unknown) => {
      const bucket = (valuesByScript[scriptId] ||= {})
      bucket[key] = value
      try {
        ipcRenderer.send(USERSCRIPT_CHANNELS.gmSet, { scriptId, key, value })
      } catch {
        /* 主进程不可用时静默 */
      }
    },
    deleteValue: (scriptId: string, key: string) => {
      const bucket = valuesByScript[scriptId]
      if (bucket) delete bucket[key]
      try {
        ipcRenderer.send(USERSCRIPT_CHANNELS.gmDelete, { scriptId, key })
      } catch {
        /* ignore */
      }
    },
    listValues: (scriptId: string) => Object.keys(valuesByScript[scriptId] ?? {}),
    xhr: (scriptId: string, request: GmXhrRequest) => {
      void scriptId
      return ipcRenderer.invoke(USERSCRIPT_CHANNELS.xhr, request)
    },
    registerMenu: (scriptId: string, scriptName: string, commands: { id: string | number; title: string }[]) => {
      for (let i = menuCommands.length - 1; i >= 0; i -= 1) {
        if (menuCommands[i].scriptId === scriptId) menuCommands.splice(i, 1)
      }
      for (const cmd of commands) {
        menuCommands.push({ id: cmd.id, title: cmd.title, scriptId, scriptName })
      }
      try {
        ipcRenderer.sendToHost(USERSCRIPT_HOST_CHANNEL, {
          type: 'menu',
          commands: menuCommands.slice()
        })
      } catch {
        /* 宿主已关闭 */
      }
    },
    openInTab: (url: string, active: boolean) => {
      try {
        ipcRenderer.send(USERSCRIPT_CHANNELS.openInTab, { url, active })
      } catch {
        /* ignore */
      }
    },
    notify: (title: string, text: string) => {
      try {
        ipcRenderer.send(USERSCRIPT_CHANNELS.notify, { title, text })
      } catch {
        /* ignore */
      }
    },
    log: (scriptId: string, message: string) => {
      console.log(`[userscript:${scriptId}]`, message)
    }
  })
}

/** GM_xmlhttpRequest 的返回值解析（responseType=json / arraybuffer 需要额外处理） */
function buildWrapper(script: UserScriptInjection): string {
  const metaJson = JSON.stringify(script.info)
  const grantsJson = JSON.stringify(script.grants)
  const resourcesJson = JSON.stringify(script.resources)
  const idJson = JSON.stringify(script.id)
  const runAtJson = JSON.stringify(script.runAt)

  const head = `(function () {
  var __bridge = window.__mirUserscriptBridge
  if (!__bridge) return
  var __id = ${idJson}
  var __info = ${metaJson}
  var __resources = ${resourcesJson}
  var __grants = ${grantsJson}
  // 没有声明 @grant 时按「全部开放」处理：轻量运行器宁可多给能力，
  // 也不要让常见的 <code>@grant none</code> 脚本静默失效。
  var __allow = function (name) {
    if (__grants.length === 0) return true
    return __grants.indexOf(name) !== -1 || __grants.indexOf('*') !== -1
  }
  var __menuItems = []
  var __menuSeq = 0
  var __menuRegistry = window.__mirUserScriptMenu || (window.__mirUserScriptMenu = {})
  var __syncMenu = function () {
    var list = []
    for (var i = 0; i < __menuItems.length; i += 1) list.push({ id: __menuItems[i].id, title: __menuItems[i].title })
    try { __bridge.registerMenu(__id, __info.script.name, list) } catch (err) {}
  }
  var __toDataUrl = function (text) {
    return 'data:text/plain;charset=utf-8,' + encodeURIComponent(text)
  }
  var __b64ToBuffer = function (b64) {
    var bin = atob(b64)
    var bytes = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
    return bytes.buffer
  }
  var __copy = function (text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return }
    } catch (err) {}
    var ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch (err) {}
    ta.remove()
  }
  var unsafeWindow = window
  var GM_info = __info
  if (__allow('GM_getValue')) var GM_getValue = function (key, fallback) { return __bridge.getValue(__id, String(key), fallback) }
  if (__allow('GM_setValue')) var GM_setValue = function (key, value) { __bridge.setValue(__id, String(key), value) }
  if (__allow('GM_deleteValue')) var GM_deleteValue = function (key) { __bridge.deleteValue(__id, String(key)) }
  if (__allow('GM_listValues')) var GM_listValues = function () { return __bridge.listValues(__id) }
  var __valueListeners = {}
  var __valueListenerSeq = 0
  if (__allow('GM_addValueChangeListener')) var GM_addValueChangeListener = function (key, fn) {
    var lid = 'vl' + (++__valueListenerSeq)
    __valueListeners[lid] = { key: String(key), fn: fn }
    return lid
  }
  if (__allow('GM_removeValueChangeListener')) var GM_removeValueChangeListener = function (lid) { delete __valueListeners[lid] }
  if (__allow('GM_addStyle')) var GM_addStyle = function (css) {
    var el = document.createElement('style')
    el.textContent = css
    ;(document.head || document.documentElement).appendChild(el)
    return el
  }
  if (__allow('GM_addElement')) var GM_addElement = function (tag, attrs) {
    var el = document.createElement(tag)
    if (attrs && typeof attrs === 'object') {
      for (var k in attrs) {
        if (k === 'textContent') el.textContent = attrs[k]
        else if (k === 'style' && typeof attrs[k] === 'object') { for (var sk in attrs[k]) el.style[sk] = attrs[k][sk] }
        else el.setAttribute(k, attrs[k])
      }
    }
    ;(document.head || document.documentElement).appendChild(el)
    return el
  }
  if (__allow('GM_xmlhttpRequest')) var GM_xmlhttpRequest = function (details) {
    var aborted = false
    var request = {
      method: details && details.method,
      url: details && details.url,
      headers: details && details.headers,
      data: details && details.data,
      timeout: details && details.timeout,
      responseType: details && details.responseType === 'arraybuffer' ? 'arraybuffer' : 'text',
      anonymous: Boolean(details && details.anonymous)
    }
    __bridge.xhr(__id, request).then(function (res) {
      if (aborted) return
      var response = {
        readyState: 4,
        status: res.status,
        statusText: res.statusText,
        responseHeaders: res.responseHeaders,
        finalUrl: res.finalUrl,
        responseText: res.responseText
      }
      if (details && details.responseType === 'json') {
        try { response.response = JSON.parse(res.responseText) } catch (err) { response.response = null }
      } else if (details && details.responseType === 'arraybuffer') {
        try { response.response = __b64ToBuffer(res.responseText) } catch (err) { response.response = null }
      } else {
        response.response = res.responseText
      }
      if (res.error) response.error = res.error
      if (res.error) { if (details && details.onerror) details.onerror(response) }
      else if (details && details.onload) details.onload(response)
      if (details && details.onloadend) details.onloadend(response)
    }, function (err) {
      if (aborted) return
      var response = { readyState: 4, status: 0, statusText: '', responseText: '', response: null, error: String(err) }
      if (details && details.onerror) details.onerror(response)
      if (details && details.onloadend) details.onloadend(response)
    })
    return { abort: function () { aborted = true } }
  }
  if (__allow('GM_registerMenuCommand')) var GM_registerMenuCommand = function (title, fn, options) {
    var id = options && options.id != null ? options.id : 'mir-menu-' + (++__menuSeq)
    __menuItems.push({ id: id, title: String(title) })
    __menuRegistry[__id + '::' + id] = fn
    __syncMenu()
    return id
  }
  if (__allow('GM_unregisterMenuCommand')) var GM_unregisterMenuCommand = function (id) {
    for (var i = __menuItems.length - 1; i >= 0; i -= 1) if (__menuItems[i].id === id) __menuItems.splice(i, 1)
    delete __menuRegistry[__id + '::' + id]
    __syncMenu()
  }
  if (__allow('GM_getResourceText')) var GM_getResourceText = function (name) {
    var text = __resources[String(name)]
    return typeof text === 'string' ? text : null
  }
  if (__allow('GM_getResourceURL')) var GM_getResourceURL = function (name) {
    var text = __resources[String(name)]
    return typeof text === 'string' ? __toDataUrl(text) : null
  }
  if (__allow('GM_notification')) var GM_notification = function (details) {
    var title = typeof details === 'string' ? details : (details && details.title) || '用户脚本'
    var text = typeof details === 'string' ? '' : (details && details.text) || ''
    __bridge.notify(String(title), String(text))
  }
  if (__allow('GM_openInTab')) var GM_openInTab = function (url, options) {
    __bridge.openInTab(String(url), Boolean(options && options.active))
  }
  if (__allow('GM_setClipboard')) var GM_setClipboard = function (text) { __copy(String(text)) }
  var GM_log = function (message) { __bridge.log(__id, String(message)) }

  function __mirRunScript() {
    try {
`

  const tail = `
    } catch (err) {
      console.error('[userscript] ' + __info.script.name + ' 执行失败', err)
    }
  }
  var __mirRunAt = ${runAtJson}
  if (__mirRunAt === 'document-start') {
    __mirRunScript()
  } else if (__mirRunAt === 'document-end') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __mirRunScript, { once: true })
    else __mirRunScript()
  } else {
    if (document.readyState === 'complete') setTimeout(__mirRunScript, 0)
    else window.addEventListener('load', function () { setTimeout(__mirRunScript, 0) }, { once: true })
  }
})()`

  const requires = script.requireCode.length > 0 ? `${script.requireCode}\n;\n` : ''
  return head + requires + script.code + tail
}

function injectScript(script: UserScriptInjection): void {
  try {
    webFrame.executeJavaScript(buildWrapper(script)).catch((err: unknown) => {
      console.error(`[userscript] ${script.name} 注入失败`, err)
    })
  } catch (err) {
    console.error(`[userscript] ${script.name} 注入异常`, err)
  }
}

function installUserscripts(): void {
  const payload = readPayload()
  if (!payload || payload.scripts.length === 0) {
    // 即使没有脚本也要暴露桥：页面里可能残留上一次注入的菜单回调
    return
  }
  for (const scriptId of Object.keys(payload.values)) {
    valuesByScript[scriptId] = { ...payload.values[scriptId] }
  }
  exposeBridge()
  for (const script of payload.scripts) injectScript(script)
}

installUserscripts()
