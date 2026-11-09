/**
 * ACP 事件出口。
 *
 * sessionManager / handlers 不直接依赖 Electron，避免与 index.ts 形成循环依赖：
 * index.ts 启动时注入广播函数，主进程以外的地方统一调用 emitAcpEvent。
 */
import type { AcpEvent } from '../../shared/acp'

type AcpEventSink = (event: AcpEvent) => void

let sink: AcpEventSink | null = null

export function setAcpEventSink(next: AcpEventSink | null): void {
  sink = next
}

export function emitAcpEvent(event: AcpEvent): void {
  if (!sink) return
  try {
    sink(event)
  } catch {
    // 渲染进程已销毁或窗口正在关闭，事件丢弃即可
  }
}
