/** Fullscreen tile state.
 *
 * Hovering a tile and pressing `v` expands it to fill the viewport; pressing `v`
 * again, `Escape`, or the tile's close button restores it. Only one tile can be
 * fullscreen at a time, so this is shared state rather than per-tile.
 */

import { createSignal } from 'solid-js'

const [hoveredTile, setHovered] = createSignal<string | null>(null)
const [fullscreenTile, setFullscreen] = createSignal<string | null>(null)

export { fullscreenTile }

export function setHoveredTile(id: string | null) {
  setHovered(id)
}

export function toggleFullscreen(id: string) {
  setFullscreen((current) => (current === id ? null : id))
}

export function exitFullscreen() {
  setFullscreen(null)
}

/** Install the `v` and `Escape` shortcuts. Returns an uninstall function. */
export function installFullscreenShortcuts(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return

    const target = event.target as HTMLElement | null
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return
    }

    if (event.key === 'v' || event.key === 'V') {
      const id = hoveredTile()
      if (id) {
        event.preventDefault()
        toggleFullscreen(id)
      }
    } else if (event.key === 'Escape' && fullscreenTile()) {
      exitFullscreen()
    }
  }

  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
