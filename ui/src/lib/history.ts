/**
 * Browser history as a keyboard walk: `h` back, `l` forward.
 *
 * The URL is the dashboard's state — the dashboard in the path, the window in
 * the query — and every change to either is a history entry (see `url.ts`). So
 * walking that history is how a zoom is undone: drag a span on the range strip
 * or brush a chart, look, then `h` to be back at the window you came from. That
 * is a different question from the one the arrows answer, which steps the window
 * by its own length — "the day before" rather than "what I was just looking at".
 */

import { detail } from './detail'

export function installHistoryShortcuts(): () => void {
  const onKey = (event: KeyboardEvent) => {
    // A modified `h` or `l` belongs to whatever owns that modifier — `ctrl+h` is
    // the range shortcut, and the browser's own `cmd+h`/`cmd+l` are the window
    // and the address bar.
    if (event.metaKey || event.ctrlKey || event.altKey) return

    const target = event.target as HTMLElement | null
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return
    }

    // Reading an event in the overlay is not navigating: the overlay has its own
    // keys, and a history step underneath it would close it.
    if (detail()) return

    const letter = event.key.toLowerCase()
    if (letter !== 'h' && letter !== 'l') return

    event.preventDefault()
    if (letter === 'h') window.history.back()
    else window.history.forward()
  }

  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
