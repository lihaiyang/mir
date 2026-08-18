import { defineStore } from 'pinia'
import { ref } from 'vue'

export type OverlayMode = 'settings' | 'plugin-manager'

// Global UI state that is not tied to any single project. In particular, the
// settings / plugin-manager pages are ordinary project tabs under normal
// project mode, but the browser panel and standalone web-page modes have no
// active project at all, so they are rendered as a global overlay instead.
export const useUIStore = defineStore('ui', () => {
  const overlayMode = ref<OverlayMode | null>(null)

  function openOverlay(mode: OverlayMode) {
    overlayMode.value = mode
  }

  function closeOverlay() {
    overlayMode.value = null
  }

  return { overlayMode, openOverlay, closeOverlay }
})
