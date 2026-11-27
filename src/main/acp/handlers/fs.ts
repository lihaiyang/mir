/**
 * 客户端侧 fs 方法：Agent 通过这些请求读写工作区文件。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse
} from '@agentclientprotocol/sdk'
import { getAcpConfig } from '../config'
import { emitAcpEvent } from '../events'

const sessionCwds = new Map<string, string>()

export function registerSessionCwd(sessionId: string, cwd: string): void {
  if (sessionId && cwd) sessionCwds.set(sessionId, resolve(cwd))
}

export function unregisterSessionCwd(sessionId: string): void {
  sessionCwds.delete(sessionId)
}

function isInsideDir(baseDir: string, targetPath: string): boolean {
  const rel = relative(resolve(baseDir), resolve(targetPath))
  if (!rel) return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export async function readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  const content = await readFile(params.path, 'utf8')

  const line = typeof params.line === 'number' && params.line > 0 ? params.line : undefined
  const limit = typeof params.limit === 'number' && params.limit >= 0 ? params.limit : undefined
  if (line === undefined && limit === undefined) return { content }

  const lines = content.split('\n')
  const start = line === undefined ? 0 : line - 1
  const end = limit === undefined ? lines.length : start + limit
  return { content: lines.slice(start, end).join('\n') }
}

export async function writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
  const cwd = params.sessionId ? sessionCwds.get(params.sessionId) : undefined
  if (cwd && !isInsideDir(cwd, params.path)) {
    if (getAcpConfig().restrictFsToWorkspace) {
      throw new Error(`安全限制：禁止写入工作区外的文件 (${params.path})`)
    }
    emitAcpEvent({
      type: 'notice',
      level: 'warn',
      sessionId: params.sessionId,
      message: `Agent 正在写入工作区外的文件：${params.path}`
    })
  }
  const parent = dirname(params.path)
  if (parent && parent !== '.') {
    await mkdir(parent, { recursive: true })
  }
  await writeFile(params.path, params.content, 'utf8')
  emitAcpEvent({ type: 'file-written', sessionId: params.sessionId, path: params.path })
  return {}
}
