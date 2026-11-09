<template>
  <div class="chat-message" :class="`chat-message--${item.kind}`" :title="timeLabel">
    <!-- User message: right-aligned plain-text bubble -->
    <div v-if="item.kind === 'user'" class="user-row">
      <div class="user-bubble">{{ item.text }}</div>
    </div>

    <!-- Agent message: markdown, streamed -->
    <div v-else-if="item.kind === 'agent'" class="agent-row">
      <Icon name="robot" :size="14" class="agent-avatar" />
      <div class="agent-body">
        <div class="markdown" v-html="agentHtml" @click="onMarkdownClick" />
        <div v-if="truncated" class="truncated-row">
          <span class="truncated-text">{{ t('acp.chat.truncated', 'Message truncated for display') }}</span>
          <button class="link-btn" @click="showFull = true">
            {{ t('acp.chat.showFull', 'Show full message') }}
          </button>
        </div>
        <span v-if="item.streaming" class="stream-caret" aria-hidden="true" />
      </div>
    </div>

    <!-- Thought block: collapsible, muted, collapsed once finished -->
    <div v-else-if="item.kind === 'thought'" class="thought-row">
      <button class="thought-head" type="button" @click="expanded = !expanded">
        <span class="thought-chevron" :class="{ 'is-open': expanded }">
          <Icon name="chevron-right" :size="11" />
        </span>
        <span class="thought-label">{{ t('acp.chat.thinking', 'Thinking') }}</span>
        <span class="thought-meta">
          {{ t('acp.chat.thinkingChars', '{count} chars', { named: { count: item.text.length } }) }}
        </span>
      </button>
      <pre v-if="expanded" class="thought-body">{{ item.text }}</pre>
    </div>

    <!-- Notice: info / warn / error -->
    <div v-else-if="item.kind === 'notice'" class="notice-row" :class="`notice-row--${item.level}`">
      <Icon :name="noticeIcon" :size="13" class="notice-icon" />
      <span class="notice-text">{{ item.text }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import { useI18n } from 'vue-i18n'
import Icon from '../../ui/Icon.vue'
import { useTabStore } from '../../../stores/tabs'
import { useProjectStore } from '../../../stores/projects'
import { useAcpStore } from '../../../stores/acp'
import type { ChatItem } from '../../../stores/acp'
import { useSmoothReveal } from './useSmoothReveal'

const props = defineProps<{ item: ChatItem }>()

const { t } = useI18n()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const acpStore = useAcpStore()

/** Single renderer shared by every ChatMessage instance. */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

/** Very large messages are truncated until the user asks for the full text. */
const MAX_MESSAGE_CHARS = 200_000

const showFull = ref(false)
const expanded = ref(false)

/** Auto-expand while the thought is streaming, collapse once it is finished. */
watch(
  () => (props.item.kind === 'thought' ? props.item.streaming : false),
  (streaming) => {
    expanded.value = streaming
  },
  { immediate: true }
)

/** 全文（未展开），供渐进显示使用 */
const fullAgentText = computed(() => (props.item.kind === 'agent' ? props.item.text : ''))

/**
 * 平滑呈现：只在用户开启且本项是 agent 消息时生效。真正流式的 Agent 每次增量
 * 都很小，会原样透传；整段到达的 Agent 才会走打字机展开。
 */
const smoothEnabled = computed(() => props.item.kind === 'agent' && acpStore.config.smoothStreaming === true)

/**
 * 只有「本次回合刚产生」的消息才在挂载时补跑展开动画：
 * - `streaming` 说明还在写；`at` 在 2s 内兜住 prompt-end 抢先到达的情况。
 * - 历史回放 / 切换 Tab 重挂载的旧消息不会重播动画。
 */
const revealOnMount =
  props.item.kind === 'agent' &&
  props.item.replay !== true &&
  (props.item.streaming || Date.now() - props.item.at < 2000)
const { shown: revealedText } = useSmoothReveal(fullAgentText, smoothEnabled, {
  animateFirst: revealOnMount
})

const agentText = computed(() => {
  if (props.item.kind !== 'agent') return ''
  const text = revealedText.value
  if (showFull.value || text.length <= MAX_MESSAGE_CHARS) return text
  return text.slice(0, MAX_MESSAGE_CHARS)
})

const truncated = computed(() => props.item.kind === 'agent' && !showFull.value && props.item.text.length > MAX_MESSAGE_CHARS)

const agentHtml = computed(() => renderMarkdown(agentText.value))

const noticeIcon = computed(() => {
  if (props.item.kind !== 'notice') return 'info'
  if (props.item.level === 'warn') return 'alert-triangle'
  if (props.item.level === 'error') return 'x-circle'
  return 'info'
})

const timeLabel = computed(() => {
  try {
    return new Date(props.item.at).toLocaleTimeString()
  } catch {
    return ''
  }
})

function renderMarkdown(text: string): string {
  try {
    return md.render(text || '')
  } catch {
    return ''
  }
}

/**
 * Never navigate the renderer window from a chat link. HTTP(S) links open in a
 * MIR browser tab instead; other schemes are ignored.
 */
function onMarkdownClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  const anchor = target?.closest('a')
  if (!anchor) return
  const href = anchor.getAttribute('href') ?? ''
  event.preventDefault()
  if (!href.startsWith('http://') && !href.startsWith('https://')) return
  const project = projectStore.activeProject
  if (!project) return
  void tabStore.addTab(project.id, 'browser', { title: href, browserUrl: href })
}
</script>

