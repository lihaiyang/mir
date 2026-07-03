import { defineStore } from 'pinia'
import { ref } from 'vue'
import { toPlainObject } from '../utils'

export interface FileMetadata {
  path: string
  languageOverride?: string
  encoding?: string
  lineEnding?: 'lf' | 'crlf'
}

export const useFileMetaStore = defineStore('fileMeta', () => {
  const meta = ref<Record<string, FileMetadata>>({})

  async function load() {
    const stored = await window.electronAPI.storeGet('fileMetadata')
    if (stored && typeof stored === 'object') {
      meta.value = stored as Record<string, FileMetadata>
    }
  }

  async function persist() {
    await window.electronAPI.storeSet('fileMetadata', toPlainObject(meta.value))
  }

  function get(path: string): FileMetadata | undefined {
    return meta.value[path]
  }

  function set(path: string, patch: Partial<FileMetadata>) {
    const existing = meta.value[path] || { path }
    meta.value[path] = { ...existing, ...patch, path }
    persist()
  }

  return { meta, load, persist, get, set }
})
