import { defineComponent, h } from 'vue'
import { setApi } from './api-store'
import type { PluginApi } from './types'
import AgentConfigTab from './components/AgentConfigTab.vue'
import AgentsPanel from './components/AgentsPanel.vue'

export function activate(api: PluginApi): void {
  setApi(api)

  api.tabs.registerType({
    type: 'agent-config',
    component: AgentConfigTab,
    icon: '🤖',
    defaultTitle: 'Agent Manager'
  })

  api.panels.registerRight({
    id: 'agents',
    label: 'Agents',
    icon: '🤖',
    component: AgentsPanel
  })

  api.commands.register({
    id: 'agent-manager.open',
    label: 'Agent Manager: Open Config',
    run: () => {
      const pid = api.app.stores.projects.activeProjectId
      if (pid) {
        api.tabs.add(pid, 'agent-config', { title: 'Agent Manager' })
      }
    }
  })

  api.logger.info('Agent Manager renderer plugin activated')
}

export function deactivate(): void {
  // Will be called when plugin is unloaded
}
