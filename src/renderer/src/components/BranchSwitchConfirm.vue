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
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}

.bsc-modal {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  width: 420px;
  padding: 20px;
}

.bsc-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 12px;
}

.bsc-message {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 20px;
}

.bsc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.danger {
  color: #f44747;
  border-color: rgba(244, 71, 71, 0.4);
}

.danger:hover {
  background: rgba(244, 71, 71, 0.1);
}
</style>
