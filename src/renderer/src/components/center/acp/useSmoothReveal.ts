/**
 * 让「整段到达」的回复看起来像是逐字流式输出。
 *
 * 背景：部分 Agent（典型是 DeepSeek Harness 的 ACP profile）按设计只在
 * assistant 消息提交后下发**一个** `agent_message_chunk`，协议里没有 token 增量。
 * MIR 无法凭空收到增量，所以这里做的是纯呈现层补偿：当某次文本追加的跨度
 * 超过阈值时，按打字机节奏把新增部分展开。
 *
 * 对真正流式的 Agent（每次追加几十字符以内，如 pi-acp）完全透明：小增量直接
 * 透传，不引入任何额外延迟。
 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/** 一次追加超过这么多字符，就视为「整段到达」而非流式增量 */
const BULK_JUMP = 48
/** 展开速度（字符/秒），长文本会更快，避免一屏文字要等很久 */
const CHARS_PER_SECOND = 110
const MIN_DURATION_MS = 240
const MAX_DURATION_MS = 1400

export interface SmoothRevealOptions {
  /**
   * 组件挂载时是否把「已经存在的整段文本」也当作刚到的新内容来展开。
   * 只应对**本次回合刚产生**的消息打开：历史回放/切换 Tab 重挂载时不展开。
   */
  animateFirst?: boolean
}

export interface SmoothReveal {
  /** 当前应当渲染的文本（动画过程中是全文的前缀） */
  shown: Ref<string>
  /** 跳过动画，立刻展示全文 */
  finish: () => void
}

export function useSmoothReveal(
  fullText: Ref<string>,
  enabled: Ref<boolean>,
  options: SmoothRevealOptions = {}
): SmoothReveal {
  /**
   * 关键点：整段到达的 Agent 只发一个 chunk，消息在创建时就带着全文。
   * 如果初始值直接取全文，watch 永远不会触发，动画也就不会发生。
   * 因此「刚产生的消息」先留空，挂载后立刻补跑一次展开动画。
   */
  const revealOnMount =
    enabled.value && options.animateFirst === true && fullText.value.length >= BULK_JUMP
  const shown = ref(revealOnMount ? '' : fullText.value)

  let frame = 0
  let from = 0
  let target = 0
  let startedAt = 0
  let duration = 0

  function cancel(): void {
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
    from = 0
    target = 0
  }

  function step(now: number): void {
    if (target === 0) {
      frame = 0
      return
    }
    const progress = duration <= 0 ? 1 : Math.min(1, (now - startedAt) / duration)
    // ease-out：开头稍快，收尾平稳
    const eased = 1 - (1 - progress) * (1 - progress)
    const length = from + Math.round((target - from) * eased)
    shown.value = fullText.value.slice(0, length)
    if (progress < 1) {
      frame = requestAnimationFrame(step)
    } else {
      frame = 0
      shown.value = fullText.value
    }
  }

  /** 从当前 shown 长度展开到全文 */
  function startReveal(): void {
    from = shown.value.length
    target = fullText.value.length
    if (target <= from) {
      shown.value = fullText.value
      return
    }
    startedAt = performance.now()
    const remaining = target - from
    duration = Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, (remaining / CHARS_PER_SECOND) * 1000))
    if (frame === 0) frame = requestAnimationFrame(step)
  }

  watch(
    fullText,
    (next) => {
      // 关闭开关、文本回退（重放/清空）、或本身就是小增量：直接透传
      if (!enabled.value || next.length <= shown.value.length) {
        cancel()
        shown.value = next
        return
      }

      const jump = next.length - shown.value.length
      if (jump < BULK_JUMP) {
        cancel()
        shown.value = next
        return
      }

      startReveal()
    },
    { flush: 'sync' }
  )

  watch(enabled, (on) => {
    if (!on) {
      cancel()
      shown.value = fullText.value
    }
  })

  onBeforeUnmount(cancel)

  if (revealOnMount) startReveal()

  return {
    shown,
    finish: () => {
      cancel()
      shown.value = fullText.value
    }
  }
}
