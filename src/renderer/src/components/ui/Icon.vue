<template>
  <svg
    v-if="isSvg"
    class="mir-icon"
    :class="className"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="iconHtml"
  />
  <span v-else class="mir-icon-emoji" :class="className" :style="{ fontSize: size + 'px' }">{{ name }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { iconDefs, isIconName } from './icons'

const props = withDefaults(defineProps<{
  name: string
  size?: number | string
  className?: string
}>(), {
  size: 16,
  className: '',
  name: ''
})

const isSvg = computed(() => isIconName(props.name))
const iconHtml = computed(() => (isIconName(props.name) ? iconDefs[props.name as keyof typeof iconDefs] : ''))
</script>

<style scoped>
.mir-icon {
  display: inline-block;
  vertical-align: -0.125em;
  flex-shrink: 0;
}
.mir-icon-emoji {
  display: inline-block;
  line-height: 1;
  flex-shrink: 0;
}
</style>
