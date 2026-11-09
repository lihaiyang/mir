<template>
  <div class="tool-card" :class="`tool-card--${status}`">
    <button class="tool-head" type="button" @click="toggle">
      <span class="tool-chevron" :class="{ 'is-open': expanded }">
        <Icon name="chevron-right" :size="11" />
      </span>
      <Icon :name="kindIcon" :size="13" class="tool-kind" />
      <span class="tool-title" :title="title">{{ title }}</span>
      <span class="tool-status" :class="`tool-status--${status}`">
        <Icon
          :name="statusIcon"
          :size="12"
          :class-name="status === 'in_progress' ? 'spin' : undefined"
        />
        <span class="tool-status-label">{{ statusLabel }}</span>
      </span>
    </button>

    <div v-if="expanded" class="tool-body">
      <div v-if="!blocks.length && !locations.length && !hasRaw" class="tool-empty">
        {{ t('acp.tool.noDetails', 'No details available for this tool call') }}
      </div>

      <template v-for="(block, index) in blocks" :key="index">
        <!-- plain text content -->
        <div v-if="block.type === 'text'" class="tool-block">
          <div class="tool-text" v-html="block.html" />
        </div>

        <!-- resource link -->
        <div v-else-if="block.type === 'resource'" class="tool-block tool-resource">
          <Icon name="file" :size="12" />
          <span class="tool-resource-name">{{ block.name }}</span>
          <span class="tool-resource-uri">{{ block.uri }}</span>
        </div>

        <!-- diff -->
        <div v-else-if="block.type === 'diff'" class="tool-block tool-diff">
          <div class="tool-diff-head">
            <Icon name="diff" :size="12" />
            <span class="tool-diff-path" :title="block.path">{{ block.path }}</span>
            <button
              class="tool-diff-open"
              type="button"
              :title="t('acp.tool.openFile', 'Open file')"
              @click="openFile(block.path)"
            >
              <Icon name="external-link" :size="11" />
            </button>
          </div>
          <pre class="tool-diff-body"><code><span
            v-for="(row, rowIndex) in block.rows"
            :key="rowIndex"
            class="diff-line"
            :class="`diff-line--${row.kind}`"
          >{{ row.prefix }}{{ row.text }}</span></code></pre>
          <div v-if="block.truncated" class="tool-diff-more">
            {{ t('acp.tool.diffTruncated', 'Diff truncated (first {count} lines)', { named: { count: MAX_DIFF_LINES } }) }}
          </div>
        </div>

        <!-- terminal -->
        <div v-else-if="block.type === 'terminal'" class="tool-block tool-terminal">
          <div class="tool-terminal-head">
            <Icon name="terminal" :size="12" />
            <span class="tool-terminal-id">{{ block.terminalId }}</span>
          </div>
          <pre v-if="block.output" class="tool-terminal-out">{{ block.output }}</pre>
        </div>

        <!-- anything else -->
        <div v-else class="tool-block tool-empty">
          {{ t('acp.tool.unsupportedContent', 'Unsupported content: {type}', { named: { type: block.contentType } }) }}
        </div>
      </template>

      <!-- file locations -->
      <div v-if="locations.length" class="tool-locations">
        <button
          v-for="(location, index) in locations"
          :key="`${location.path}:${location.line ?? 0}:${index}`"
          class="location-chip"
          type="button"
          :title="locationTitle(location)"
          @click="openLocation(location)"
        >
          <Icon name="file-text" :size="11" />
          <span class="location-name">{{ basename(location.path) }}</span>
          <span v-if="location.line" class="location-line">{{ location.line }}</span>
        </button>
      </div>

      <!-- raw payloads -->
      <div v-if="hasRaw" class="tool-raw">
        <button class="tool-raw-toggle" type="button" @click="rawExpanded = !rawExpanded">
          <span class="tool-chevron" :class="{ 'is-open': rawExpanded }">
            <Icon name="chevron-right" :size="10" />
          </span>
          <span>{{ t('acp.tool.raw', 'Raw payload') }}</span>
        </button>
        <div v-if="rawExpanded" class="tool-raw-body">
          <div v-if="rawInputText" class="tool-raw-section">
            <div class="tool-raw-label">{{ t('acp.tool.rawInput', 'Input') }}</div>
            <pre class="tool-raw-pre">{{ rawInputText }}</pre>
          </div>
          <div v-if="rawOutputText" class="tool-raw-section">
            <div class="tool-raw-label">{{ t('acp.tool.rawOutput', 'Output') }}</div>
            <pre class="tool-raw-pre">{{ rawOutputText }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownIt from 'markdown-it'
import { useI18n } from 'vue-i18n'
import Icon from '../../ui/Icon.vue'
import { useTabStore } from '../../../stores/tabs'
import { useProjectStore } from '../../../stores/projects'
import type { ToolCall } from '@shared/acp'

type ToolContent = NonNullable<ToolCall['content']>[number]
type ToolLocation = NonNullable<ToolCall['locations']>[number]
type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'
type DiffRow = { kind: 'add' | 'del'; prefix: string; text: string }

/** Flattened, template-friendly view of a protocol content block. */
type RenderBlock =
  | { type: 'text'; html: string }
  | { type: 'resource'; name: string; uri: string }
  | { type: 'diff'; path: string; rows: DiffRow[]; truncated: boolean }
  | { type: 'terminal'; terminalId: string; output: string }
  | { type: 'unsupported'; contentType: string }

const props = defineProps<{ toolCall: ToolCall }>()

const { t } = useI18n()
const tabStore = useTabStore()
const projectStore = useProjectStore()

/** Shared markdown renderer for tool text blocks (safe options only). */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

const MAX_DIFF_LINES = 400
const MAX_RAW_CHARS = 20_000

const manualToggle = ref<boolean | null>(null)
const rawExpanded = ref(false)

const status = computed<ToolStatus>(() => props.toolCall.status ?? 'pending')

/** Expanded while the call is active; an explicit user toggle wins afterwards. */
const expanded = computed(() => {
  if (manualToggle.value !== null) return manualToggle.value
  return status.value === 'pending' || status.value === 'in_progress'
})

const title = computed(() => props.toolCall.title || t('acp.tool.untitled', 'Tool call'))

const hasRaw = computed(
  () => props.toolCall.rawInput !== undefined || props.toolCall.rawOutput !== undefined
)

const locations = computed<ToolLocation[]>(() => props.toolCall.locations ?? [])

const rawInputText = computed(() => rawText(props.toolCall.rawInput))
const rawOutputText = computed(() => rawText(props.toolCall.rawOutput))

const blocks = computed<RenderBlock[]>(() =>
  (props.toolCall.content ?? []).map((block) => toRenderBlock(block, props.toolCall.rawOutput))
)

const statusIcon = computed(() => {
  switch (status.value) {
    case 'completed':
      return 'check-circle'
    case 'failed':
      return 'x-circle'
    default:
      return 'rotate'
  }
})

const statusLabel = computed(() => {
  switch (status.value) {
    case 'in_progress':
      return t('acp.tool.status.inProgress', 'Running')
    case 'completed':
      return t('acp.tool.status.completed', 'Done')
    case 'failed':
      return t('acp.tool.status.failed', 'Failed')
    default:
      return t('acp.tool.status.pending', 'Pending')
  }
})

const kindIcon = computed(() => {
  switch (props.toolCall.kind) {
    case 'read':
      return 'file-text'
    case 'edit':
      return 'wrench'
    case 'delete':
      return 'trash'
    case 'move':
      return 'arrow-right'
    case 'search':
      return 'search'
    case 'execute':
      return 'terminal'
    case 'think':
      return 'robot'
    case 'fetch':
      return 'download'
    case 'switch_mode':
      return 'refresh'
    default:
      return 'more'
  }
})

function toRenderBlock(block: ToolContent, rawOutput: unknown): RenderBlock {
  if (block.type === 'content') {
    const content = block.content
    if (content.type === 'text') {
      return { type: 'text', html: renderMarkdown(content.text) }
    }
    if (content.type === 'resource_link') {
      return { type: 'resource', name: content.name, uri: content.uri }
    }
    return { type: 'unsupported', contentType: content.type }
  }
  if (block.type === 'diff') {
    const oldText = block.oldText ?? ''
    const rows = diffRows(oldText, block.newText)
    return {
      type: 'diff',
      path: block.path,
      rows,
      truncated: splitLines(oldText).length + splitLines(block.newText).length > MAX_DIFF_LINES
    }
  }
  if (block.type === 'terminal') {
    return { type: 'terminal', terminalId: block.terminalId, output: rawText(rawOutput) }
  }
  return { type: 'unsupported', contentType: 'unknown' }
}

function toggle(): void {
  manualToggle.value = !expanded.value
}

function renderMarkdown(text: string): string {
  try {
    return md.render(text || '')
  } catch {
    return ''
  }
}

/** Old lines as deletions then new lines as additions — a simple, library-free diff. */
function diffRows(oldText: string, newText: string): DiffRow[] {
  const rows: DiffRow[] = []
  const push = (kind: 'add' | 'del', text: string): void => {
    if (rows.length >= MAX_DIFF_LINES) return
    rows.push({ kind, prefix: kind === 'add' ? '+' : '-', text })
  }
  for (const line of splitLines(oldText)) push('del', line)
  for (const line of splitLines(newText)) push('add', line)
  return rows
}

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  // A trailing newline should not render as a phantom empty line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function rawText(value: unknown): string {
  if (value === undefined || value === null) return ''
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  if (text.length <= MAX_RAW_CHARS) return text
  return `${text.slice(0, MAX_RAW_CHARS)}\n… ${t('acp.tool.truncated', 'truncated')}`
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

function locationTitle(location: ToolLocation): string {
  return location.line ? `${location.path}:${location.line}` : location.path
}

function openLocation(location: ToolLocation): void {
  openFile(location.path, location.line ?? undefined)
}

function openFile(path: string, line?: number): void {
  const project = projectStore.activeProject
  if (!project) return
  void tabStore.addTab(project.id, 'file', {
    title: basename(path) || path,
    filePath: path,
    fileLine: line
  })
}
</script>

<style scoped>
.tool-card {
  margin: var(--space-1) var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  overflow: hidden;
}
.tool-card--failed {
  border-color: color-mix(in srgb, var(--text-danger) 35%, var(--border-color));
}

.tool-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 5px var(--space-3);
  border-radius: 0;
  text-align: left;
  color: var(--text-primary);
}
.tool-head:hover { background: var(--bg-hover); }

