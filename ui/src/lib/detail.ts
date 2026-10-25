/** The row-detail overlay.
 *
 * A table cell can only show the columns the table has, and a source's payload
 * is not shaped like any other's: an `eos-stats` sample is a nested object, a
 * Marending request carries a dozen fields of which the table shows six, and
 * some sources have no `data` field at all. So the overlay shows the whole
 * stored event — timestamp, source, payload — pretty-printed, rather than
 * whatever columns happened to fit.
 *
 * App-level rather than per-tile: `.tile` is its own stacking context, so a
 * fixed backdrop rendered inside one would paint underneath the next tile. Only
 * one event is open at a time, which makes it shared state.
 */

import { createSignal } from 'solid-js'

import { tableTimeParts } from './format'

export type Detail = {
  /** What the row is: the source it was stored under. */
  title: string
  /** When it was recorded, in local time. */
  subtitle: string
  /** The whole event; the overlay renders it as pretty-printed JSON. */
  value: unknown
  /** Walk to the neighbouring row of the table this was opened from: `+1` is
   *  the next row down, which is the older event. The table supplies it, because
   *  only the table knows what is next and whether it has to be fetched. */
  step?: (delta: -1 | 1) => Promise<Detail | null>
}

const [detail, setDetail] = createSignal<Detail | null>(null)

/** One step at a time: holding the arrow key would otherwise queue a fetch per
 *  repeat against the same starting row. */
let stepping = false

export { detail }

export function showDetail(next: Detail): void {
  setDetail(next)
}

export function closeDetail(): void {
  setDetail(null)
}

/**
 * Move the overlay one event up or down the table it was opened from.
 *
 * The end of the table leaves the overlay where it is rather than closing it: a
 * reader who arrows too far should not lose the event they were on.
 */
export async function stepDetail(delta: -1 | 1): Promise<void> {
  const current = detail()
  if (!current?.step || stepping) return
  stepping = true
  try {
    const next = await current.step(delta)
    if (next) setDetail(next)
  } catch (error) {
    console.error('could not step to the neighbouring event', error)
  } finally {
    stepping = false
  }
}

/**
 * The overlay content for one stored event.
 *
 * `payload` is the payload column as the page queries carry it: JSON text, so
 * it is parsed back here — an escaped one-line string would be the opposite of
 * "nicely presented". Microseconds are kept in the timestamp, because a narrow
 * window is exactly where their order matters.
 */
export function eventDetail(us: number, source: string | null, payload: string | null): Detail {
  const at = tableTimeParts(us)
  return {
    title: source ?? 'no source',
    subtitle: `${at.day} ${at.clock}`,
    value: { timestamp: stamp(us), source, data: parsePayload(payload) },
  }
}

/** `2026-10-25T19:42:10.123456Z`: ISO to the millisecond, plus the microseconds
 *  `toISOString` drops. */
function stamp(us: number): string {
  const millis = Math.floor(us / 1000)
  const micros = String(us - millis * 1000).padStart(3, '0')
  return new Date(millis).toISOString().replace('Z', `${micros}Z`)
}

function parsePayload(payload: string | null): unknown {
  if (payload === null) return null
  try {
    return JSON.parse(payload)
  } catch {
    // Not JSON after all: show it as the text it is rather than as an error.
    return payload
  }
}

/**
 * `Escape` closes the overlay, the arrows walk the table.
 *
 * Installed before the tile and range shortcuts so it gets the keys first: an
 * open overlay owns `Escape` and the vertical arrows, and dismissing a detail
 * should not also restore a maximized tile.
 */
export function installDetailShortcuts(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (detail() === null) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      closeDetail()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Otherwise the table behind the hush scrolls under the reader.
      event.preventDefault()
      event.stopImmediatePropagation()
      void stepDetail(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
