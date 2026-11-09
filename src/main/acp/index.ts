/**
 * ACP 主进程入口：IPC 注册 + 事件广播 + 退出时清理。
 *
 * 由 src/main/ipc.ts 在 setupIpcHandlers() 末尾调用 registerAcpIpc()，
 * 由 src/main/index.ts 在 app.on('before-quit') 调用 shutdownAcp()。
 */
import { BrowserWindow, ipcMain } from 'electron'
import type {
  AcpAgentRuntimeInfo,
  AcpAuthMethod,
  AcpConfig,
  AcpEvent,
  AcpHistoryEntry,
  AcpPermissionRequest,
  AcpPromptBlock,
  AcpRegistryAgent,
  AcpRemoteSession,
  AcpSessionDetail,
  AcpStateSnapshot,
  AcpTrafficEntry,
  SessionConfigOption
} from '../../shared/acp'
import { getAcpConfig, setAcpConfig } from './config'
import { getTraffic } from './connection'
import { setAcpEventSink } from './events'
import { getPendingPermissions, respondPermission as settlePermission } from './handlers/permission'
import { getRegistry } from './registry'
import {
  authenticate,
  cancelPrompt,
  closeSession,
  createSession,
  disconnectAgent,
  forgetSession,
  getAgents,
  getHistory,
  getState,
  listSessions,
  loadSession,
  resumeSession,
  sendPrompt,
  setConfigOption,
  setMode,
  setModel,
  shutdownAcpState
} from './sessionManager'

let registered = false

/** 把事件推给所有窗口；窗口销毁 / 关闭中直接跳过 */
function broadcast(event: AcpEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents
    if (contents.isDestroyed()) continue
    contents.send('acp:event', event)
  }
}

function requireAgentId(params: { agentId?: string } | undefined): string {
  const agentId = params?.agentId
  if (!agentId) throw new Error('缺少 agentId')
  return agentId
}

function requireSessionId(params: { sessionId?: string } | undefined): string {
  const sessionId = params?.sessionId
  if (!sessionId) throw new Error('缺少 sessionId')
  return sessionId
}

export function registerAcpIpc(): void {
  if (registered) return
  registered = true

  setAcpEventSink(broadcast)

  /* ---------------------------- 配置 / 状态 ---------------------------- */

  ipcMain.handle('acp:get-config', (): AcpConfig => getAcpConfig())
  ipcMain.handle('acp:set-config', (_event, patch: Partial<AcpConfig>): AcpConfig =>
    setAcpConfig(patch ?? {})
  )
  ipcMain.handle('acp:get-state', (): AcpStateSnapshot => getState())
  ipcMain.handle('acp:get-agents', (): AcpAgentRuntimeInfo[] => getAgents())
  ipcMain.handle('acp:get-registry', (): Promise<AcpRegistryAgent[]> => getRegistry())

  /* ---------------------------- 会话生命周期 ---------------------------- */

  ipcMain.handle(
    'acp:create-session',
    (_event, params: { agentId?: string, cwd?: string } | undefined): Promise<AcpSessionDetail> =>
      createSession(requireAgentId(params), params?.cwd)
  )

  ipcMain.handle(
    'acp:load-session',
    (
      _event,
      params: { agentId?: string, sessionId?: string, cwd?: string } | undefined
    ): Promise<AcpSessionDetail> =>
      loadSession(requireAgentId(params), requireSessionId(params), params?.cwd)
  )

  ipcMain.handle(
    'acp:resume-session',
    (
      _event,
      params: { agentId?: string, sessionId?: string, cwd?: string } | undefined
    ): Promise<AcpSessionDetail> =>
      resumeSession(requireAgentId(params), requireSessionId(params), params?.cwd)
  )

  ipcMain.handle('acp:close-session', (_event, sessionId: string): Promise<void> =>
    closeSession(sessionId)
  )

  ipcMain.handle('acp:disconnect-agent', (_event, agentId: string): Promise<void> =>
    disconnectAgent(agentId)
  )

  /* ------------------------------ 提示词 ------------------------------ */

  ipcMain.handle(
    'acp:send-prompt',
    (
      _event,
      params: { sessionId?: string, blocks?: AcpPromptBlock[] } | undefined
    ): Promise<{ stopReason: string }> =>
      sendPrompt(requireSessionId(params), params?.blocks ?? [])
  )

  ipcMain.handle('acp:cancel-prompt', (_event, sessionId: string): Promise<void> =>
    cancelPrompt(sessionId)
  )

  /* ---------------------------- 会话配置项 ---------------------------- */

  ipcMain.handle(
    'acp:set-config-option',
    (
      _event,
      params: { sessionId?: string, configId?: string, value?: string | boolean } | undefined
    ): Promise<SessionConfigOption[]> => {
      const sessionId = requireSessionId(params)
      const configId = params?.configId
      if (!configId) throw new Error('缺少 configId')
      const value = params?.value
      if (typeof value !== 'string' && typeof value !== 'boolean') throw new Error('缺少 value')
      return setConfigOption(sessionId, configId, value)
    }
  )

  ipcMain.handle(
    'acp:set-mode',
    (_event, params: { sessionId?: string, modeId?: string } | undefined): Promise<void> => {
      const sessionId = requireSessionId(params)
      const modeId = params?.modeId
      if (!modeId) throw new Error('缺少 modeId')
      return setMode(sessionId, modeId)
    }
  )

  ipcMain.handle(
    'acp:set-model',
    (_event, params: { sessionId?: string, modelId?: string } | undefined): Promise<void> => {
      const sessionId = requireSessionId(params)
      const modelId = params?.modelId
      if (!modelId) throw new Error('缺少 modelId')
      return setModel(sessionId, modelId)
    }
  )

  /* ---------------------------- 列表 / 历史 ---------------------------- */

  ipcMain.handle(
    'acp:list-sessions',
    (
      _event,
      params: { agentId?: string, cwd?: string } | undefined
    ): Promise<AcpRemoteSession[]> => listSessions(requireAgentId(params), params?.cwd)
  )

  ipcMain.handle('acp:list-history', (): AcpHistoryEntry[] => getHistory())

  ipcMain.handle(
    'acp:forget-session',
    (_event, params: { agentId?: string, sessionId?: string } | undefined): Promise<void> =>
      forgetSession(requireAgentId(params), requireSessionId(params))
  )

  /* ------------------------------ 认证 ------------------------------- */

  ipcMain.handle(
    'acp:authenticate',
    (
      _event,
      params: { agentId?: string, methodId?: string } | undefined
    ): Promise<AcpAuthMethod[]> => {
      const agentId = requireAgentId(params)
      const methodId = params?.methodId
      if (!methodId) throw new Error('缺少 methodId')
      return authenticate(agentId, methodId)
    }
  )

  /* ---------------------------- 权限 / 诊断 ---------------------------- */

  ipcMain.handle(
    'acp:respond-permission',
    (_event, params: { requestId?: string, optionId?: string | null } | undefined): void => {
      const requestId = params?.requestId
      if (!requestId) throw new Error('缺少 requestId')
      settlePermission(requestId, params?.optionId ?? null)
    }
  )

  ipcMain.handle('acp:get-permissions', (): AcpPermissionRequest[] => getPendingPermissions())

  ipcMain.handle('acp:get-traffic', (): AcpTrafficEntry[] => getTraffic())
}

export function shutdownAcp(): void {
  // 先摘掉事件出口：退出过程中渲染进程可能已经在销毁，避免 send 到已销毁窗口
  setAcpEventSink(null)
  shutdownAcpState()
}
