<template>
  <div v-if="open" class="modal-overlay" @click.self="onCancel" @keydown.esc="onCancel">
    <div class="modal" role="dialog" aria-modal="true" :aria-label="title">
      <div class="modal-title">{{ title }}</div>
      <input
        ref="inputEl"
        v-model="value"
        class="prompt-input"
        :placeholder="placeholder"
        :aria-label="title"
        @keydown.enter.prevent="onConfirm"
        @keydown.esc.prevent="onCancel"
      />
      <div class="modal-actions">
        <button class="btn-secondary" @click="onCancel">{{ t('common.cancel') }}</button>
        <button class="btn-primary" @click="onConfirm">{{ confirmText }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    placeholder?: string
    initialValue?: string
    confirmText?: string
  }>(),
  { placeholder: '', initialValue: '', confirmText: '' }
)

const emit = defineEmits<{
  (e: 'confirm', value: string): void
  (e: 'cancel'): void
}>()

const value = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    value.value = props.initialValue
    await nextTick()
    inputEl.value?.focus()
    inputEl.value?.select()
  },
  { immediate: true }
)

function onConfirm() {
  const v = value.value.trim()
  if (!v) return
  emit('confirm', v)
}

function onCancel() {
  emit('cancel')
}
</script>

<style scoped>
.prompt-input {
  width: 100%;
}
</style>
