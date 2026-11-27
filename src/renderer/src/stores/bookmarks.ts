import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { toPlainObject } from '../utils'

export interface BookmarkItem {
  id: string
  title: string
  url: string
  favicon?: string
  folder?: string
  createdAt?: number
}

export const useBookmarkStore = defineStore('bookmarks', () => {
  const bookmarks = ref<BookmarkItem[]>([])
  const loaded = ref(false)

  const folders = computed<string[]>(() => {
    const set = new Set<string>()
    for (const b of bookmarks.value) {
      const f = b.folder?.trim()
      if (f) set.add(f)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  async function load() {
    if (loaded.value) return
    const stored = await window.electronAPI.storeGet('bookmarks')
    if (Array.isArray(stored)) {
      let migrated = false
      bookmarks.value = stored
        .filter((item: any) => item && typeof item.url === 'string' && item.url.trim())
        .map((item: any) => {
          if (!item.id) migrated = true
          return {
            id: item.id || uuidv4(),
            title: typeof item.title === 'string' && item.title.trim() ? item.title : item.url,
            url: item.url.trim(),
            favicon: typeof item.favicon === 'string' ? item.favicon : undefined,
            folder: typeof item.folder === 'string' && item.folder.trim() ? item.folder.trim() : undefined,
            createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now()
          }
        })
      if (migrated) await persist()
    }
    loaded.value = true
  }

  async function persist() {
    await window.electronAPI.storeSet('bookmarks', toPlainObject(bookmarks.value))
  }

  function findByUrl(url: string): BookmarkItem | undefined {
    const u = url.trim()
    return bookmarks.value.find(b => b.url === u)
  }

  function isBookmarked(url: string): boolean {
    return !!findByUrl(url)
  }

  function addBookmark(input: {
    title: string
    url: string
    favicon?: string
    folder?: string
  }): BookmarkItem {
    const url = input.url.trim()
    const existing = findByUrl(url)
    if (existing) {
      if (input.title.trim()) existing.title = input.title.trim()
      if (input.favicon) existing.favicon = input.favicon
      if (input.folder !== undefined) {
        existing.folder = input.folder.trim() || undefined
      }
      void persist()
      return existing
    }
    let title = input.title.trim()
    if (!title) {
      try { title = new URL(url).hostname || url } catch { title = url }
    }
    const item: BookmarkItem = {
      id: uuidv4(),
      title,
      url,
      favicon: input.favicon,
      folder: input.folder?.trim() || undefined,
      createdAt: Date.now()
    }
    bookmarks.value.push(item)
    void persist()
    return item
  }

  function updateBookmark(id: string, patch: Partial<Omit<BookmarkItem, 'id'>>) {
    const item = bookmarks.value.find(b => b.id === id)
    if (!item) return
    if (patch.title !== undefined) item.title = patch.title.trim() || item.url
    if (patch.url !== undefined) item.url = patch.url.trim()
    if (patch.favicon !== undefined) item.favicon = patch.favicon
    if (patch.folder !== undefined) item.folder = patch.folder.trim() || undefined
    void persist()
  }

  function removeBookmark(id: string) {
    const idx = bookmarks.value.findIndex(b => b.id === id)
    if (idx === -1) return
    bookmarks.value.splice(idx, 1)
    void persist()
  }

  function removeByUrl(url: string) {
    const u = url.trim()
    const next = bookmarks.value.filter(b => b.url !== u)
    if (next.length !== bookmarks.value.length) {
      bookmarks.value = next
      void persist()
    }
  }

  function reorderBookmarks(fromId: string, toId: string) {
    if (fromId === toId) return
    const fromIdx = bookmarks.value.findIndex(b => b.id === fromId)
    const toIdx = bookmarks.value.findIndex(b => b.id === toId)
    if (fromIdx === -1 || toIdx === -1) return
    const [moved] = bookmarks.value.splice(fromIdx, 1)
    bookmarks.value.splice(toIdx, 0, moved)
    void persist()
  }

  return {
    bookmarks,
    folders,
    load,
    persist,
    findByUrl,
    isBookmarked,
    addBookmark,
    updateBookmark,
    removeBookmark,
    removeByUrl,
    reorderBookmarks
  }
})
