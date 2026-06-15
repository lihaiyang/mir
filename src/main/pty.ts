import * as pty from 'node-pty'
import * as fs from 'fs'
import { BrowserWindow } from 'electron'

const sessions: Map<string, pty.IPty> = new Map()

function resolveShell(shellPath?: string): string {
  if (shellPath && shellPath.trim()) {
    try {
      if (fs.existsSync(shellPath) && fs.statSync(shellPath).isFile()) return shellPath
    } catch {}
  }
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

export function createPtyProcess(id: string, cwd: string, shellPath?: string): void {
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

  sessions.set(id, proc)

  proc.onData((data: string) => {
    const wins = BrowserWindow.getAllWindows()
    wins.forEach(w => w.webContents.send(`pty:data:${id}`, data))
  })

  proc.onExit(({ exitCode }) => {
    sessions.delete(id)
    const wins = BrowserWindow.getAllWindows()
    wins.forEach(w => w.webContents.send(`pty:exit:${id}`, exitCode))
  })
}

export function writePtyProcess(id: string, data: string): void {
  sessions.get(id)?.write(data)
}

export function resizePtyProcess(id: string, cols: number, rows: number): void {
  sessions.get(id)?.resize(cols, rows)
}

export function closePtyProcess(id: string): void {
  sessions.get(id)?.kill()
  sessions.delete(id)
}
