import { useUIStore } from '../stores/ui'

// Settings and plugin manager are always opened as a global floating overlay,
// regardless of the current mode (project / browser panel / standalone page).
// This keeps the experience consistent: the same UI in every context.
export function openSettings() {
  useUIStore().openOverlay('settings')
}

export function openPluginManager() {
  useUIStore().openOverlay('plugin-manager')
}
