<template>
  <div class="permission-card">
    <button
      class="permission-close"
      type="button"
      :title="t('acp.permission.cancel', 'Cancel request')"
      :disabled="submitting"
      @click="respond(null)"
    >
      <Icon name="x" :size="12" />
    </button>

    <div class="permission-head">
      <Icon name="alert-triangle" :size="15" class="permission-icon" />
      <div class="permission-heading">
        <div class="permission-title" :title="title">{{ title }}</div>
        <div class="permission-sub">
          <span v-if="kindLabel" class="permission-kind">{{ kindLabel }}</span>
          <span class="permission-agent">{{ request.agentId }}</span>
        </div>
      </div>
    </div>

    <div class="permission-actions">
      <button
        v-for="option in request.options"
        :key="option.optionId"
        class="permission-btn"
        :class="`permission-btn--${option.kind}`"
        type="button"
        :disabled="submitting"
        @click="respond(option.optionId)"
      >
        <Icon :name="optionIcon(option.kind)" :size="12" />
        <span>{{ optionLabel(option) }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../../ui/Icon.vue'
import { useAcpStore } from '../../../stores/acp'
import type { AcpPermissionRequest, PermissionOption } from '@shared/acp'

const props = defineProps<{ request: AcpPermissionRequest }>()

const { t } = useI18n()
const acpStore = useAcpStore()

const submitting = ref(false)

const title = computed(() => props.request.toolCall.title || t('acp.permission.title', 'Permission required'))

const kindLabel = computed(() => {
  const kind = props.request.toolCall.kind
  return kind ? t('acp.permission.kind', 'Tool: {kind}', { named: { kind } }) : ''
})

function optionLabel(option: PermissionOption): string {
  switch (option.kind) {
    case 'allow_once':
      return option.name || t('acp.permission.allowOnce', 'Allow once')
    case 'allow_always':
      return option.name || t('acp.permission.allowAlways', 'Always allow')
    case 'reject_once':
      return option.name || t('acp.permission.rejectOnce', 'Reject')
    default:
      return option.name || t('acp.permission.rejectAlways', 'Always reject')
  }
}

function optionIcon(kind: PermissionOption['kind']): string {
  switch (kind) {
    case 'allow_once':
      return 'check'
    case 'allow_always':
      return 'check-circle'
    case 'reject_once':
      return 'x'
    default:
      return 'x-circle'
  }
}

async function respond(optionId: string | null): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  try {
    await acpStore.respondPermission(props.request.requestId, optionId)
  } catch {
    // The store surfaces failures as chat notices; keep the card interactive.
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.permission-card {
  position: relative;
  margin: var(--space-2) var(--space-4);
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--text-warning) 45%, var(--border-color));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--text-warning) 7%, var(--bg-secondary));
  box-shadow: var(--shadow-1);
}

.permission-close {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: var(--radius-sm);
  color: var(--text-faint);
}
.permission-close:hover { color: var(--text-primary); background: var(--bg-hover); }

.permission-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding-right: 20px;
}
.permission-icon {
  margin-top: 2px;
  color: var(--text-warning);
  flex-shrink: 0;
}
.permission-heading { min-width: 0; }

.permission-title {
  font-size: var(--text-md);
  font-weight: 600;
  line-height: 1.4;
  color: var(--text-primary);
  word-break: break-word;
}

.permission-sub {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.permission-kind {
  font-family: var(--font-mono);
}
.permission-agent {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.permission-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.permission-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
}
.permission-btn:hover { border-color: var(--border-strong); color: var(--text-primary); }

.permission-btn--allow_once,
.permission-btn--allow_always {
  color: var(--text-on-accent);
  background: var(--text-accent);
  border-color: transparent;
}
.permission-btn--allow_once:hover,
.permission-btn--allow_always:hover {
  color: var(--text-on-accent);
  filter: brightness(1.08);
}

.permission-btn--reject_always { color: var(--text-danger); }
</style>
