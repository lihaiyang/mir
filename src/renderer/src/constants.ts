export const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', '.cache', '__pycache__', '.next'
])

export const FILE_ICON_MAP: Record<string, string> = {
  ts: '🔷', tsx: '🔷', js: '🟡', jsx: '🟡', vue: '🟢',
  py: '🐍', go: '🔵', rs: '🦀', json: '📋', md: '📄',
  css: '🎨', scss: '🎨', html: '🌐', sh: '⚙️', env: '🔑'
}

export function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  return FILE_ICON_MAP[ext] || '📄'
}
