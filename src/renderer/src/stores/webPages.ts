import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { toPlainObject } from '../utils'
import { useProjectStore } from './projects'

export interface WebPage {
  id: string
  title: string
  url: string
  baselineTitle: string
  hasNotification: boolean
  // Unread notification count shown as a badge on the left-pane row. Kept in
  // sync with `hasNotification` (hasNotification === unreadCount > 0) so older
  // code paths and persisted data keep working.
  unreadCount: number
  // Last document title observed for this page. Used to count notification
  // events on sites that do not put a number in the tab title, and to avoid
  // re-counting the same title on every title-updated event.
  lastObservedTitle: string
}

export const MAX_UNREAD = 999

// Sites that expose unread counts put them at the start ("(3) 微信", "[12]
// Slack"), at the end ("WhatsApp (3)") or in the middle ("收件箱 (3) - mail").
// Only explicit bracketed numbers are trusted: a bare leading number would
// false-positive on titles like "2024 年终总结", and the middle form is limited
// to two digits so years such as "(2024)" are not mistaken for counts.
const COUNT_PATTERNS: RegExp[] = [
  /^\s*[([{]\s*\d{1,3}\s*\+?\s*[)\]}]/,
  /[([{]\s*\d{1,3}\s*\+?\s*[)\]}]\s*$/,
  /(?:^|\s)[([{]\s*\d{1,2}\s*\+?\s*[)\]}](?=\s|$)/
]

function findCountMatch(title: string): RegExpExecArray | null {
  for (const pattern of COUNT_PATTERNS) {
    const match = pattern.exec(title)
    if (match) return match
  }
  return null
}

export function parseUnreadCount(title: string): number | null {
  const match = findCountMatch(title)
  if (!match) return null
  const digits = match[0].match(/\d+/)
  if (!digits) return null
  return Math.min(MAX_UNREAD, Number(digits[0]))
}

// Title with the unread count removed, so a page that cleared its own counter
// ("(3) 微信" → "微信") can be compared against the read baseline.
export function stripUnreadCount(title: string): string {
  const match = findCountMatch(title)
  if (!match) return title.trim()
  // Replace the count (which may include one leading space) with a space, so
  // "收件箱 (3) - mail" normalizes to "收件箱 - mail" and compares equal to the
  // read baseline instead of collapsing into "收件箱- mail".
  const stripped = title.slice(0, match.index) + ' ' + title.slice(match.index + match[0].length)
  return stripped.replace(/\s+/g, ' ').trim()
}

// Navigation bus: TitleBar writes commands, BrowserTab reads state
export interface NavBus {
  // BrowserTab → TitleBar (current state)
  url: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  // TitleBar → BrowserTab (command to execute, cleared after read)
  cmd: 'back' | 'forward' | 'reload' | 'navigate' | 'devtools' | null
  cmdUrl: string  // used when cmd === 'navigate'
}

export const standaloneNavBus = reactive<NavBus>({
  url: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  cmd: null,
  cmdUrl: ''
})

