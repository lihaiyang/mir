<template>
  <div class="bsc-overlay" @mousedown.self="emit('choice', 'cancel')">
    <div class="bsc-modal">
      <div class="bsc-title">{{ $t('status.uncommittedChanges') }}</div>
      <p class="bsc-message">
        {{ $t('status.uncommittedChangesMessage', { branch }) }}
      </p>
      <div class="bsc-actions">
        <button class="btn-primary" @click="emit('choice', 'stash')">
          {{ $t('status.stashAndSwitch') }}
        </button>
        <button class="btn-secondary danger" @click="emit('choice', 'discard')">
          {{ $t('status.discardAndSwitch') }}
        </button>
        <button class="btn-secondary" @click="emit('choice', 'cancel')">
          {{ $t('common.cancel') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  branch: string
}>()

const emit = defineEmits<{
  (e: 'choice', choice: 'stash' | 'discard' | 'cancel'): void
}>()
</script>

<style scoped>
.bsc-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: var(--overlay);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.bsc-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-3);
  width: 420px;
  padding: 20px;
}

.bsc-title {
  font-size: var(--text-lg);
  line-height: var(--leading-lg);
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 12px;
}

.bsc-message {
  font-size: var(--text-md);
  color: var(--text-secondary);
  line-height: var(--leading-md);
  margin-bottom: 20px;
}

.bsc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.danger {
  color: var(--text-danger);
  border-color: color-mix(in srgb, var(--text-danger) 40%, var(--border-color));
}

.danger:hover {
  background: var(--danger-soft);
}
</style>
