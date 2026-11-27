<template>
  <div class="wf-tab">
    <header class="wf-header">
      <div class="wf-title-wrap">
        <Icon name="activity" :size="16" />
        <h2 class="wf-title">{{ t('acp.workflow.title', 'Multi-Agent Workflow') }}</h2>
      </div>
      <div class="wf-actions">
        <button class="wf-btn" type="button" :disabled="running" @click="addStep" :aria-label="t('acp.workflow.addStep', 'Add step')">
          <Icon name="plus" :size="13" />
          <span>{{ t('acp.workflow.addStep', 'Add step') }}</span>
        </button>
        <button
          class="wf-btn wf-btn-primary"
          type="button"
          :disabled="running || steps.length === 0 || !availableAgents.length"
          @click="runWorkflow"
         :aria-label="running ? t('acp.workflow.running', 'Running…') : t('acp.workflow.run', 'Run Workflow')">
          <Icon :name="running ? 'rotate' : 'send'" :size="13" :class-name="running ? 'spin' : undefined" />
          <span>{{ running ? t('acp.workflow.running', 'Running…') : t('acp.workflow.run', 'Run Workflow') }}</span>
        </button>
      </div>
    </header>

    <div class="wf-body">
      <section class="wf-input-card">
        <label class="wf-label">{{ t('acp.workflow.initialInput', 'Initial Task / Context') }}</label>
        <textarea
          v-model="initialInput"
          class="wf-textarea"
          rows="3"
          :disabled="running"
          :placeholder="t('acp.workflow.inputPlaceholder', 'Describe the overall goal or paste context for step 1…')"
        />
      </section>

      <div class="wf-steps">
        <div v-for="(step, idx) in steps" :key="step.id" class="wf-step" :class="`wf-step--${step.status}`">
          <div class="wf-step-head">
            <span class="wf-step-num">#{{ idx + 1 }}</span>
            <select v-model="step.agentId" class="wf-select" :disabled="running">
              <option v-for="agent in availableAgents" :key="agent.id" :value="agent.id">
                {{ agent.name }}
              </option>
            </select>
            <select v-model="step.mode" class="wf-select wf-select-sm" :disabled="running">
              <option value="serial">{{ t('acp.workflow.serial', 'Serial (Pipeline)') }}</option>
              <option value="parallel">{{ t('acp.workflow.parallel', 'Parallel with prev') }}</option>
            </select>
            <span class="wf-step-status" :class="`is-${step.status}`">{{ step.status }}</span>
            <button
              v-if="steps.length > 1"
              class="wf-icon-btn"
              type="button"
              :disabled="running"
              @click="removeStep(idx)"
            >
              <Icon name="trash" :size="12" />
            </button>
          </div>
          <textarea
            v-model="step.prompt"
            class="wf-textarea wf-step-prompt"
            rows="4"
            :disabled="running"
            :placeholder="t('acp.workflow.promptPlaceholder', 'Prompt for this step (supports {{input}} and {{prev}})')"
          />
          <div v-if="step.output || step.error" class="wf-step-output">
            <div v-if="step.error" class="wf-step-error">{{ step.error }}</div>
            <pre v-else class="wf-step-pre">{{ step.output }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../ui/Icon.vue'
import { useAcpStore } from '../../stores/acp'
import { useProjectStore } from '../../stores/projects'
import type { Tab } from '../../stores/tabs'
import type { AcpAgentConfig } from '@shared/acp'

defineProps<{ tab: Tab }>()

const { t } = useI18n()
const acpStore = useAcpStore()
const projectStore = useProjectStore()

interface WorkflowStep {
  id: string
  agentId: string
  mode: 'serial' | 'parallel'
  prompt: string
  status: 'pending' | 'running' | 'done' | 'error'
  output: string
  error: string
}

const availableAgents = computed<AcpAgentConfig[]>(() =>
  (acpStore.config.agents ?? []).filter((a) => a.enabled !== false)
)

const initialInput = ref('')
const running = ref(false)
const steps = ref<WorkflowStep[]>([
  {
    id: 'step-1',
    agentId: '',
    mode: 'serial',
    prompt: 'Analyze the task and propose an implementation plan:\n\n{{input}}',
    status: 'pending',
    output: '',
    error: ''
  },
  {
    id: 'step-2',
    agentId: '',
    mode: 'serial',
    prompt: 'Based on the previous analysis, implement or verify the solution:\n\n{{prev}}',
    status: 'pending',
    output: '',
    error: ''
  }
])

watch(
  availableAgents,
  (list) => {
    const fallback = list[0]?.id ?? ''
    if (!fallback) return
    for (const s of steps.value) {
      if (!s.agentId || !list.some((a) => a.id === s.agentId)) {
        s.agentId = fallback
      }
    }
  },
  { immediate: true }
)

function addStep(): void {
  steps.value.push({
    id: `step-${Date.now().toString(36)}`,
    agentId: availableAgents.value[0]?.id ?? '',
    mode: 'serial',
    prompt: '{{prev}}',
    status: 'pending',
    output: '',
    error: ''
  })
}

function removeStep(idx: number): void {
  steps.value.splice(idx, 1)
}

function renderPrompt(template: string, prevOutput: string): string {
  return template
    .replace(/\{\{input\}\}/g, initialInput.value.trim())
    .replace(/\{\{prev\}\}/g, prevOutput.trim())
}

async function executeStep(step: WorkflowStep, prevOutput: string): Promise<string> {
  step.status = 'running'
  step.output = ''
  step.error = ''
  try {
    const cwd = acpStore.config.defaultWorkingDirectory || projectStore.activeProject?.path
    const detail = await window.electronAPI.acpCreateSession(step.agentId, cwd)
    const promptText = renderPrompt(step.prompt, prevOutput) || initialInput.value.trim() || 'Hello'
    await acpStore.sendPrompt(detail.sessionId, promptText)
    const state = acpStore.getSession(detail.sessionId)
    const agentMsgs = (state?.items ?? [])
      .filter((i) => i.kind === 'agent')
      .map((i) => (i.kind === 'agent' ? i.text : ''))
      .join('\n\n')
    step.output = agentMsgs || '(No text output)'
    step.status = 'done'
    return step.output
  } catch (e) {
    step.error = e instanceof Error ? e.message : String(e)
    step.status = 'error'
    throw e
  }
}

async function runWorkflow(): Promise<void> {
  if (running.value) return
  running.value = true
  let prevOutput = ''
  try {
    // 分批执行：serial 开启新批次，parallel 与前一步合并为同一批次并发执行
    const batches: WorkflowStep[][] = []
    for (const step of steps.value) {
      step.status = 'pending'
      step.output = ''
      step.error = ''
      if (step.mode === 'parallel' && batches.length > 0) {
        batches[batches.length - 1].push(step)
      } else {
        batches.push([step])
      }
    }

    for (const batch of batches) {
      const results = await Promise.all(batch.map((s) => executeStep(s, prevOutput)))
      prevOutput = results.join('\n\n---\n\n')
    }
  } catch {
    // individual step error already recorded
  } finally {
    running.value = false
  }
}
</script>

<style scoped>
.wf-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
  color: var(--text-primary);
}
.wf-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-hairline);
  flex-shrink: 0;
}
.wf-title-wrap { display: flex; align-items: center; gap: 8px; }
.wf-title { font-size: var(--text-md); font-weight: 600; margin: 0; }
.wf-actions { display: flex; gap: 8px; }
.wf-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-hairline);
  background: var(--bg-secondary);
  font-size: var(--text-xs);
  color: var(--text-primary);
  cursor: pointer;
}
.wf-btn:hover:not(:disabled) { background: var(--bg-hover); }
.wf-btn:disabled { opacity: 0.5; }
.wf-btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-on-accent);
}
.wf-btn-primary:hover:not(:disabled) { opacity: 0.92; background: var(--accent); }
.wf-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.wf-input-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wf-label { font-size: var(--text-xs); font-weight: 600; color: var(--text-secondary); }
.wf-textarea {
  width: 100%;
  min-height: 76px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.55;
  resize: vertical;
  outline: none;
  transition: background var(--transition-fast) ease, border-color var(--transition-fast) ease, box-shadow var(--transition-fast) ease;
}
.wf-textarea:focus {
  background: var(--bg-primary);
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.wf-step-prompt {
  min-height: 84px;
}
.wf-steps { display: flex; flex-direction: column; gap: 18px; }
.wf-step {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wf-step--running .wf-step-prompt { border-color: var(--accent); }
.wf-step--done .wf-step-prompt { border-color: var(--text-success); }
.wf-step--error .wf-step-prompt { border-color: var(--text-danger); }
.wf-step-head { display: flex; align-items: center; gap: 8px; }
.wf-step-num { font-family: var(--font-mono); font-size: var(--text-xs); font-weight: 700; color: var(--accent-strong); }
.wf-select {
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: var(--text-xs);
}
.wf-select-sm { color: var(--text-secondary); }
.wf-step-status {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--bg-tertiary);
  font-size: var(--text-3xs);
  font-weight: 600;
  text-transform: uppercase;
  font-family: var(--font-mono);
  color: var(--text-faint);
}
.wf-step-status.is-running { background: var(--accent-soft); color: var(--accent-strong); }
.wf-step-status.is-done { background: var(--success-soft); color: var(--text-success); }
.wf-step-status.is-error { background: var(--danger-soft); color: var(--text-danger); }
.wf-icon-btn { color: var(--text-faint); padding: 4px; }
.wf-icon-btn:hover { color: var(--text-danger); }
.wf-step-output {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  border: 1px solid var(--border-subtle);
  max-height: 240px;
  overflow-y: auto;
}
.wf-step-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.5;
}
.wf-step-error { color: var(--text-danger); font-size: var(--text-xs); }
.spin { animation: spin 1.1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
