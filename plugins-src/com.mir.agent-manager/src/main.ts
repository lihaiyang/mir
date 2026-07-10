import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import type { MainPluginApi, SkillInfo, ReadConfigResult } from './types'

const execAsync = promisify(execFile)

function getConfigPaths(agent: string, home: string, projectPath?: string): Array<{ key: string; path: string }> {
  if (agent === 'opencode') {
    const paths = [
      { key: 'global', path: join(home, '.config/opencode/opencode.json') }
    ]
    if (projectPath) {
      paths.push({ key: 'project', path: join(projectPath, '.opencode/opencode.json') })
    }
    return paths
  }
  if (agent === 'pi') {
    return [
      { key: 'models', path: join(home, '.pi/agent/models.json') },
      { key: 'settings', path: join(home, '.pi/agent/settings.json') }
    ]
  }
  return []
}

function safeWrite(filePath: string, content: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, filePath)
}

function parseSkillFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return { name: '', description: '' }
  const fm = match[1]
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ''
  return { name, description }
}

function computeFolderHash(dir: string): string {
  const hash = createHash('sha1')
  function walk(d: string) {
    for (const entry of readdirSync(d).sort()) {
      const full = join(d, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else {
        hash.update(entry)
        hash.update(readFileSync(full))
      }
    }
  }
  walk(dir)
  return hash.digest('hex')
}

function getSkillsDir(home: string): string {
  return join(home, '.agents/skills')
}

function getSkillLockPath(home: string): string {
  return join(home, '.agents/.skill-lock.json')
}

function readSkillLock(home: string): Record<string, any> {
  const p = getSkillLockPath(home)
  if (!existsSync(p)) return { version: 3, skills: {}, dismissed: {}, lastSelectedAgents: [] }
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return { version: 3, skills: {}, dismissed: {} } }
}

function writeSkillLock(home: string, data: Record<string, any>): void {
  safeWrite(getSkillLockPath(home), JSON.stringify(data, null, 2))
}

