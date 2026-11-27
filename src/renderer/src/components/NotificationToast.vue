<template>
  <TransitionGroup
    name="notification"
    tag="div"
    class="notification-stack"
    role="status"
    aria-live="polite"
  >
    <div
      v-for="n in notifications"
      :key="n.id"
      class="notification"
      :class="`notification-${n.type}`"
      :role="n.type === 'error' ? 'alert' : undefined"
      @click="dismiss(n.id)"
      @mouseenter="pause(n.id)"
      @mouseleave="resume(n.id)"
    >
      <span class="notification-icon"><Icon :name="icon(n.type)" :size="14" /></span>
      <span class="notification-text">{{ n.text }}</span>
      <button
        class="notification-close"
        :aria-label="t('common.close')"
        :title="t('common.close')"
        @click.stop="dismiss(n.id)"
      ><Icon name="x" :size="12" /></button>
    </div>
  </TransitionGroup>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './ui/Icon.vue'

const { t } = useI18n()

export interface Notification {
  id: string
  type: 'info' | 'success' | 'warning' | 'error'
  text: string
  duration: number
}

const notifications = ref<Notification[]>([])
// Timers are tracked per notification so hovering pauses the countdown and
// an error stays until the user dismisses it instead of vanishing mid-read.
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const remaining = new Map<string, number>()
const startedAt = new Map<string, number>()
let idCounter = 0

function icon(type: string): string {
  switch (type) {
    case 'success': return 'check-circle'
    case 'warning': return 'alert-triangle'
    case 'error': return 'x-circle'
    default: return 'info'
  }
}

function schedule(id: string, duration: number) {
  if (duration <= 0) return
  remaining.set(id, duration)
  startedAt.set(id, Date.now())
  timers.set(id, setTimeout(() => dismiss(id), duration))
}

function show(type: Notification['type'], text: string, duration?: number) {
  const ms = duration ?? (type === 'error' ? 0 : 4000)
  const id = `n-${++idCounter}`
  notifications.value.push({ id, type, text, duration: ms })
  schedule(id, ms)
}

function pause(id: string) {
  const timer = timers.get(id)
  if (!timer) return
  clearTimeout(timer)
  timers.delete(id)
  const left = (remaining.get(id) ?? 0) - (Date.now() - (startedAt.get(id) ?? Date.now()))
  remaining.set(id, Math.max(left, 1500))
}

function resume(id: string) {
  if (timers.has(id)) return
  const left = remaining.get(id)
  if (left !== undefined) schedule(id, left)
}

function dismiss(id: string) {
  const timer = timers.get(id)
  if (timer) clearTimeout(timer)
  timers.delete(id)
  remaining.delete(id)
  startedAt.delete(id)
  notifications.value = notifications.value.filter(n => n.id !== id)
}

function info(text: string, duration?: number) { show('info', text, duration) }
function success(text: string, duration?: number) { show('success', text, duration) }
function warning(text: string, duration?: number) { show('warning', text, duration) }
function error(text: string, duration?: number) { show('error', text, duration) }

defineExpose({ show, dismiss, info, success, warning, error })
</script>

<style scoped>
.notification-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-2);
  pointer-events: none;
}

.notification {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  color: var(--text-primary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-panel);
  pointer-events: auto;
  cursor: pointer;
  min-width: 220px;
  max-width: 380px;
  transition: box-shadow var(--transition-fast) ease, transform var(--transition-fast) ease;
}

.notification:hover {
  box-shadow: var(--shadow-2);
  transform: translateY(-1px);
}

.notification-success { border-left: 3px solid var(--text-success); }
.notification-error { border-left: 3px solid var(--text-danger); }
.notification-warning { border-left: 3px solid var(--text-warning); }
.notification-info { border-left: 3px solid var(--accent); }

.notification-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-xs);
  flex-shrink: 0;
}

.notification-success .notification-icon { color: var(--text-success); background: var(--success-soft); }
.notification-error .notification-icon { color: var(--text-danger); background: var(--danger-soft); }
.notification-warning .notification-icon { color: var(--text-warning); background: var(--warning-soft); }
.notification-info .notification-icon { color: var(--text-accent); background: var(--accent-soft); }

.notification-text {
  flex: 1;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
}

.notification-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--text-faint);
  background: none;
  border: none;
  cursor: pointer;
  border-radius: var(--radius-xs);
  flex-shrink: 0;
}

.notification-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.notification-enter-active {
  transition: all var(--transition-base) var(--ease-out);
}
.notification-leave-active {
  transition: all var(--transition-fast) var(--ease-in-out);
}
.notification-enter-from {
  opacity: 0;
  transform: translateX(40px);
}
.notification-leave-to {
  opacity: 0;
  transform: translateX(40px);
}
</style>
