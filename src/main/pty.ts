import * as pty from 'node-pty'
import * as fs from 'fs'
import type { WebContents } from 'electron'

interface PtySession {
  proc: pty.IPty
  owner: WebContents | null
  onOwnerDestroyed: (() => void) | null
}

const sessions: Map<string, PtySession> = new Map()

function resolveShell(shellPath?: string): string {
  if (shellPath && shellPath.trim()) {
    try {
      if (fs.existsSync(shellPath) && fs.statSync(shellPath).isFile()) return shellPath
    } catch {}
  }
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

// Broadcast to the owning webContents only (guarded), so a destroyed window
// neither throws "Object has been destroyed" nor keeps the closure meaningful.
function safeSend(wc: WebContents | null, channel: string, payload: unknown): void {
  if (wc && !wc.isDestroyed()) {
    wc.send(channel, payload)
  }
}

export function createPtyProcess(id: string, cwd: string, shellPath?: string, sender?: WebContents): void {
  // Same tab id re-created (e.g. restart) — make sure the old process dies.
  closePtyProcess(id)

  const shell = resolveShell(shellPath)
  const env = { ...process.env } as { [key: string]: string }
  // Force UTF-8 so zsh correctly calculates CJK character widths (2 cols each).
  // LC_ALL overrides per-category LC_* and LANG — profile files can't clobber it.
  env.LC_ALL = 'en_US.UTF-8'
  env.LANG = 'en_US.UTF-8'
  env.LC_CTYPE = 'en_US.UTF-8'

  const proc = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env
  })

  // The renderer that asked for this PTY owns it. If that renderer dies
  // (crash / window closed) it can no longer send pty:close — kill the shell
  // ourselves so neither the child process nor the session leaks.
  const owner = sender && !sender.isDestroyed() ? sender : null
  let onOwnerDestroyed: (() => void) | null = null
  if (owner) {
    onOwnerDestroyed = () => closePtyProcess(id)
    owner.once('destroyed', onOwnerDestroyed)
  }

  sessions.set(id, { proc, owner, onOwnerDestroyed })

  proc.onData((data: string) => {
    safeSend(owner, `pty:data:${id}`, data)
  })

  proc.onExit(({ exitCode }) => {
    const s = sessions.get(id)
    if (s) {
      if (s.onOwnerDestroyed && s.owner) {
        s.owner.removeListener('destroyed', s.onOwnerDestroyed)
      }
      sessions.delete(id)
    }
    // A destroyed owner may still be ref-counted by Electron briefly; send to
    // it only if alive, otherwise nothing (no other window expects this channel).
    const wc = s?.owner ?? owner
    if (wc && !wc.isDestroyed()) {
      wc.send(`pty:exit:${id}`, exitCode)
    }
  })
}

export function writePtyProcess(id: string, data: string): void {
  sessions.get(id)?.proc.write(data)
}

export function resizePtyProcess(id: string, cols: number, rows: number): void {
  sessions.get(id)?.proc.resize(cols, rows)
}

export function closePtyProcess(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  if (s.onOwnerDestroyed && s.owner) {
    try { s.owner.removeListener('destroyed', s.onOwnerDestroyed) } catch {}
  }
  try { s.proc.kill() } catch {}
  sessions.delete(id)
}

// Last-resort sweep: kill every shell on app quit so no zsh orphans survive
// the main process.
export function killAllPtyProcesses(): void {
  for (const id of Array.from(sessions.keys())) {
    closePtyProcess(id)
  }
}
