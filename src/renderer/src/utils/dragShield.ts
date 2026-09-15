/**
 * Pointer-drag shield.
 *
 * A <webview> guest (browser tab, standalone web page) renders in its own
 * renderer process and takes over hit-testing as soon as the pointer enters
 * it: the host document stops receiving mouse events until the cursor leaves
 * the guest again. A splitter drag whose gesture crosses a browser pane
 * therefore froze in that direction — the left splitter could be dragged left
 * (the cursor stays over host DOM) but not right, and the release over a
 * webview was never observed at all.
 *
 * The shield is a transparent host-DOM element painted above every pane for
 * the duration of the gesture, so host hit-testing owns the whole drag: the
 * window keeps receiving mousemove/mouseup, and the drag cursor cannot be
 * replaced by whatever sits underneath the pointer.
 *
 * `body.mir-resizing` additionally makes webviews click-through (see the
 * global style block in App.vue) as a belt-and-braces guard.
 */

let endActive: (() => void) | null = null

export interface DragShieldOptions {
  /** Cursor for the whole gesture: 'col-resize' | 'row-resize' | … */
  cursor?: string
  /** Runs exactly once when the gesture ends, however it ended. */
  onEnd: () => void
}

/**
 * Shield one drag gesture. Starting a shield while another gesture is running
 * ends that one first — two drags can never overlap.
 */
export function startDragShield(options: DragShieldOptions): void {
  endActive?.()

  const shield = document.createElement('div')
  shield.className = 'mir-drag-shield'
  if (options.cursor) shield.style.cursor = options.cursor
  document.body.appendChild(shield)
  document.body.classList.add('mir-resizing')

  let done = false
  const finish = () => {
    if (done) return
    done = true
    endActive = null
    window.removeEventListener('mousemove', onMove, true)
    window.removeEventListener('mouseup', finish, true)
    window.removeEventListener('blur', finish)
    shield.remove()
    document.body.classList.remove('mir-resizing')
    options.onEnd()
  }

  // The release may happen outside the window (or never reach us): end the
  // gesture on the first move that reports no held button instead of leaving
  // the shield stuck over the UI.
  const onMove = (e: MouseEvent) => {
    if (e.buttons === 0) finish()
  }

  window.addEventListener('mousemove', onMove, true)
  window.addEventListener('mouseup', finish, true)
  window.addEventListener('blur', finish)
  endActive = finish
}

/** End the running gesture, if any. Safe to call at any time. */
export function endDragShield(): void {
  endActive?.()
}
