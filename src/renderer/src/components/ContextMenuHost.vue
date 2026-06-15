<template>
  <Teleport to="body">
    <div
      v-if="menu.visible"
      class="context-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
    >
      <template v-for="item in menu.items" :key="item.label ?? '_sep'">
        <div v-if="item.separator" class="context-menu-sep" />
        <div
          v-else
          class="context-menu-item"
          :class="{ danger: item.danger, disabled: item.disabled }"
          @click="!item.disabled && execute(item)"
        >
          {{ item.label }}
        </div>
      </template>
    </div>
    <!-- click outside to close -->
    <div v-if="menu.visible" class="context-menu-backdrop" @click="close" @contextmenu.prevent="close" />
  </Teleport>
</template>

<script setup lang="ts">
import { useContextMenu } from '../composables/useContextMenu'
const { menu, close, execute } = useContextMenu()
</script>

<style scoped>
.context-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
}
.context-menu {
  z-index: 1000;
}
.context-menu-item.disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
