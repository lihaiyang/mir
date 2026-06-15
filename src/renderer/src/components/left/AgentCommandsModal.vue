<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-title">{{ $t('agentCommands.title') }} — {{ project.name }}</div>

      <div class="agent-list">
        <div
          v-for="cmd in commands"
          :key="cmd.id"
          class="agent-item"
        >
          <div class="agent-item-row">
            <input v-model="cmd.name" :placeholder="$t('agentCommands.namePlaceholder')" class="agent-name-input" />
            <button class="icon-btn" :title="$t('agentCommands.launch')" @click="launch(cmd)">▶</button>
            <button class="icon-btn danger" :title="$t('common.remove')" @click="removeCmd(cmd.id)">×</button>
          </div>
          <input v-model="cmd.command" :placeholder="$t('agentCommands.commandPlaceholder')" class="agent-cmd-input" />
          <input v-model="cmd.description" :placeholder="$t('agentCommands.descriptionPlaceholder')" class="agent-desc-input" />
        </div>
        <div v-if="commands.length === 0" class="agent-empty">{{ $t('agentCommands.noCommands') }}</div>
      </div>

      <button class="btn-secondary" style="width:100%;margin-top:8px" @click="addCmd">{{ $t('agentCommands.addCommand') }}</button>

      <div class="modal-actions">
        <button class="btn-secondary" @click="$emit('close')">{{ $t('common.cancel') }}</button>
        <button class="btn-primary" @click="save">{{ $t('common.save') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { useProjectStore, type Project, type AgentCommand } from '../../stores/projects'
import { useTabStore } from '../../stores/tabs'

const props = defineProps<{ project: Project }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const projectStore = useProjectStore()
const tabStore = useTabStore()

const commands = ref<AgentCommand[]>(
  JSON.parse(JSON.stringify(props.project.agentCommands || []))
)

function addCmd() {
  commands.value.push({ id: uuidv4(), name: '', command: '', description: '' })
}

function removeCmd(id: string) {
  commands.value = commands.value.filter(c => c.id !== id)
}

async function save() {
  await projectStore.updateProjectAgentCommands(props.project.id, commands.value)
  emit('close')
}

async function launch(cmd: AgentCommand) {
  if (!cmd.command.trim()) return
  const tab = await tabStore.addTab(props.project.id, 'terminal', {
    terminalCwd: props.project.path,
    title: cmd.name || 'Agent'
  })
  // Dispatch to the terminal tab via a custom event with the command to run
  window.dispatchEvent(new CustomEvent('agent-launch', {
    detail: { tabId: tab.id, command: cmd.command, cwd: props.project.path }
  }))
  emit('close')
}
</script>

<style scoped>
.agent-list { display: flex; flex-direction: column; gap: 12px; max-height: 320px; overflow-y: auto; margin: 8px 0; }
.agent-item { border: 1px solid var(--border-color); border-radius: 4px; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.agent-item-row { display: flex; gap: 4px; align-items: center; }
.agent-name-input { flex: 1; font-size: 13px; }
.agent-cmd-input { width: 100%; font-size: 12px; font-family: monospace; }
.agent-desc-input { width: 100%; font-size: 11px; color: var(--text-secondary); }
.agent-empty { color: var(--text-secondary); font-size: 12px; text-align: center; padding: 12px; }
.icon-btn.danger:hover { color: var(--text-danger); }
</style>
