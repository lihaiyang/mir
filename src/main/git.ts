import simpleGit, { SimpleGit } from 'simple-git'

export interface GitStatus {
  branch: string
  tracking: string | null
  ahead: number
  behind: number
  staged: string[]
  modified: string[]
  notAdded: string[]
  deleted: string[]
  renamed: { from: string; to: string }[]
  conflicted: string[]
  files: { path: string; index: string; working_dir: string }[]
}

export interface GitCommit {
  hash: string
  date: string
  message: string
  body: string
  author_name: string
  author_email: string
}

function git(cwd: string): SimpleGit {
  return simpleGit(cwd)
}

export async function runGitCommand(
  cwd: string,
  cmd: string,
  arg?: string
): Promise<unknown> {
  const g = git(cwd)
  switch (cmd) {
    case 'status': {
      const s = await g.status()
      return {
        branch: s.current,
        tracking: s.tracking,
        ahead: s.ahead,
        behind: s.behind,
        staged: s.staged,
        modified: s.modified,
        notAdded: s.not_added,
        deleted: s.deleted,
        renamed: s.renamed,
        conflicted: s.conflicted,
        files: s.files
      }
    }
    case 'log': {
      const l = await g.log({ maxCount: 20 })
      return l.all
    }
    case 'diff': {
      return arg ? g.diff([arg]) : g.diff()
    }
    case 'diffStaged': {
      return arg ? g.diff(['--cached', arg]) : g.diff(['--cached'])
    }
    case 'stage': {
      await g.add(arg!)
      return true
    }
    case 'stageAll': {
      await g.add('.')
      return true
    }
    case 'unstage': {
      await g.reset(['HEAD', arg!])
      return true
    }
    case 'commit': {
      await g.commit(arg!)
      return true
    }
    case 'pull': {
      const r = await g.pull()
      return r
    }
    case 'push': {
      const r = await g.push()
      return r
    }
    case 'fetch': {
      await g.fetch()
      return true
    }
    case 'branches': {
      const b = await g.branch()
      return { current: b.current, all: b.all }
    }
    case 'checkout': {
      await g.checkout(arg!)
      return true
    }
    case 'createBranch': {
      await g.checkoutLocalBranch(arg!)
      return true
    }
    case 'showFile': {
      // arg format: "ref:path" e.g. "HEAD:src/file.ts" or ":src/file.ts"
      const [ref, ...pathParts] = arg!.split(':')
      const filePath = pathParts.join(':')
      const refPath = `${ref}:${filePath}`
      try {
        return await g.show([refPath])
      } catch {
        return ''
      }
    }
    default:
      throw new Error(`Unknown git command: ${cmd}`)
  }
}
