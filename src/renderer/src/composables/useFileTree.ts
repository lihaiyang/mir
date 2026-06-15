import { EXCLUDE_DIRS } from '../constants'

export interface FileNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileNode[]
  loaded?: boolean
}

function joinPath(parent: string, name: string): string {
  return parent.endsWith('/') ? parent + name : parent + '/' + name
}

export function useFileTree() {
  async function readDir(dirPath: string, showHidden = false): Promise<FileNode[]> {
    const entries = await window.electronAPI.readdir(dirPath)
    return entries
      .filter(e => !EXCLUDE_DIRS.has(e.name) && (showHidden || !e.name.startsWith('.')))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map(e => ({
        name: e.name,
        path: joinPath(dirPath, e.name),
        isDirectory: e.isDirectory
      }))
  }

  return { readDir, joinPath }
}
