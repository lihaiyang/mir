import { toRaw } from 'vue'

export function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}

// Strip Vue reactivity proxies to get a plain JSON-serializable object
export function toPlainObject<T>(obj: T): T {
  return JSON.parse(JSON.stringify(toRaw(obj)))
}

export interface ParsedShortcut {
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string
}

export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split('+').map(p => p.trim().toLowerCase())
  const key = parts.pop() || ''
  return {
    ctrl: parts.includes('ctrl') || parts.includes('cmd') || parts.includes('command'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt') || parts.includes('option'),
    key
  }
}

export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const parsed = parseShortcut(shortcut)
  const mod = e.ctrlKey || e.metaKey
  if (parsed.ctrl !== mod) return false
  if (parsed.shift !== e.shiftKey) return false
  if (parsed.alt !== e.altKey) return false
  const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key
  return eventKey.toLowerCase() === parsed.key.toLowerCase()
}
