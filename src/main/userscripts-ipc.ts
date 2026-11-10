/**
 * 用户脚本的 IPC 注册。单独成文件，避免 ipc.ts 继续膨胀；
 * 由 setupIpcHandlers() 在 app ready 后调用一次。
 */

import { ipcMain } from 'electron'
import { USERSCRIPT_CHANNELS } from '../shared/userscripts'
import {
  getUserScriptDetail,
  gmDeleteValue,
  gmSetValue,
  gmXhr,
  installUserScript,
  installUserScriptsFromFiles,
  listUserScripts,
  openUrlInBrowserTab,
  openUserScriptsDir,
  refreshUserScriptCache,
  removeUserScript,
  rescanUserScripts,
  saveUserScript,
  setUserScriptEnabled,
  showUserScriptNotification,
  userScriptsForUrl
} from './userscripts'
import type { GmXhrRequest, UserScriptSummary } from '../shared/userscripts'

let registered = false

export function registerUserscriptIpc(): void {
  if (registered) return
  registered = true

  ipcMain.handle(USERSCRIPT_CHANNELS.list, (): UserScriptSummary[] => listUserScripts())

  ipcMain.handle(USERSCRIPT_CHANNELS.detail, (_e, id: string) => getUserScriptDetail(id))

  ipcMain.handle(USERSCRIPT_CHANNELS.install, (_e, payload: { source: string }) =>
    installUserScript(payload?.source ?? '')
  )

  ipcMain.handle(USERSCRIPT_CHANNELS.installFromFile, () => installUserScriptsFromFiles())

  ipcMain.handle(USERSCRIPT_CHANNELS.save, (_e, payload: { id: string; source: string }) =>
    saveUserScript(payload?.id ?? '', payload?.source ?? '')
  )

  ipcMain.handle(USERSCRIPT_CHANNELS.remove, (_e, id: string) => {
    removeUserScript(id)
  })

  ipcMain.handle(USERSCRIPT_CHANNELS.setEnabled, (_e, payload: { id: string; enabled: boolean }) =>
    setUserScriptEnabled(payload?.id ?? '', Boolean(payload?.enabled))
  )

  ipcMain.handle(USERSCRIPT_CHANNELS.openDir, () => {
    openUserScriptsDir()
  })

  ipcMain.handle(USERSCRIPT_CHANNELS.rescan, (): UserScriptSummary[] => rescanUserScripts())

  ipcMain.handle(USERSCRIPT_CHANNELS.refreshCache, (_e, id: string) => refreshUserScriptCache(id))

  // 同步通道：webview preload 在页面脚本执行前用 sendSync 拿到该 URL 该注入的脚本。
  // 必须用 ipcMain.on + event.returnValue，sendSync 只认同步返回值。
  ipcMain.on(USERSCRIPT_CHANNELS.forUrl, (event, url: string) => {
    try {
      event.returnValue = userScriptsForUrl(typeof url === 'string' ? url : '')
    } catch (e) {
      console.error('[userscripts] for-url failed:', e)
      event.returnValue = { url, scripts: [], values: {} }
    }
  })

  ipcMain.on(USERSCRIPT_CHANNELS.gmSet, (_e, payload: { scriptId: string; key: string; value: unknown }) => {
    if (!payload?.scriptId || typeof payload.key !== 'string') return
    gmSetValue(payload.scriptId, payload.key, payload.value)
  })

  ipcMain.on(USERSCRIPT_CHANNELS.gmDelete, (_e, payload: { scriptId: string; key: string }) => {
    if (!payload?.scriptId || typeof payload.key !== 'string') return
    gmDeleteValue(payload.scriptId, payload.key)
  })

  ipcMain.handle(USERSCRIPT_CHANNELS.xhr, (_e, request: GmXhrRequest) => gmXhr(request))

  ipcMain.on(USERSCRIPT_CHANNELS.openInTab, (_e, payload: { url: string }) => {
    if (payload?.url) openUrlInBrowserTab(payload.url)
  })

  ipcMain.on(USERSCRIPT_CHANNELS.notify, (_e, payload: { title?: string; text?: string }) => {
    showUserScriptNotification(payload?.title ?? '用户脚本', payload?.text ?? '')
  })
}
