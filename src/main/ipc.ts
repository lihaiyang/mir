import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import Store from 'electron-store'
import { createPtyProcess, closePtyProcess, writePtyProcess, resizePtyProcess } from './pty'
import { runGitCommand } from './git'
import { searchInProject } from './search'
import { checkForUpdateNow, applyUpdate, setAutoUpdate } from './updater'

const execAsync = promisify(exec)

const store = new Store({ name: 'mir-state' })

export function setupIpcHandlers(): void {
  // --- Store ---
  ipcMain.handle('store:get', (_e, key: string) => store.get(key))
  ipcMain.handle('store:set', (_e, key: string, value: unknown) => {
    store.set(key, JSON.parse(JSON.stringify(value)))
  })
  ipcMain.handle('store:delete', (_e, key: string) => store.delete(key))

  // --- Dialog ---
  ipcMain.handle('dialog:openFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory']
    })
    return result.filePaths[0] ?? null
  })

  ipcMain.handle('dialog:openFolderAt', async (_e, defaultPath: string) => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
      defaultPath
    })
    return result.filePaths[0] ?? null
  })

  ipcMain.handle('dialog:showSaveDialog', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title: 'Save File',
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    return result.filePath ?? null
  })

  // --- File system ---
  ipcMain.handle('fs:readdir', async (_e, dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
      return entries.map(e => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile()
      }))
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    return content
  })

  ipcMain.handle('fs:writeFile', async (_e, filePath: string, content: string) => {
    await fs.promises.writeFile(filePath, content, 'utf-8')
  })

  ipcMain.handle('fs:exists', async (_e, p: string) => {
    return fs.existsSync(p)
  })

  ipcMain.handle('fs:mkdir', async (_e, dirPath: string) => {
    await fs.promises.mkdir(dirPath, { recursive: true })
  })

  ipcMain.handle('fs:rename', async (_e, oldPath: string, newPath: string) => {
    await fs.promises.rename(oldPath, newPath)
  })

  ipcMain.handle('fs:delete', async (_e, p: string) => {
    const stat = await fs.promises.stat(p)
    if (stat.isDirectory()) {
      await fs.promises.rm(p, { recursive: true })
    } else {
      await fs.promises.unlink(p)
    }
  })

  ipcMain.handle('fs:stat', async (_e, p: string) => {
    try {
      const s = await fs.promises.stat(p)
      return { mtime: s.mtimeMs, size: s.size, isDirectory: s.isDirectory() }
    } catch {
      return null
    }
  })

  ipcMain.handle('shell:openPath', async (_e, p: string) => {
    await shell.openPath(p)
  })

  ipcMain.handle('shell:showItemInFolder', (_e, p: string) => {
    shell.showItemInFolder(p)
  })

  // --- PTY / Terminal ---
  ipcMain.handle('pty:create', async (_e, id: string, cwd: string, shell?: string) => {
    return createPtyProcess(id, cwd, shell)
  })

  ipcMain.on('pty:write', (_e, id: string, data: string) => {
    writePtyProcess(id, data)
  })

  ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) => {
    resizePtyProcess(id, cols, rows)
  })

  ipcMain.handle('pty:close', (_e, id: string) => {
    closePtyProcess(id)
  })

  // --- Git ---
  ipcMain.handle('git:status', (_e, cwd: string) => runGitCommand(cwd, 'status'))
  ipcMain.handle('git:log', (_e, cwd: string) => runGitCommand(cwd, 'log'))
  ipcMain.handle('git:diff', (_e, cwd: string, file?: string) => runGitCommand(cwd, 'diff', file))
  ipcMain.handle('git:diffStaged', (_e, cwd: string, file?: string) => runGitCommand(cwd, 'diffStaged', file))
  ipcMain.handle('git:stage', (_e, cwd: string, file: string) => runGitCommand(cwd, 'stage', file))
  ipcMain.handle('git:unstage', (_e, cwd: string, file: string) => runGitCommand(cwd, 'unstage', file))
  ipcMain.handle('git:commit', (_e, cwd: string, message: string) => runGitCommand(cwd, 'commit', message))
  ipcMain.handle('git:pull', (_e, cwd: string) => runGitCommand(cwd, 'pull'))
  ipcMain.handle('git:push', (_e, cwd: string) => runGitCommand(cwd, 'push'))
  ipcMain.handle('git:fetch', (_e, cwd: string) => runGitCommand(cwd, 'fetch'))
  ipcMain.handle('git:branches', (_e, cwd: string) => runGitCommand(cwd, 'branches'))
  ipcMain.handle('git:checkout', (_e, cwd: string, branch: string) => runGitCommand(cwd, 'checkout', branch))
  ipcMain.handle('git:createBranch', (_e, cwd: string, name: string) => runGitCommand(cwd, 'createBranch', name))
  ipcMain.handle('git:stageAll', (_e, cwd: string) => runGitCommand(cwd, 'stageAll'))
  ipcMain.handle('git:showFile', (_e, cwd: string, ref: string, file: string) => runGitCommand(cwd, 'showFile', `${ref}:${file}`))

  // --- Search ---
  ipcMain.handle('search:run', async (_e, opts) => {
    return searchInProject(opts)
  })

  // --- App ---
  ipcMain.handle('app:getVersion', () => app.getVersion())
  ipcMain.handle('app:getPath', (_e, name: 'home' | 'appData' | 'userData' | 'sessionData' | 'temp' | 'exe' | 'module' | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos' | 'recent' | 'logs' | 'crashDumps') => app.getPath(name))

  // --- Updater (macOS: download zip from GitHub Releases, silent replace on quit) ---
  ipcMain.handle('updater:check', async () => {
    await checkForUpdateNow(true)
  })
  ipcMain.handle('updater:apply', async () => {
    await applyUpdate()
  })
  ipcMain.handle('updater:setAutoUpdate', (_e, enabled: boolean) => {
    setAutoUpdate(enabled)
  })
}