.tool-chevron {
  display: inline-flex;
  color: var(--text-faint);
  transition: transform var(--transition-fast) ease;
  flex-shrink: 0;
}
.tool-chevron.is-open { transform: rotate(90deg); }

.tool-kind { color: var(--text-secondary); flex-shrink: 0; }

.tool-title {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: var(--text-xs);
}
.tool-status--pending { color: var(--text-faint); }
.tool-status--in_progress { color: var(--text-accent); }
.tool-status--completed { color: var(--text-success); }
.tool-status--failed { color: var(--text-danger); }

.spin { animation: spin 1.1s linear infinite; }
@keyframes spin {
  to { transform: rotate(360deg); }
}

.tool-body {
  padding: 0 var(--space-3) var(--space-2);
  border-top: 1px solid var(--border-color);
}

.tool-block { margin-top: var(--space-2); }

.tool-text {
  font-size: var(--text-sm);
  line-height: 1.55;
  color: var(--text-secondary);
  word-break: break-word;
}
.tool-text :deep(p) { margin: 0.35em 0; }
.tool-text :deep(p:first-child) { margin-top: 0; }
.tool-text :deep(p:last-child) { margin-bottom: 0; }
.tool-text :deep(pre) {
  margin: 0.4em 0;
  padding: var(--space-2);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  overflow-x: auto;
}
.tool-text :deep(code) {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.tool-text :deep(ul),
.tool-text :deep(ol) { margin: 0.35em 0; padding-left: 1.5em; }
.tool-text :deep(ul) { list-style: disc; }
.tool-text :deep(ol) { list-style: decimal; }

.tool-resource {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  min-width: 0;
}
.tool-resource-name { font-weight: 500; color: var(--text-primary); }
.tool-resource-uri {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-empty {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-faint);
}

/* diff */
.tool-diff {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.tool-diff-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px var(--space-2);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.tool-diff-path {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-diff-open {
  display: inline-flex;
  padding: 2px;
  color: var(--text-faint);
}
.tool-diff-open:hover { color: var(--text-accent); }

.tool-diff-body {
  margin: 0;
  padding: var(--space-1) 0;
  max-height: 320px;
  overflow: auto;
  background: var(--bg-primary);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.5;
}
.diff-line { display: block; padding: 0 var(--space-2); white-space: pre-wrap; word-break: break-all; }
.diff-line--del { color: var(--text-danger); background: color-mix(in srgb, var(--text-danger) 8%, transparent); }
.diff-line--add { color: var(--text-success); background: color-mix(in srgb, var(--text-success) 8%, transparent); }
.tool-diff-more {
  padding: 4px var(--space-2);
  background: var(--bg-tertiary);
  font-size: var(--text-xs);
  color: var(--text-faint);
}

/* terminal */
.tool-terminal {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.tool-terminal-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px var(--space-2);
  background: var(--bg-tertiary);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
.tool-terminal-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-terminal-out {
  margin: 0;
  padding: var(--space-2);
  max-height: 220px;
  overflow: auto;
  background: var(--bg-primary);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* locations */
.tool-locations {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-2);
}
.location-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 260px;
  padding: 2px 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
}
.location-chip:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}
.location-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.location-line {
  color: var(--text-faint);
  font-family: var(--font-mono);
}

/* raw payload */
.tool-raw { margin-top: var(--space-2); }
.tool-raw-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.tool-raw-toggle:hover { color: var(--text-secondary); }
.tool-raw-body { margin-top: var(--space-1); }
.tool-raw-section + .tool-raw-section { margin-top: var(--space-2); }
.tool-raw-label {
  font-size: var(--text-xs);
  color: var(--text-faint);
  margin-bottom: 2px;
}
.tool-raw-pre {
  margin: 0;
  padding: var(--space-2);
  max-height: 200px;
  overflow: auto;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.45;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
