/** Time range state shared by all tiles. */

import { createSignal } from 'solid-js'

export type Preset = 'all' | '1y' | '30d' | '7d' | '1d' | '6h' | '30m' | 'custom'
export type Range = { from: Date; to: Date }

export const PRESETS: { id: Exclude<Preset, 'custom'>; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: '1y', label: '1y' },
  { id: '30d', label: '30d' },
  { id: '7d', label: '7d' },
  { id: '1d', label: '1d' },
  { id: '6h', label: '6h' },
  { id: '30m', label: '30m' },
]

const [preset, setPresetSignal] = createSignal<Preset>('1d')
const [customRange, setCustomRangeSignal] = createSignal<Range | null>(null)
const [earliest, setEarliest] = createSignal<Date | null>(null)
const [latest, setLatest] = createSignal<Date | null>(null)

export { preset, customRange }

export function setPreset(next: Preset) {
  setPresetSignal(next)
}

export function setCustomRange(next: Range) {
  setCustomRangeSignal(next)
  setPresetSignal('custom')
}

/**
 * Step the selected window by its own length: -1 back in time, 1 forward. A 30d
 * selection becomes `[now - 60d, now - 30d]`, which is no longer a preset, so
 * the result is a custom range.
 */
export function shiftRange(direction: -1 | 1) {
  const { from, to } = range()
  const span = to.getTime() - from.getTime()
  if (span <= 0) return
  setCustomRange({
    from: new Date(from.getTime() + direction * span),
    to: new Date(to.getTime() + direction * span),
  })
}

/** `Ctrl+H` / `←` step back, `Ctrl+L` / `→` step forward. */
export function installRangeShortcuts(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.altKey || event.metaKey) return

    const target = event.target as HTMLElement | null
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return
    }

    const letter = event.key.toLowerCase()
    const back = event.key === 'ArrowLeft' || (event.ctrlKey && letter === 'h')
    const forward = event.key === 'ArrowRight' || (event.ctrlKey && letter === 'l')
    if (!back && !forward) return

    event.preventDefault()
    shiftRange(back ? -1 : 1)
  }

  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}

const STALE_AFTER_MS = 10 * 60 * 1000

/** Oldest and newest timestamps present in the data, captured at startup. */
export function setDataBounds(from: Date, to: Date) {
  setEarliest(from)
  setLatest(to)
}

/** Resolve the current selection to concrete timestamps. If the data has not
 *  received a point recently, end relative ranges at the newest point instead
 *  of the wall clock, so a stalled dataset shows its latest window rather than
 *  an empty one. `all` always spans the full data range. */
export function range(now = new Date()): Range {
  const newest = latest()
  const stale = newest !== null && now.getTime() - newest.getTime() > STALE_AFTER_MS
  const end = stale && newest ? newest : now
  const current = preset()

  if (current === 'custom') {
    return customRange() ?? { from: shift(end, '1d'), to: end }
  }
  if (current === 'all') {
    return { from: earliest() ?? shift(end, '1y'), to: newest ?? end }
  }
  return { from: shift(end, current), to: end }
}

/** True when the selected window is wide enough that a date is context enough. */
function shift(now: Date, preset: Exclude<Preset, 'custom' | 'all'>): Date {
  const date = new Date(now)
  switch (preset) {
    case '30m':
      date.setMinutes(date.getMinutes() - 30)
      break
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
    case '1y':
      date.setFullYear(date.getFullYear() - 1)
      break
  }
  return date
}
