import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'

import { fetchData } from '../lib/api'
import { formatClock, tableTimeParts } from '../lib/format'
import { type OfficeArrivals, officeArrivalsSql, rangeDay } from '../lib/query'
import { range } from '../lib/range'
import { autoRefresh } from '../lib/refresh'
import StatsStrip, { type Stat } from './StatsStrip'

/**
 * The two times this dashboard is about, as `[hour, minute]` in local time.
 *
 * They are the office's morning and the return after lunch; the point of the
 * cards is when the day actually started and when it resumed, not how long each
 * stretch lasted.
 */
const MORNING = { from: [6, 0], to: [11, 0] }
const AFTER_LUNCH = { from: [11, 30], to: [15, 0] }

const clock = ([hour, minute]: number[]) =>
  `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

/** That wall-clock time on `day`. Local time on purpose: the windows belong to
 *  the person's day, and `setHours` carries it across a DST change correctly. */
function onDay(day: Date, [hour, minute]: number[]): Date {
  const at = new Date(day)
  at.setHours(hour, minute, 0, 0)
  return at
}

/**
 * When the office was reached: the first fix inside the box in each window, on
 * the day the selected range ends in. Stepping the range back a day shows that
 * day's times, which is why the windows come from the range's end rather than
 * from the clock.
 */
export default function WorkStats() {
  const [arrivals, setArrivals] = createSignal<OfficeArrivals | null>(null)
  let requestId = 0

  const load = async () => {
    const request = ++requestId
    const day = rangeDay(range().to)
    const next = await fetchData<OfficeArrivals>(
      officeArrivalsSql({
        morning: [onDay(day, MORNING.from), onDay(day, MORNING.to)],
        after_lunch: [onDay(day, AFTER_LUNCH.from), onDay(day, AFTER_LUNCH.to)],
      }),
    ).catch((error) => {
      console.warn('office arrivals query failed', error)
      return null
    })
    if (request !== requestId) return
    if (next) setArrivals(next)
  }

  createEffect(() => {
    range() // re-run when the selected window changes
    void load()
  })

  onMount(() => {
    // The tiles' cadence, and `r` reloads these like everything else. A window
    // that has already closed is not polled, since its times cannot change.
    onCleanup(autoRefresh(load))
    onCleanup(() => {
      requestId++ // drop replies that are still in flight
    })
  })

  // The day the numbers belong to, on the cards: stepping the range back has to
  // be visible here, not only in the picker.
  const day = createMemo(() => tableTimeParts(rangeDay(range().to).getTime() * 1000).day)

  const stats = createMemo((): Stat[] => {
    const current = arrivals()
    const windows = [
      { label: 'Morning', window: MORNING, at: current?.morning ?? null },
      { label: 'After lunch', window: AFTER_LUNCH, at: current?.after_lunch ?? null },
    ]
    return windows.map(({ label, window, at }) => ({
      label,
      value: at === null ? '—' : formatClock(at),
      detail: `${clock(window.from)}–${clock(window.to)} · ${day()}`,
      title: `First fix inside the office box, ${clock(window.from)}–${clock(window.to)}`,
    }))
  })

  return <StatsStrip stats={stats()} />
}
