<template>
  <Transition name="updater-slide">
    <div v-if="visible" class="update-toast">
      <template v-if="state.status === 'downloading'">
        <div class="row">
          <span class="text">{{ t('updater.downloading', { version: state.version }) }}</span>
          <span class="pct">{{ state.progress ?? 0 }}%</span>
        </div>
        <div class="bar">
          <div class="fill" :style="{ width: (state.progress ?? 0) + '%' }" />
        </div>
      </template>
      <template v-else-if="state.status === 'ready'">
        <div class="row">
          <span class="text">{{ t('updater.ready', { version: state.version }) }}</span>
        </div>
        <div class="row actions">
          <button class="btn primary" @click="reopen">{{ t('updater.reopen') }}</button>
          <button class="btn" @click="dismiss">{{ t('common.close') }}</button>
        </div>
      </template>
      <template v-else-if="state.status === 'not-available'">
        <div class="row">
          <span class="text">{{ t('updater.upToDate') }}</span>
          <button class="btn" @click="dismiss">{{ t('common.close') }}</button>
        </div>
      </template>
      <template v-else-if="state.status === 'error'">
        <div class="row">
          <span class="text error">{{ t('updater.checkError', { message: state.message }) }}</span>
          <button class="btn" @click="dismiss">{{ t('common.close') }}</button>
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
  if (e.status === 'downloading' || e.status === 'ready') return true
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

function reopen(): void {
  window.electronAPI.applyUpdate()
}

function dismiss(): void {
  dismissed.value = true
}

watch(
  () => state.value.status,
  (s) => {
    const e = state.value
    if (s === 'downloading' || s === 'ready') {
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
  position: fixed;
  bottom: 16px;
  right: 16px;
  width: 340px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.text {
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.4;
}
.text.error {
  color: var(--text-danger);
}
.pct {
  font-size: 12px;
  color: var(--text-secondary);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.bar {
  height: 4px;
  background: var(--bg-tertiary);
  border-radius: 2px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--text-accent);
  transition: width 0.2s ease;
}
.actions {
  justify-content: flex-end;
}
.btn {
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
}
.btn:hover {
  background: var(--bg-hover);
}
.btn.primary {
  background: var(--text-accent);
  color: #fff;
  border-color: transparent;
}
.btn.primary:hover {
  filter: brightness(1.1);
}

.updater-slide-enter-active,
.updater-slide-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}
.updater-slide-enter-from,
.updater-slide-leave-to {
  transform: translateY(20px);
  opacity: 0;
}
</style>
