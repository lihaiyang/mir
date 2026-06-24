import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Store
  storeGet: (key: string) => ipcRenderer.invoke('store:get', key),
  storeSet: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, JSON.parse(JSON.stringify(value))),
  storeDelete: (key: string) => ipcRenderer.invoke('store:delete', key),

  // Dialog
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openFolderAt: (defaultPath: string) => ipcRenderer.invoke('dialog:openFolderAt', defaultPath),
  showSaveDialog: () => ipcRenderer.invoke('dialog:showSaveDialog'),

  // File system
  readdir: (p: string) => ipcRenderer.invoke('fs:readdir', p),
  readFile: (p: string) => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p: string, content: string) => ipcRenderer.invoke('fs:writeFile', p, content),
  exists: (p: string) => ipcRenderer.invoke('fs:exists', p),
  mkdir: (p: string) => ipcRenderer.invoke('fs:mkdir', p),
  rename: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
  deleteFile: (p: string) => ipcRenderer.invoke('fs:delete', p),
  stat: (p: string) => ipcRenderer.invoke('fs:stat', p),
  showItemInFolder: (p: string) => ipcRenderer.invoke('shell:showItemInFolder', p),
  openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),

  // PTY
  ptyCreate: (id: string, cwd: string, shell?: string) => ipcRenderer.invoke('pty:create', id, cwd, shell),
  ptyWrite: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('pty:resize', id, cols, rows),
  ptyClose: (id: string) => ipcRenderer.invoke('pty:close', id),
  onPtyData: (id: string, cb: (data: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: string) => cb(data)
    ipcRenderer.on(`pty:data:${id}`, listener)
    return () => ipcRenderer.removeListener(`pty:data:${id}`, listener)
  },
  onPtyExit: (id: string, cb: (code: number) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, code: number) => cb(code)
    ipcRenderer.on(`pty:exit:${id}`, listener)
    return () => ipcRenderer.removeListener(`pty:exit:${id}`, listener)
  },

  // Git
  gitStatus: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
  gitLog: (cwd: string) => ipcRenderer.invoke('git:log', cwd),
  gitDiff: (cwd: string, file?: string) => ipcRenderer.invoke('git:diff', cwd, file),
  gitDiffStaged: (cwd: string, file?: string) => ipcRenderer.invoke('git:diffStaged', cwd, file),
  gitStage: (cwd: string, file: string) => ipcRenderer.invoke('git:stage', cwd, file),
  gitStageAll: (cwd: string) => ipcRenderer.invoke('git:stageAll', cwd),
  gitUnstage: (cwd: string, file: string) => ipcRenderer.invoke('git:unstage', cwd, file),
  gitCommit: (cwd: string, message: string) => ipcRenderer.invoke('git:commit', cwd, message),
  gitPull: (cwd: string) => ipcRenderer.invoke('git:pull', cwd),
  gitPush: (cwd: string) => ipcRenderer.invoke('git:push', cwd),
  gitFetch: (cwd: string) => ipcRenderer.invoke('git:fetch', cwd),
  gitBranches: (cwd: string) => ipcRenderer.invoke('git:branches', cwd),
  gitCheckout: (cwd: string, branch: string) => ipcRenderer.invoke('git:checkout', cwd, branch),
  gitCreateBranch: (cwd: string, name: string) => ipcRenderer.invoke('git:createBranch', cwd, name),
  gitShowFile: (cwd: string, ref: string, file: string) => ipcRenderer.invoke('git:showFile', cwd, ref, file),

  // Search
  searchRun: (opts: unknown) => ipcRenderer.invoke('search:run', opts),

  // App
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getPath: (name: string) => ipcRenderer.invoke('app:getPath', name),

  // Updater (macOS: auto-check/download from GitHub Releases, open dmg to drag-install)
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  applyUpdate: () => ipcRenderer.invoke('updater:apply'),
  setAutoUpdate: (enabled: boolean) => ipcRenderer.invoke('updater:setAutoUpdate', enabled),
  onUpdaterEvent: (cb: (event: UpdaterEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: UpdaterEvent) => cb(event)
    ipcRenderer.on('updater:event', listener)
    return () => ipcRenderer.removeListener('updater:event', listener)
  }
})
