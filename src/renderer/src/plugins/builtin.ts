import i18n from '../i18n'
import TerminalTab from '../components/center/TerminalTab.vue'
import EditorTab from '../components/center/EditorTab.vue'
import FileTab from '../components/center/FileTab.vue'
import DiffTab from '../components/center/DiffTab.vue'
import BrowserTab from '../components/center/BrowserTab.vue'
import SettingsTab from '../components/SettingsTab.vue'
import PluginManager from '../components/PluginManager.vue'
import FileTreeRight from '../components/right/FileTreeRight.vue'
import GitPanel from '../components/right/GitPanel.vue'
import SearchPanel from '../components/right/SearchPanel.vue'
import { registerTabType, registerRightPanel } from './registries'

let registered = false

export function registerBuiltin(): void {
  if (registered) return
  registered = true

  const t = i18n.global.t.bind(i18n.global)

  registerTabType({
    type: 'terminal',
    component: TerminalTab,
    icon: '⬛',
    defaultTitle: () => t('tab.terminal'),
    showInToolbar: true
  })
  registerTabType({
    type: 'editor',
    component: EditorTab,
    icon: '📝',
    defaultTitle: () => t('tab.fileEditor'),
    showInToolbar: true
  })
  registerTabType({
    type: 'browser',
    component: BrowserTab,
    icon: '🌐',
    defaultTitle: () => t('tab.browser'),
    showInToolbar: true
  })
  registerTabType({
    type: 'file',
    component: FileTab,
    icon: '📄',
    defaultTitle: () => t('tab.file')
  })
  registerTabType({
    type: 'diff',
    component: DiffTab,
    icon: '🔀',
    defaultTitle: 'Diff'
  })
  registerTabType({
    type: 'settings',
    component: SettingsTab,
    icon: '⚙',
    defaultTitle: 'Settings'
  })
  registerTabType({
    type: 'plugin-manager',
    component: PluginManager,
    icon: '🧩',
    defaultTitle: () => t('plugins.title')
  })

  registerRightPanel({
    id: 'files',
    label: () => t('rightPane.files'),
    icon: '📁',
    component: FileTreeRight
  })
  registerRightPanel({
    id: 'git',
    label: () => t('rightPane.git'),
    icon: '🔀',
    component: GitPanel
  })
  registerRightPanel({
    id: 'search',
    label: () => t('rightPane.search'),
    icon: '🔍',
    component: SearchPanel
  })
}
