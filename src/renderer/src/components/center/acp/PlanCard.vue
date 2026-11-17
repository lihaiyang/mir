<template>
  <div v-if="entries.length" class="plan-card">
    <div class="plan-head">
      <Icon name="rows" :size="12" class="plan-icon" />
      <span class="plan-title">{{ t('acp.plan.title', 'Plan') }}</span>
      <span class="plan-count">{{ completedCount }}/{{ entries.length }}</span>
    </div>
    <ul class="plan-list">
      <li
        v-for="(entry, index) in entries"
        :key="index"
        class="plan-item"
        :class="`plan-item--${entry.status}`"
      >
        <span class="plan-status" :class="`plan-status--${entry.status}`">
          <Icon v-if="entry.status === 'completed'" name="check-circle" :size="13" />
          <Icon v-else-if="entry.status === 'in_progress'" name="rotate" :size="13" class-name="spin" />
          <span v-else class="plan-dot" />
        </span>
        <span class="plan-content" :class="{ 'is-done': entry.status === 'completed' }">
          {{ entry.content }}
        </span>
        <span
          v-if="entry.priority !== 'medium'"
          class="plan-priority"
          :class="`plan-priority--${entry.priority}`"
        >
          {{ priorityLabel(entry.priority) }}
        </span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../../ui/Icon.vue'
import type { PlanEntry } from '@shared/acp'

const props = defineProps<{ entries: PlanEntry[] }>()

const { t } = useI18n()

const completedCount = computed(() => props.entries.filter((entry) => entry.status === 'completed').length)

function priorityLabel(priority: PlanEntry['priority']): string {
  switch (priority) {
    case 'high':
      return t('acp.plan.priority.high', 'High')
    case 'low':
      return t('acp.plan.priority.low', 'Low')
    default:
      return t('acp.plan.priority.medium', 'Medium')
  }
}
</script>

<style scoped>
.plan-card {
  margin: var(--space-2) 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  overflow: hidden;
}

.plan-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-3);
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
.plan-icon { color: var(--accent-strong); }
.plan-title { font-weight: 600; letter-spacing: 0.02em; }
.plan-count {
  margin-left: auto;
  font-family: var(--font-mono);
  color: var(--text-faint);
}

.plan-list {
  margin: 0;
  padding: var(--space-1) 0;
  list-style: none;
}

.plan-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 5px var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  color: var(--text-secondary);
}
.plan-item--in_progress {
  background: var(--accent-soft);
  color: var(--text-primary);
}
.plan-item--completed { color: var(--text-faint); }

.plan-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  margin-top: 2px;
  flex-shrink: 0;
}
.plan-status--completed { color: var(--text-success); }
.plan-status--in_progress { color: var(--accent-strong); }
.plan-status--pending { color: var(--text-faint); }

.plan-dot {
  width: 7px;
  height: 7px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
}

.plan-content {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.plan-content.is-done {
  text-decoration: line-through;
  text-decoration-color: var(--text-faint);
}

.plan-priority {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-subtle);
  font-size: var(--text-xs);
  line-height: var(--leading-xs);
  letter-spacing: 0.02em;
  color: var(--text-faint);
}
.plan-priority--high {
  color: var(--text-danger);
  border-color: color-mix(in srgb, var(--text-danger) 35%, var(--border-color));
}
.plan-priority--low { opacity: 0.7; }

.spin { animation: spin 1.1s linear infinite; }
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
