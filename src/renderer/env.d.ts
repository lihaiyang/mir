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
  openFolderAt: (defaultPath: string) => Promise<string | null>
  showSaveDialog: () => Promise<string | null>
  readdir: (p: string) => Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]>
  readFile: (p: string, encoding?: string) => Promise<{ content: string; encoding: string }>
  writeFile: (p: string, content: string, encoding?: string) => Promise<void>
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
  gitStashPush: (cwd: string, message: string) => Promise<void>
  gitStashPop: (cwd: string) => Promise<void>
  gitCheckoutDiscard: (cwd: string) => Promise<void>
  gitShowFile: (cwd: string, ref: string, file: string) => Promise<string>
  searchStart: (id: string, opts: unknown) => void
  searchCancel: (id: string) => void
  onSearchResults: (cb: (id: string, matches: SearchMatch[]) => void) => () => void
  onSearchComplete: (cb: (id: string, filesProcessed: number, totalMatches: number) => void) => () => void
  onSearchError: (cb: (id: string, message: string) => void) => () => void
  getVersion: () => Promise<string>
  getPath: (name: string) => Promise<string>
  onReloadBrowser: (cb: () => void) => () => void
  onWebviewNewWindow: (cb: (url: string) => void) => () => void
  checkForUpdates: () => Promise<void>
  applyUpdate: () => Promise<void>
  setAutoUpdate: (enabled: boolean) => Promise<void>
  onUpdaterEvent: (cb: (event: UpdaterEvent) => void) => () => void

  // Plugins
  pluginSetSharedKeys: (moduleName: string, keys: string[]) => Promise<void>
  pluginList: () => Promise<{ manifest: PluginManifest; enabled: boolean }[]>
  pluginEnable: (id: string) => Promise<void>
  pluginDisable: (id: string) => Promise<void>
  pluginInstall: (srcDir: string) => Promise<PluginInstallResult>
  pluginInstallGit: (gitUrl: string, subPath: string) => Promise<PluginInstallResult>
  pluginUninstall: (id: string) => Promise<PluginInstallResult>
  pluginPluginsDir: () => Promise<string>
  pluginInvoke: (pluginId: string, channel: string, ...args: unknown[]) => Promise<unknown>
  pluginSend: (pluginId: string, channel: string, ...args: unknown[]) => void
  pluginOn: (pluginId: string, channel: string, cb: (...args: unknown[]) => void) => () => void

  // ACP (Agent Client Protocol) — see src/shared/acp.ts
  acpGetConfig: () => Promise<import('@shared/acp').AcpConfig>
  acpSetConfig: (patch: Partial<import('@shared/acp').AcpConfig>) => Promise<import('@shared/acp').AcpConfig>
  acpGetState: () => Promise<import('@shared/acp').AcpStateSnapshot>
  acpGetAgents: () => Promise<import('@shared/acp').AcpAgentRuntimeInfo[]>
  acpGetRegistry: () => Promise<import('@shared/acp').AcpRegistryAgent[]>
  acpCreateSession: (agentId: string, cwd?: string) => Promise<import('@shared/acp').AcpSessionDetail>
  acpLoadSession: (agentId: string, sessionId: string, cwd?: string) => Promise<import('@shared/acp').AcpSessionDetail>
  acpResumeSession: (agentId: string, sessionId: string, cwd?: string) => Promise<import('@shared/acp').AcpSessionDetail>
  acpCloseSession: (sessionId: string) => Promise<void>
  acpDisconnectAgent: (agentId: string) => Promise<void>
  acpSendPrompt: (sessionId: string, blocks: import('@shared/acp').AcpPromptBlock[]) => Promise<{ stopReason: string }>
  acpCancelPrompt: (sessionId: string) => Promise<void>
  acpSetConfigOption: (sessionId: string, configId: string, value: string | boolean) => Promise<import('@shared/acp').SessionConfigOption[]>
  acpSetMode: (sessionId: string, modeId: string) => Promise<void>
  acpSetModel: (sessionId: string, modelId: string) => Promise<void>
  acpListSessions: (agentId: string, cwd?: string) => Promise<import('@shared/acp').AcpRemoteSession[]>
  acpListHistory: () => Promise<import('@shared/acp').AcpHistoryEntry[]>
  acpForgetSession: (agentId: string, sessionId: string) => Promise<void>
  acpAuthenticate: (agentId: string, methodId: string) => Promise<import('@shared/acp').AcpAuthMethod[]>
  acpRespondPermission: (requestId: string, optionId: string | null) => Promise<void>
  acpGetHarnessConfig: () => Promise<import('@shared/harness').HarnessConfigSnapshot>
  acpSetHarnessConfig: (
    config: import('@shared/harness').HarnessConfig
  ) => Promise<import('@shared/harness').HarnessConfigSnapshot>
  acpDiscoverHarnessModels: (params: {
    apiBase: string
    apiKey?: string
  }) => Promise<import('@shared/harnessModels').HarnessModelDiscoveryResult>
  acpGetTraffic: () => Promise<import('@shared/acp').AcpTrafficEntry[]>
  acpGetPermissions: () => Promise<import('@shared/acp').AcpPermissionRequest[]>
  onAcpEvent: (cb: (event: import('@shared/acp').AcpEvent) => void) => () => void
}

interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  main?: string
  mainMain?: string
  engines?: { mir?: string }
}

interface PluginInstallResult {
  success: boolean
  error?: string
  pluginId?: string
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

type UpdaterStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'extracting' | 'ready' | 'error'

interface UpdaterEvent {
  status: UpdaterStatus
  version?: string
  progress?: number
  message?: string
  manual?: boolean
}

declare interface Window {
  electronAPI: ElectronAPI
}
