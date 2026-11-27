<template>
  <Transition name="updater-slide">
    <div v-if="visible" class="update-toast">
      <template v-if="state.status === 'ready'">
        <div class="row">
          <span class="text">{{ t('updater.ready', { version: state.version }) }}</span>
        </div>
        <div class="row actions">
          <button class="btn-primary" @click="restartNow">{{ t('updater.restartNow') }}</button>
          <button class="btn-secondary" @click="dismiss">{{ t('updater.onQuit') }}</button>
        </div>
      </template>
      <template v-else-if="state.status === 'not-available'">
        <div class="row">
          <span class="text">{{ t('updater.upToDate') }}</span>
          <button class="btn-secondary" @click="dismiss">{{ t('common.close') }}</button>
        </div>
      </template>
      <template v-else-if="state.status === 'error'">
        <div class="row">
          <span class="text error">{{ t('updater.checkError', { message: state.message }) }}</span>
          <button class="btn-secondary" @click="dismiss">{{ t('common.close') }}</button>
        </div>
      </template>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const state = ref<UpdaterEvent>({ status: 'idle' })
const dismissed = ref(false)
let off: (() => void) | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

const visible = computed(() => {
  if (dismissed.value) return false
  const e = state.value
  if (e.status === 'ready') return true
  if (e.manual && (e.status === 'not-available' || e.status === 'error')) return true
  return false
})

function clearHideTimer(): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

function scheduleHide(ms: number): void {
  clearHideTimer()
  hideTimer = setTimeout(() => {
    dismissed.value = true
    hideTimer = null
  }, ms)
}

function restartNow(): void {
  window.electronAPI.applyUpdate()
}

function dismiss(): void {
  dismissed.value = true
}

watch(
  () => state.value.status,
  (s) => {
    const e = state.value
    if (s === 'ready') {
      dismissed.value = false
      clearHideTimer()
    } else if (s === 'not-available' && e.manual) {
      dismissed.value = false
      scheduleHide(3000)
    } else if (s === 'error' && e.manual) {
      dismissed.value = false
      scheduleHide(6000)
    }
  }
)

onMounted(() => {
  off = window.electronAPI.onUpdaterEvent((e) => {
    state.value = e
  })
})

onUnmounted(() => {
  off?.()
  clearHideTimer()
})
</script>

<style scoped>
.update-toast {
  width: 350px;
  max-width: calc(100vw - 32px);
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 14px 16px;
  box-shadow: var(--shadow-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.text {
  font-size: var(--text-sm);
  color: var(--text-primary);
  line-height: var(--leading-sm);
}
.text.error {
  color: var(--text-danger);
}
.actions {
  justify-content: flex-end;
}
.updater-slide-enter-active,
.updater-slide-leave-active {
  transition: transform var(--transition-base) var(--ease-out), opacity var(--transition-base) ease;
}
.updater-slide-enter-from,
.updater-slide-leave-to {
  transform: translateY(20px);
  opacity: 0;
}
</style>
