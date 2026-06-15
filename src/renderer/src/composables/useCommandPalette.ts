import { reactive } from 'vue'

export interface PaletteCommand {
  id: string
  label: string
  keybinding?: string
  run: () => void
}

const registry = reactive<PaletteCommand[]>([])

export function registerCommand(cmd: PaletteCommand) {
  const idx = registry.findIndex(c => c.id === cmd.id)
  if (idx >= 0) registry[idx] = cmd
  else registry.push(cmd)
}

export function unregisterCommand(id: string) {
  const idx = registry.findIndex(c => c.id === id)
  if (idx >= 0) registry.splice(idx, 1)
}

export function getRegistry(): PaletteCommand[] {
  return registry
}