export function activate(api: MainPluginApi): void {
  const home = api.paths.home

  api.ipc.registerHandler('read-config', (agent: string, scope: string, projectPath?: string): ReadConfigResult => {
    const paths = getConfigPaths(agent, home, projectPath)
    const target = paths.find(p => p.key === scope)
    if (!target) return { path: '', content: '', exists: false }
    if (!existsSync(target.path)) return { path: target.path, content: '', exists: false }
    return { path: target.path, content: readFileSync(target.path, 'utf-8'), exists: true }
  })

  api.ipc.registerHandler('write-config', (agent: string, scope: string, content: string, projectPath?: string): boolean => {
    const paths = getConfigPaths(agent, home, projectPath)
    const target = paths.find(p => p.key === scope)
    if (!target) return false
    safeWrite(target.path, content)
    return true
  })

  api.ipc.registerHandler('list-skills', (): SkillInfo[] => {
    const skillsDir = getSkillsDir(home)
    if (!existsSync(skillsDir)) return []
    const lock = readSkillLock(home)
    const lockSkills = lock.skills || {}
    const result: SkillInfo[] = []

    for (const entry of readdirSync(skillsDir)) {
      const skillDir = join(skillsDir, entry)
      if (!statSync(skillDir).isDirectory()) continue
      const skillMdPath = join(skillDir, 'SKILL.md')
      if (!existsSync(skillMdPath)) continue
      const content = readFileSync(skillMdPath, 'utf-8')
      const { name, description } = parseSkillFrontmatter(content)
      const lockEntry = lockSkills[name || entry]
      result.push({
        name: name || entry,
        description,
        dir: skillDir,
        skillMdPath,
        source: lockEntry ? {
          type: 'github' as const,
          repo: lockEntry.source || '',
          url: lockEntry.sourceUrl || '',
          skillPath: lockEntry.skillPath
        } : undefined,
        installedAt: lockEntry?.installedAt,
        updatedAt: lockEntry?.updatedAt,
        folderHash: lockEntry?.skillFolderHash
      })
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  })

  api.ipc.registerHandler('read-skill', (name: string): string => {
    const skillMdPath = join(getSkillsDir(home), name, 'SKILL.md')
    if (!existsSync(skillMdPath)) return ''
    return readFileSync(skillMdPath, 'utf-8')
  })

  api.ipc.registerHandler('install-skill', async (repoUrl: string, skillPath?: string): Promise<{ success: boolean; error?: string; name?: string }> => {
    const tmpDir = join(api.paths.userData, '.tmp-skill-install-' + Date.now())
    try {
      // Clone the repo shallowly
      await execAsync('git', ['clone', '--depth', '1', repoUrl, tmpDir])

      // Find the skill directory
      let skillDir = tmpDir
      if (skillPath) {
        skillDir = join(tmpDir, skillPath)
      } else {
        // Try skills/<name>/ or root
        const skillsSubdir = join(tmpDir, 'skills')
        if (existsSync(skillsSubdir)) {
          const entries = readdirSync(skillsSubdir).filter(e => statSync(join(skillsSubdir, e)).isDirectory())
          if (entries.length === 1) {
            skillDir = join(skillsSubdir, entries[0])
          } else if (entries.length > 1) {
            return { success: false, error: `Multiple skills found: ${entries.join(', ')}. Please specify skillPath.` }
          }
        }
      }

      const skillMdPath = join(skillDir, 'SKILL.md')
      if (!existsSync(skillMdPath)) {
        return { success: false, error: 'SKILL.md not found in repository' }
      }

      const content = readFileSync(skillMdPath, 'utf-8')
      const { name } = parseSkillFrontmatter(content)
      const skillName = name || skillDir.split('/').pop() || 'unknown'

      // Copy to skills directory
      const destDir = join(getSkillsDir(home), skillName)
      if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
      mkdirSync(destDir, { recursive: true })

      // Recursively copy
      function copyDir(src: string, dest: string) {
        for (const entry of readdirSync(src)) {
          const srcPath = join(src, entry)
          const destPath = join(dest, entry)
          if (statSync(srcPath).isDirectory()) {
            mkdirSync(destPath, { recursive: true })
            copyDir(srcPath, destPath)
          } else {
            // Skip .git contents
            if (entry === '.git') continue
            const content = readFileSync(srcPath)
            writeFileSync(destPath, content)
          }
        }
      }
      copyDir(skillDir, destDir)

      // Update lock file
      const lock = readSkillLock(home)
      const repoMatch = repoUrl.match(/github\.com[/:]([\w-]+\/[\w-]+)(\.git)?$/)
      const repo = repoMatch?.[1] || repoUrl
      lock.skills = lock.skills || {}
      lock.skills[skillName] = {
        source: repo,
        sourceType: 'github',
        sourceUrl: repoUrl,
        skillPath: skillPath || `skills/${skillName}/SKILL.md`,
        skillFolderHash: computeFolderHash(destDir),
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      writeSkillLock(home, lock)

      return { success: true, name: skillName }
    } catch (e) {
      return { success: false, error: String(e) }
    } finally {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  api.ipc.registerHandler('uninstall-skill', (name: string): boolean => {
    const skillDir = join(getSkillsDir(home), name)
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true })
    }
    const lock = readSkillLock(home)
    if (lock.skills?.[name]) {
      delete lock.skills[name]
      writeSkillLock(home, lock)
    }
    return true
  })

  api.ipc.registerHandler('test-connection', async (baseURL: string, apiKey: string, model: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const url = baseURL.replace(/\/$/, '') + '/chat/completions'
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 1
        })
      })
      if (res.ok) return { success: true }
      const text = await res.text()
      return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  api.ipc.registerHandler('list-sessions', (agent: string): Array<{ id: string; dir: string; name: string; modified?: string }> => {
    if (agent === 'pi') {
      const sessionsDir = join(home, '.pi/agent/sessions')
      if (!existsSync(sessionsDir)) return []
      return readdirSync(sessionsDir).map(id => {
        const dir = join(sessionsDir, id)
        const stat = statSync(dir)
        return { id, dir, name: id.replace(/--/g, '/').replace(/-/g, '/'), modified: stat.mtime.toISOString() }
      })
    }
    if (agent === 'opencode') {
      const sessionsDir = join(home, '.local/share/opencode/sessions')
      if (!existsSync(sessionsDir)) return []
      return readdirSync(sessionsDir).filter(f => !f.startsWith('.')).map(id => {
        const dir = join(sessionsDir, id)
        const stat = statSync(dir)
        return { id, dir, name: id, modified: stat.mtime.toISOString() }
      })
    }
    return []
  })

  api.logger.info('Agent Manager main process plugin activated')
}
