<template>
  <div class="toast-host" aria-label="Notifications">
    <slot />
  </div>
</template>

<script setup lang="ts">
// Single fixed anchor for every transient surface (update banner + toasts) so
// they stack instead of overlapping. Children drop their own fixed offsets.
</script>

<style scoped>
.toast-host {
  position: fixed;
  right: var(--space-4);
  bottom: 40px;
  z-index: 4000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-2);
  pointer-events: none;
}
.toast-host > :deep(*) {
  pointer-events: auto;
}
</style>
