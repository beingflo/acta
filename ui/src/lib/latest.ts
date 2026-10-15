/**
 * Newest value of every mounted chart, for the summary strip.
 *
 * Tiles publish here as they load; they are the ones that hold the data, so the
 * strip costs no extra queries and can never disagree with what is plotted.
 */

import { createSignal } from 'solid-js'

export type Reading = {
  /** Chart title, e.g. `Living room CO₂`. */
  title: string
  /** Unit from the y-label, e.g. `ppm`. Empty when the label has none. */
  unit: string
  /** Newest value in the selected range, or null when the range holds none. */
  value: number | null
}

type Entry = { order: number; readings: Reading[] }

const [entries, setEntries] = createSignal<Map<string, Entry>>(new Map())
let nextOrder = 0

/**
 * Claim a slot for a tile. Called during the tile's setup rather than when its
 * query returns, so the strip ends up in dashboard order instead of whichever
 * query happened to finish first.
 */
export function claimReadingOrder(): number {
  return nextOrder++
}

/** Every chart's readings, in tile order, so the strip mirrors the dashboard. */
export function latestReadings(): Reading[] {
  return [...entries().values()]
    .sort((a, b) => a.order - b.order)
    .flatMap((entry) => entry.readings)
}

export function publishReadings(id: string, order: number, readings: Reading[]) {
  setEntries((current) => {
    const next = new Map(current)
    next.set(id, { order, readings })
    return next
  })
}

export function clearReadings(id: string) {
  setEntries((current) => {
    if (!current.has(id)) return current
    const next = new Map(current)
    next.delete(id)
    return next
  })
}
