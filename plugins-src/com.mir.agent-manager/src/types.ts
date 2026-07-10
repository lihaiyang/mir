export type AgentType = 'opencode' | 'pi'

export interface ProviderConfig {
  id: string
  name: string
  baseURL: string
  apiKey: string
  models: ModelConfig[]
}

export interface ModelConfig {
  id: string
  name: string
  contextLimit: number
  outputLimit: number
}

export interface SkillInfo {
  name: string
  description: string
  dir: string
  skillMdPath: string
  source?: {
    type: 'github'
    repo: string
    url: string
    skillPath?: string
  }
  installedAt?: string
  updatedAt?: string
  folderHash?: string
}

export interface AgentSession {
  id: string
  dir: string
  name: string
  modified?: string
}

export interface ReadConfigResult {
  path: string
  content: string
  exists: boolean
}

export interface PluginApi {
  commands: {
    register: (cmd: { id: string; label: string; keybinding?: string; run: () => void }) => void
    unregister: (id: string) => void
  }
  tabs: {
    registerType: (reg: {
      type: string
      component: unknown
      icon?: string
      defaultTitle?: string | (() => string)
    }) => void
    unregisterType: (type: string) => void
    add: (projectId: string, type: string, extra?: Record<string, unknown>) => Promise<unknown>
  }
  panels: {
    registerRight: (reg: {
      id: string
      label: string | (() => string)
      icon: string
      component: unknown
    }) => void
    unregisterRight: (id: string) => void
  }
  ipc: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    send: (channel: string, ...args: unknown[]) => void
    on: (channel: string, cb: (...args: unknown[]) => void) => () => void
  }
  app: {
    vue: typeof import('vue')
    i18n: { t: (key: string, ...args: unknown[]) => string }
    stores: {
      tabs: {
        addTab: (projectId: string, type: string, extra?: Record<string, unknown>) => Promise<unknown>
        getProjectTabs: (projectId: string) => unknown[]
      }
      projects: {
        activeProject: { id: string; name: string; path: string } | null
        activeProjectId: string | null
      }
      settings: {
        settings: Record<string, unknown>
        update: (patch: Record<string, unknown>) => void
      }
      layout: {
        rightActivePanel: string
        rightCollapsed: boolean
        persist: () => void
      }
    }
  }
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

export interface MainPluginApi {
  ipc: {
    registerHandler: (channel: string, fn: (...args: any[]) => any) => void
    registerOn: (channel: string, fn: (...args: any[]) => void) => void
  }
  store: {
    get: (key: string) => unknown
    set: (key: string, value: unknown) => void
    delete: (key: string) => void
  }
  paths: {
    userData: string
    home: string
    pluginsDir: string
  }
  app: import('electron').App
  getWindow: () => import('electron').BrowserWindow | null
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}
