import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface StatusBarInfo {
  language: string
  encoding: string
  lineEnding: string
  cursorLine: number
  cursorColumn: number
  hasEditor: boolean
  gitBranch: string | null
  gitAhead: number
  gitBehind: number
}

export const useStatusBarStore = defineStore('statusBar', () => {
  const info = ref<StatusBarInfo>({
    language: '',
    encoding: 'UTF-8',
    lineEnding: 'LF',
    cursorLine: 1,
    cursorColumn: 1,
    hasEditor: false,
    gitBranch: null,
    gitAhead: 0,
    gitBehind: 0,
  })

  function update(patch: Partial<StatusBarInfo>) {
    Object.assign(info.value, patch)
  }

  function setCursor(line: number, column: number) {
    info.value.cursorLine = line
    info.value.cursorColumn = column
  }

  function setEditorActive(active: boolean, language = '') {
    info.value.hasEditor = active
    if (language) info.value.language = language
  }

  function setGitInfo(branch: string | null, ahead = 0, behind = 0) {
    info.value.gitBranch = branch
    info.value.gitAhead = ahead
    info.value.gitBehind = behind
  }

  return { info, update, setCursor, setEditorActive, setGitInfo }
})