export const useWebPageStore = defineStore('webPages', () => {
  const webPages = ref<WebPage[]>([])
  const selectedWebPageId = ref<string | null>(null)

  function getProjectStore() {
    return useProjectStore()
  }

  async function load() {
    const stored = await window.electronAPI.storeGet('webPages')
    if (Array.isArray(stored)) {
      // Normalize: pages saved before unread counts existed only carry the
      // boolean, so turn it into a badge count of 1.
      webPages.value = (stored as WebPage[]).map(p => {
        const count = typeof p.unreadCount === 'number' && p.unreadCount > 0
          ? Math.floor(p.unreadCount)
          : (p.hasNotification ? 1 : 0)
        return {
          ...p,
          unreadCount: count,
          hasNotification: count > 0,
          lastObservedTitle: typeof p.lastObservedTitle === 'string' ? p.lastObservedTitle : p.baselineTitle
        }
      })
    }
    const sid = await window.electronAPI.storeGet('selectedWebPageId')
    if (typeof sid === 'string') selectedWebPageId.value = sid
    // Ensure all web pages are in itemOrder
    const ps = getProjectStore()
    for (const wp of webPages.value) {
      const key = 'webpage:' + wp.id
      if (!ps.itemOrder.includes(key)) {
        ps.addToOrder(key)
      }
    }
  }

  async function persist() {
    await window.electronAPI.storeSet('webPages', toPlainObject(webPages.value))
    await window.electronAPI.storeSet('selectedWebPageId', selectedWebPageId.value)
  }

  async function addWebPage(url: string, title: string) {
    const wp: WebPage = {
      id: uuidv4(),
      title,
      url,
      baselineTitle: title,
      hasNotification: false,
      unreadCount: 0,
      lastObservedTitle: title
    }
    webPages.value.push(wp)
    getProjectStore().addToOrder('webpage:' + wp.id)
    await persist()
    return wp
  }

  async function removeWebPage(id: string) {
    const idx = webPages.value.findIndex(w => w.id === id)
    if (idx === -1) return
    webPages.value.splice(idx, 1)
    if (selectedWebPageId.value === id) {
      selectedWebPageId.value = null
    }
    getProjectStore().removeFromOrder('webpage:' + id)
    await persist()
  }

  async function renameWebPage(id: string, newTitle: string) {
    const w = webPages.value.find(w => w.id === id)
    if (w) { w.title = newTitle; await persist() }
  }

  async function selectWebPage(id: string | null) {
    selectedWebPageId.value = id
    await persist()
  }

  async function setUnread(id: string, count: number) {
    const w = webPages.value.find(w => w.id === id)
    if (!w) return
    const next = Math.max(0, Math.min(MAX_UNREAD, Math.round(count)))
    const changed = w.unreadCount !== next || w.hasNotification !== (next > 0)
    w.unreadCount = next
    w.hasNotification = next > 0
    if (changed) await persist()
  }

  async function markAsRead(id: string) {
    const w = webPages.value.find(w => w.id === id)
    if (!w) return
    // Align the read baseline with the last title we actually saw, so a page
    // that is not open (no tab to read the current title from) does not
    // re-arm the badge with the title the user just acknowledged.
    w.baselineTitle = w.lastObservedTitle || w.baselineTitle
    w.unreadCount = 0
    w.hasNotification = false
    await persist()
  }

  // Kept for callers that only know whether a page is notifying.
  async function setNotification(id: string, active: boolean) {
    const w = webPages.value.find(w => w.id === id)
    if (!w) return
    await setUnread(id, active ? Math.max(1, w.unreadCount) : 0)
  }

  // A browser tab reported a new document title. Sites with an explicit count
  // in the title ("(3) 微信", "收件箱 (3) - mail") drive the badge directly; a
  // page that dropped its own count is treated as read again; anything else
  // only has to raise the badge to "there is something new", because titles
  // that change on a timer or progress indicator must not inflate the number.
  async function noteTitle(id: string, title: string) {
    const w = webPages.value.find(w => w.id === id)
    if (!w || !title) return
    if (w.lastObservedTitle === title) return
    w.lastObservedTitle = title
    const parsed = parseUnreadCount(title)
    if (parsed !== null) {
      await setUnread(id, parsed)
      return
    }
    if (stripUnreadCount(title) === stripUnreadCount(w.baselineTitle)) {
      await setUnread(id, 0)
      return
    }
    await setUnread(id, Math.max(1, w.unreadCount || 0))
  }

  async function updateBaselineTitle(id: string, newBaseline: string) {
    const w = webPages.value.find(w => w.id === id)
    if (!w) return
    w.baselineTitle = newBaseline
    w.lastObservedTitle = newBaseline
    await persist()
  }

  return {
    webPages, selectedWebPageId,
    load, persist, addWebPage, removeWebPage,
    renameWebPage, selectWebPage, markAsRead,
    setNotification, setUnread, noteTitle, updateBaselineTitle
  }
})
