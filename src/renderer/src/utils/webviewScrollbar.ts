import type { WebviewTag } from 'electron'

const SLIM_SCROLLBAR_CSS = `
::-webkit-scrollbar { width: 6px !important; height: 6px !important; }
::-webkit-scrollbar-track { background: transparent !important; }
::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.35) !important;
  border-radius: 999px !important;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.55) !important;
}
::-webkit-scrollbar-corner { background: transparent !important; }
`

/**
 * Injects slim, transparent-track scrollbars into an Electron <webview> guest
 * so native 15px gray scrollbar tracks do not clip against floating-island rounded corners.
 */
export function injectSlimScrollbar(wv: WebviewTag | null | undefined): void {
  if (!wv || typeof wv.insertCSS !== 'function') return
  void wv.insertCSS(SLIM_SCROLLBAR_CSS).catch(() => {})
}
