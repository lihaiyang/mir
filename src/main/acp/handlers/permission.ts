/**
 * 权限请求：agent 发起 tool call 前的用户授权。
 *
 * - 配置为 allowAll 时自动选择第一个 allow 选项
 * - 否则登记 pending，把请求推给渲染进程，等用户点击
 * - 60s 无响应、会话关闭、Agent 断开时都必须 resolve，否则 agent 会一直挂着
 */
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { getAcpConfig } from '../config'
import { emitAcpEvent } from '../events'
import type { AcpPermissionRequest } from '../../../shared/acp'

const PERMISSION_TIMEOUT_MS = 60_000

interface PendingPermission {
  request: AcpPermissionRequest
  settle: (response: RequestPermissionResponse) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingPermission>()
let requestSeq = 0

function pickAllowOption(options: PermissionOption[]): PermissionOption | undefined {
  return (
    options.find((option) => option.kind === 'allow_once') ??
    options.find((option) => option.kind === 'allow_always')
  )
}

export function getPendingPermissions(): AcpPermissionRequest[] {
  return [...pending.values()].map((entry) => entry.request)
}

function resolvePending(
  requestId: string,
  response: RequestPermissionResponse,
  optionId: string | null
): boolean {
  const entry = pending.get(requestId)
  if (!entry) return false
  pending.delete(requestId)
  clearTimeout(entry.timer)
  entry.settle(response)
  emitAcpEvent({ type: 'permission-resolved', requestId, optionId })
  return true
}

/** 渲染进程回应某个权限请求；optionId 为 null 表示取消 */
export function respondPermission(requestId: string, optionId: string | null): boolean {
  if (optionId === null) {
    return resolvePending(requestId, { outcome: { outcome: 'cancelled' } }, null)
  }
  return resolvePending(requestId, { outcome: { outcome: 'selected', optionId } }, optionId)
}

export function cancelSessionPermissions(sessionId: string): void {
  for (const [requestId, entry] of [...pending.entries()]) {
    if (entry.request.sessionId === sessionId) {
      resolvePending(requestId, { outcome: { outcome: 'cancelled' } }, null)
    }
  }
}

export function cancelAgentPermissions(agentId: string): void {
  for (const [requestId, entry] of [...pending.entries()]) {
    if (entry.request.agentId === agentId) {
      resolvePending(requestId, { outcome: { outcome: 'cancelled' } }, null)
    }
  }
}

export function cancelAllPermissions(): void {
  for (const requestId of [...pending.keys()]) {
    resolvePending(requestId, { outcome: { outcome: 'cancelled' } }, null)
  }
}

export async function requestPermission(
  params: RequestPermissionRequest,
  agentId: string
): Promise<RequestPermissionResponse> {
  const config = getAcpConfig()
  if (config.autoApprovePermissions === 'allowAll') {
    const option = pickAllowOption(params.options)
    if (option) {
      return { outcome: { outcome: 'selected', optionId: option.optionId } }
    }
  }

  requestSeq += 1
  const requestId = `perm_${requestSeq}`
  const request: AcpPermissionRequest = {
    requestId,
    sessionId: params.sessionId,
    agentId,
    toolCall: params.toolCall,
    options: params.options,
    createdAt: Date.now()
  }

  return new Promise<RequestPermissionResponse>((resolve) => {
    const timer = setTimeout(() => {
      resolvePending(requestId, { outcome: { outcome: 'cancelled' } }, null)
    }, PERMISSION_TIMEOUT_MS)
    timer.unref?.()

    pending.set(requestId, { request, settle: resolve, timer })
    emitAcpEvent({ type: 'permission-request', request })
  })
}
