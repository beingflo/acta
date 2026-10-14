/** Time range state shared by all tiles. */

import { createSignal } from 'solid-js'

export type Preset = '1y' | '6m' | '30d' | '7d' | '1d' | '6h' | 'custom'
export type Range = { from: Date; to: Date }

export const PRESETS: { id: Exclude<Preset, 'custom'>; label: string }[] = [
  { id: '1y', label: '1y' },
  { id: '6m', label: '6m' },
  { id: '30d', label: '30d' },
  { id: '7d', label: '7d' },
  { id: '1d', label: '1d' },
  { id: '6h', label: '6h' },
]

const [preset, setPresetSignal] = createSignal<Preset>('1d')
const [customRange, setCustomRangeSignal] = createSignal<Range | null>(null)
const [latest, setLatest] = createSignal<Date | null>(null)

export { preset, customRange }

export function setPreset(next: Preset) {
  setPresetSignal(next)
}

export function setCustomRange(next: Range) {
  setCustomRangeSignal(next)
  setPresetSignal('custom')
}

const STALE_AFTER_MS = 10 * 60 * 1000

/** Newest timestamp present in the data, captured at startup. */
export function setLatestData(date: Date) {
  setLatest(date)
}

/** Resolve the current selection to concrete timestamps. If the data has not
 *  received a point recently, end relative ranges at the newest point instead
 *  of the wall clock, so a stalled dataset shows its latest window rather than
 *  an empty one. */
export function range(now = new Date()): Range {
  const newest = latest()
  const stale = newest && now.getTime() - newest.getTime() > STALE_AFTER_MS
  const end = stale ? newest : now
  const current = preset()
  if (current === 'custom') {
    return customRange() ?? { from: shift(end, '1d'), to: end }
  }
  return { from: shift(end, current), to: end }
}

function shift(now: Date, preset: Exclude<Preset, 'custom'>): Date {
  const date = new Date(now)
  switch (preset) {
    case '6h':
      date.setHours(date.getHours() - 6)
      break
    case '1d':
      date.setDate(date.getDate() - 1)
      break
    case '7d':
      date.setDate(date.getDate() - 7)
      break
    case '30d':
      date.setDate(date.getDate() - 30)
      break
    case '6m':
      date.setMonth(date.getMonth() - 6)
      break
    case '1y':
      date.setFullYear(date.getFullYear() - 1)
      break
  }
  return date
}
