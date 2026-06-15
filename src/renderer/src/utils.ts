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
