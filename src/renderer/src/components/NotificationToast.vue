<template>
  <Teleport to="body">
    <div class="notification-container">
      <TransitionGroup name="notification">
        <div
          v-for="n in notifications"
          :key="n.id"
          class="notification"
          :class="`notification-${n.type}`"
          @click="dismiss(n.id)"
        >
          <span class="notification-icon">{{ icon(n.type) }}</span>
          <span class="notification-text">{{ n.text }}</span>
          <button class="notification-close" @click.stop="dismiss(n.id)">&times;</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue'

export interface Notification {
  id: string
  type: 'info' | 'success' | 'warning' | 'error'
  text: string
  duration: number
}

const notifications = ref<Notification[]>([])
let idCounter = 0

function icon(type: string): string {
  switch (type) {
    case 'success': return '✓'
    case 'warning': return '⚠'
    case 'error': return '✕'
    default: return 'ℹ'
  }
}

function show(type: Notification['type'], text: string, duration = 4000) {
  const id = `n-${++idCounter}`
  notifications.value.push({ id, type, text, duration })
  if (duration > 0) {
    setTimeout(() => dismiss(id), duration)
  }
}

function dismiss(id: string) {
  notifications.value = notifications.value.filter(n => n.id !== id)
}

function info(text: string, duration?: number) { show('info', text, duration) }
function success(text: string, duration?: number) { show('success', text, duration) }
function warning(text: string, duration?: number) { show('warning', text, duration) }
function error(text: string, duration?: number) { show('error', text, duration) }

defineExpose({ show, dismiss, info, success, warning, error })
</script>

<style scoped>
.notification-container {
  position: fixed;
  bottom: 40px;
  right: 16px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.notification {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  pointer-events: auto;
  cursor: pointer;
  min-width: 200px;
  max-width: 360px;
}

.notification:hover {
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
}

.notification-success { border-left: 3px solid #4ec9b0; }
.notification-error { border-left: 3px solid #f44747; }
.notification-warning { border-left: 3px solid #d97706; }
.notification-info { border-left: 3px solid #569cd6; }

.notification-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.notification-success .notification-icon { color: #4ec9b0; }
.notification-error .notification-icon { color: #f44747; }
.notification-warning .notification-icon { color: #d97706; }
.notification-info .notification-icon { color: #569cd6; }

.notification-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notification-close {
  font-size: 16px;
  color: var(--text-secondary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0 2px;
  flex-shrink: 0;
}

.notification-close:hover {
  color: var(--text-primary);
}

.notification-enter-active {
  transition: all 0.25s ease-out;
}
.notification-leave-active {
  transition: all 0.2s ease-in;
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