<style scoped>
.chat-message {
  padding: var(--space-1) var(--space-4);
}

/* ── user ── */
.user-row {
  display: flex;
  justify-content: flex-end;
}
.user-bubble {
  max-width: 78%;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md) var(--radius-md) var(--radius-sm) var(--radius-md);
  color: var(--text-primary);
  font-size: var(--text-md);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── agent ── */
.agent-row {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
}
.agent-avatar {
  margin-top: 3px;
  color: var(--text-accent);
  opacity: 0.75;
}
.agent-body {
  flex: 1;
  min-width: 0;
  font-size: var(--text-md);
  line-height: 1.6;
  color: var(--text-primary);
}
.markdown {
  word-break: break-word;
}
.markdown :deep(p) { margin: 0.45em 0; }
.markdown :deep(p:first-child) { margin-top: 0; }
.markdown :deep(p:last-child) { margin-bottom: 0; }
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) { margin: 0.7em 0 0.35em; font-weight: 600; line-height: 1.3; }
.markdown :deep(h1) { font-size: var(--text-xl); }
.markdown :deep(h2) { font-size: var(--text-lg); }
.markdown :deep(h3) { font-size: var(--text-base); }
.markdown :deep(h4) { font-size: var(--text-md); }
.markdown :deep(ul),
.markdown :deep(ol) { margin: 0.45em 0; padding-left: 1.6em; }
.markdown :deep(ul) { list-style: disc; }
.markdown :deep(ol) { list-style: decimal; }
.markdown :deep(li) { margin: 0.15em 0; }
.markdown :deep(a) { color: var(--text-accent); text-decoration: none; cursor: pointer; }
.markdown :deep(a:hover) { text-decoration: underline; }
.markdown :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: var(--bg-tertiary);
  padding: 0.12em 0.32em;
  border-radius: 3px;
}
.markdown :deep(pre) {
  margin: 0.5em 0;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  overflow-x: auto;
}
.markdown :deep(pre code) { background: none; padding: 0; font-size: var(--text-sm); line-height: 1.5; }
.markdown :deep(blockquote) {
  margin: 0.5em 0;
  padding-left: var(--space-3);
  border-left: 2px solid var(--border-strong);
  color: var(--text-secondary);
}
.markdown :deep(table) { border-collapse: collapse; margin: 0.5em 0; width: 100%; }
.markdown :deep(th),
.markdown :deep(td) { border: 1px solid var(--border-color); padding: 4px 8px; text-align: left; font-size: var(--text-sm); }
.markdown :deep(th) { background: var(--bg-secondary); font-weight: 600; }
.markdown :deep(hr) { border: none; border-top: 1px solid var(--border-color); margin: 0.8em 0; }
.markdown :deep(img) { max-width: 100%; border-radius: var(--radius-sm); }

.stream-caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--text-accent);
  animation: caret-blink 1s steps(2, start) infinite;
}
@keyframes caret-blink {
  to { visibility: hidden; }
}

.truncated-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.link-btn {
  font-size: var(--text-xs);
  color: var(--text-accent);
  padding: 0;
}
.link-btn:hover { background: none; text-decoration: underline; }

/* ── thought ── */
.thought-row {
  padding: 2px 0;
}
.thought-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-1);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.thought-head:hover { color: var(--text-secondary); }
.thought-chevron {
  display: inline-flex;
  transition: transform var(--transition-fast) ease;
}
.thought-chevron.is-open { transform: rotate(90deg); }
.thought-label {
  font-weight: 500;
  letter-spacing: 0.02em;
}
.thought-meta {
  color: var(--text-faint);
  opacity: 0.75;
}
.thought-body {
  margin: var(--space-1) 0 var(--space-2) 18px;
  padding-left: var(--space-3);
  border-left: 1px solid var(--border-color);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.55;
  color: var(--text-faint);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow: auto;
}

/* ── notice ── */
.notice-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  line-height: 1.5;
}
.notice-row--info {
  color: var(--text-secondary);
  background: var(--bg-secondary);
}
.notice-row--warn {
  color: var(--text-warning);
  background: var(--bg-secondary);
}
.notice-row--error {
  color: var(--text-danger);
  background: var(--bg-secondary);
}
.notice-icon { margin-top: 1px; flex-shrink: 0; }
.notice-text { min-width: 0; white-space: pre-wrap; word-break: break-word; }
</style>
