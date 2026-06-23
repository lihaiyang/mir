/// <reference types="vite/client" />

declare module '*?worker' {
  const workerConstructor: {
    new (): Worker
  }
  export default workerConstructor
}

interface MonacoEnvironment {
  getWorker(_: unknown, label: string): Worker
}

declare var self: Window & { MonacoEnvironment?: MonacoEnvironment }

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}

interface ElectronAPI {
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  storeDelete: (key: string) => Promise<void>
  openFolder: () => Promise<string | null>
  showSaveDialog: () => Promise<string | null>
  readdir: (p: string) => Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]>
  readFile: (p: string) => Promise<string>
  writeFile: (p: string, content: string) => Promise<void>
  exists: (p: string) => Promise<boolean>
  mkdir: (p: string) => Promise<void>
  rename: (oldPath: string, newPath: string) => Promise<void>
  deleteFile: (p: string) => Promise<void>
  stat: (p: string) => Promise<{ mtime: number; size: number; isDirectory: boolean } | null>
  showItemInFolder: (p: string) => void
  openPath: (p: string) => Promise<void>
  ptyCreate: (id: string, cwd: string, shell?: string) => Promise<void>
  ptyWrite: (id: string, data: string) => void
  ptyResize: (id: string, cols: number, rows: number) => Promise<void>
  ptyClose: (id: string) => Promise<void>
  onPtyData: (id: string, cb: (data: string) => void) => () => void
  onPtyExit: (id: string, cb: (code: number) => void) => () => void
  gitStatus: (cwd: string) => Promise<GitStatus>
  gitLog: (cwd: string) => Promise<GitCommit[]>
  gitDiff: (cwd: string, file?: string) => Promise<string>
  gitDiffStaged: (cwd: string, file?: string) => Promise<string>
  gitStage: (cwd: string, file: string) => Promise<void>
  gitStageAll: (cwd: string) => Promise<void>
  gitUnstage: (cwd: string, file: string) => Promise<void>
  gitCommit: (cwd: string, message: string) => Promise<void>
  gitPull: (cwd: string) => Promise<unknown>
  gitPush: (cwd: string) => Promise<unknown>
  gitFetch: (cwd: string) => Promise<void>
  gitBranches: (cwd: string) => Promise<{ current: string; all: string[] }>
  gitCheckout: (cwd: string, branch: string) => Promise<void>
  gitCreateBranch: (cwd: string, name: string) => Promise<void>
  searchRun: (opts: unknown) => Promise<SearchMatch[]>
  getVersion: () => Promise<string>
  getPath: (name: string) => Promise<string>
  checkForUpdates: () => Promise<void>
  applyUpdate: () => Promise<void>
  onUpdaterEvent: (cb: (event: UpdaterEvent) => void) => () => void
}

interface GitStatus {
  branch: string
  tracking: string
  ahead: number
  behind: number
  staged: string[]
  modified: string[]
  notAdded: string[]
  deleted: string[]
  renamed: { from: string; to: string }[]
  conflicted: string[]
  files: { path: string; index: string; working_dir: string }[]
}

interface GitCommit {
  hash: string
  date: string
  message: string
  refs: string
  body: string
  author_name: string
  author_email: string
}

interface SearchMatch {
  file: string
  line: number
  col: number
  text: string
}

type UpdaterStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'ready' | 'error'

interface UpdaterEvent {
  status: UpdaterStatus
  version?: string
  progress?: number
  message?: string
}

declare interface Window {
  electronAPI: ElectronAPI
}
