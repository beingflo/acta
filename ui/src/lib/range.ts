/** Time range state shared by all tiles. */

import { batch, createSignal } from 'solid-js'

export type Preset = 'all' | '1y' | '30d' | '7d' | '1d' | '6h' | '30m' | 'custom'
export type Range = {
  from: Date
  to: Date
  /** Resolve the end to the wall clock on every query instead of keeping the
   *  timestamp it was created with. Set when the end was within two minutes of
   *  "now" at creation; see `setCustomRange`. */
  liveEnd?: boolean
}

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

/** How close a range end must be to the wall clock, when the range is created,
 *  to count as "now" and keep following it. Two minutes covers a chart that
 *  was loaded a while before it was brushed up to its right edge. */
const LIVE_END_TOLERANCE_MS = 2 * 60 * 1000

export function setPreset(next: Preset) {
  setPresetSignal(next)
}

export function setCustomRange(next: Range) {
  // A window that ends at the clock is a live window: keep the start fixed and
  // re-resolve the end on every query, so it still ends at "now" after the tab
  // has sat in the background for a while. Batched so the URL effect never sees
  // the new range with the old preset and writes an intermediate URL.
  batch(() => {
    setCustomRangeSignal({ ...next, liveEnd: next.liveEnd ?? endsNow(next.to) })
    setPresetSignal('custom')
  })
}

/** True when `date` is close enough to the wall clock to be "now". */
export function endsNow(date: Date, now = new Date()): boolean {
  return Math.abs(now.getTime() - date.getTime()) <= LIVE_END_TOLERANCE_MS
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

/** Oldest and newest timestamps present in the data, for the `all` range. */
export function setDataBounds(from: Date, to: Date) {
  setEarliest(from)
  setLatest(to)
}

/** Resolve the current selection to concrete timestamps. A live end — a preset,
 *  or a custom range created at the wall clock — is resolved to `now` on every
 *  call, so it never freezes at the time it was picked. Only `all` reads the
 *  data bounds, and reading them there makes that range re-resolve when they
 *  arrive. */
export function range(now = new Date()): Range {
  const current = preset()

  if (current === 'custom') {
    const custom = customRange()
    if (!custom) return { from: shift(now, '1d'), to: now }
    return { ...custom, to: custom.liveEnd ? now : custom.to }
  }
  if (current === 'all') {
    return { from: earliest() ?? shift(now, '1y'), to: latest() ?? now }
  }
  return { from: shift(now, current), to: now }
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
