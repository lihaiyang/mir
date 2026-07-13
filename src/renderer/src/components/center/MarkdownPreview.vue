<template>
  <div class="md-preview-wrapper">
    <div class="md-preview" v-html="html" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import MarkdownIt from 'markdown-it'

const props = defineProps<{ content: string }>()

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false
})

const html = ref('')

function render() {
  try {
    html.value = md.render(props.content || '')
  } catch {
    html.value = '<p style="color:#e55">Render error</p>'
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(() => props.content, () => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(render, 100)
}, { immediate: false })

onMounted(() => {
  render()
})
</script>

<style scoped>
.md-preview-wrapper {
  height: 100%;
  overflow: auto;
  padding: 20px 24px;
  background: var(--bg-primary);
}
.md-preview {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary);
  max-width: 800px;
}
.md-preview :deep(h1) { font-size: 1.8em; font-weight: 700; margin: 0.8em 0 0.4em; border-bottom: 1px solid var(--border-color); padding-bottom: 0.2em; }
.md-preview :deep(h2) { font-size: 1.5em; font-weight: 700; margin: 0.8em 0 0.4em; border-bottom: 1px solid var(--border-color); padding-bottom: 0.2em; }
.md-preview :deep(h3) { font-size: 1.25em; font-weight: 700; margin: 0.8em 0 0.4em; }
.md-preview :deep(h4) { font-size: 1.1em; font-weight: 600; margin: 0.8em 0 0.4em; }
.md-preview :deep(h5) { font-size: 1em; font-weight: 600; margin: 0.8em 0 0.4em; }
.md-preview :deep(h6) { font-size: 0.9em; font-weight: 600; color: var(--text-secondary); margin: 0.8em 0 0.4em; }
.md-preview :deep(p) { margin: 0.6em 0; }
.md-preview :deep(a) { color: var(--text-accent); text-decoration: none; }
.md-preview :deep(a:hover) { text-decoration: underline; }
.md-preview :deep(strong) { font-weight: 700; }
.md-preview :deep(em) { font-style: italic; }
.md-preview :deep(del) { text-decoration: line-through; }
.md-preview :deep(ul) { list-style: disc; padding-left: 2em; margin: 0.6em 0; }
.md-preview :deep(ol) { list-style: decimal; padding-left: 2em; margin: 0.6em 0; }
.md-preview :deep(li) { margin: 0.2em 0; }
.md-preview :deep(li > ul, li > ol) { margin: 0.2em 0; }
.md-preview :deep(blockquote) {
  border-left: 3px solid var(--border-color);
  padding-left: 1em;
  margin: 0.8em 0;
  color: var(--text-secondary);
}
.md-preview :deep(code) {
  font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
  font-size: 0.85em;
  background: var(--bg-secondary);
  padding: 0.15em 0.35em;
  border-radius: 3px;
}
.md-preview :deep(pre) {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 12px 14px;
  overflow-x: auto;
  margin: 0.8em 0;
}
.md-preview :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 0.85em;
  line-height: 1.5;
}
.md-preview :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
}
.md-preview :deep(th) {
  border: 1px solid var(--border-color);
  padding: 6px 12px;
  font-weight: 600;
  background: var(--bg-secondary);
  text-align: left;
}
.md-preview :deep(td) {
  border: 1px solid var(--border-color);
  padding: 6px 12px;
}
.md-preview :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 1.2em 0;
}
.md-preview :deep(img) { max-width: 100%; border-radius: 4px; }
</style>
