import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import { fetchData } from '../lib/api'
import { exitFullscreen, fullscreenTile, setHoveredTile } from '../lib/fullscreen'
import { type OfficeHour, localDays, officeHoursSql } from '../lib/query'
import { range } from '../lib/range'
import { autoRefresh } from '../lib/refresh'
import ExpandButton from './ExpandButton'

/** How many days the lane will show: a year, so `1y` and `all` are one picture
 *  rather than a wall of rows. */
const MAX_DAYS = 366
/** The height the rows share out between them, and the floor that keeps a year
 *  of them legible: rows thin out with the range, but only down to a size where
 *  a cell is still a cell. A year is a tall tile; that is the right trade. */
const LANE_HEIGHT = 900
const MIN_ROW = 10
/** The lane's columns: quarter-hour slots between the hours anyone is at the office.
 *  Before six and after nine the answer is always "no", and spending a third of
 *  the row on it only narrows the part that matters. */
const FIRST_HOUR = 6
const LAST_HOUR = 21
const SLOT_MINUTES = 15
const COLUMNS = ((LAST_HOUR - FIRST_HOUR) * 60) / SLOT_MINUTES
/** One mark per hour along the top, each centred over that hour's columns. */
const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, index) => FIRST_HOUR + index)

/** The hour and minute a column starts at. */
const slotClock = (slot: number) => ({
  hour: FIRST_HOUR + Math.floor((slot * SLOT_MINUTES) / 60),
  minute: (slot * SLOT_MINUTES) % 60,
})

const pad = (value: number) => String(value).padStart(2, '0')

/**
 * The office as a calendar: one row per day over the selected range, one column
 * per hour, filled where the last known position was inside the box.
 *
 * Not a uPlot chart — this is a grid, not a series, and the point is to read a
 * month at a glance rather than to follow a curve. The hour states come from one
 * sparse query and are carried forward here: an hour with no fix is not an hour
 * away, it is an hour the tracker had nothing to say about.
 */
export default function OfficeLane() {
  const [hours, setHours] = createSignal<OfficeHour[]>([])
  let requestId = 0

  const load = async () => {
    const request = ++requestId
    const { from, to } = range()
    const reply = await fetchData<OfficeHour[]>(officeHoursSql(localDays(from, to, MAX_DAYS))).catch(
      (error) => {
        console.warn('office hours query failed', error)
        return null
      },
    )
    if (request !== requestId) return
    setHours(reply ?? [])
  }

  createEffect(() => {
    range() // re-run when the selected window changes
    void load()
  })

  const id = 'Days at the office'
  const isFullscreen = createMemo(() => fullscreenTile() === id)

  onMount(() => {
    onCleanup(autoRefresh(load))
    onCleanup(() => {
      requestId++ // drop replies that are still in flight
    })
  })

  /** Rows of `{ day, cells }`, oldest first. */
  const rows = createMemo(() => {
    const { from, to } = range()
    const known = hours()

    const rangeFrom = from.getTime()
    const rangeTo = to.getTime()

    return localDays(from, to, MAX_DAYS).map(([start, end]) => {
      // Only the hours this day actually has fixes for: the state holds forward
      // between them, but before the first fix and after the last one the phone
      // was simply silent, and it says nothing about where it was. Carrying the
      // state across those edges is what made whole days look like one long
      // visit — including the night before the first fix.
      const bracket = known.filter(
        (row) => row.t * 1000 >= start.getTime() && row.t * 1000 < end.getTime(),
      )
      // Nothing is claimed past the last fix either: the phone going quiet is
      // not evidence of staying.
      const last = bracket.at(-1)?.t

      const cells: Array<{ inside: boolean; title: string }> = []
      for (let slot = 0; slot < COLUMNS; slot++) {
        const { hour, minute } = slotClock(slot)
        const at = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hour, minute)
        // A slot the local clock jumped over (spring forward) has no cell.
        if (at.getHours() !== hour || at.getMinutes() !== minute) continue
        const slotEnd = new Date(at.getTime() + SLOT_MINUTES * 60_000)
        // Only the slots the selected window covers: the chart above ends where
        // the range ends, and a lane claiming more than that reads as a bug.
        const covered = slotEnd.getTime() > rangeFrom && at.getTime() < rangeTo
        const state =
          !covered || (last !== undefined && at.getTime() / 1000 > last)
            ? null
            : stateAt(bracket, at.getTime())
        cells.push({
          inside: state === 1,
          title: `${pad(at.getDate())}-${pad(at.getMonth() + 1)} ${pad(hour)}:${pad(minute)} · ${
            state === null ? 'no fix' : state === 1 ? 'at the office' : 'away'
          }`,
        })
      }
      return {
        day: `${pad(start.getDate())}-${pad(start.getMonth() + 1)}`,
        // A day off is an empty row for a reason, so it is tinted as one: a gap
        // that reads as "no data" would be a bug report.
        weekend: start.getDay() === 0 || start.getDay() === 6,
        cells,
      }
    })
  })

  /** Row height: generous for a week, still readable for a year. */
  const rowHeight = createMemo(() =>
    Math.max(MIN_ROW, Math.min(13, Math.round(LANE_HEIGHT / Math.max(1, rows().length)))),
  )

  return (
    <section
      class="tile wide lane"
      classList={{ fullscreen: isFullscreen() }}
      onMouseEnter={() => setHoveredTile(id)}
      onMouseLeave={() => setHoveredTile(null)}
    >
      <header class="tile-title">Days at the office</header>
      <Show when={!isFullscreen()}>
        <ExpandButton tile={id} />
      </Show>
      <Show when={isFullscreen()}>
        <button class="tile-close" onClick={exitFullscreen} aria-label="Exit fullscreen">
          ×
        </button>
      </Show>
      <Show when={rows().length > 0}>
        <div class="lane" style={{ '--lane-row': `${rowHeight()}px` }}>
          <div class="lane-hours">
            {/* The same gutter as a day row, or the marks start 34px early and
                every one after the first drifts against its cells. */}
            <span class="lane-day" />
            <div class="lane-hour-marks">
              <For each={HOURS}>{(hour) => <span>{pad(hour)}</span>}</For>
            </div>
          </div>
          <For each={rows()}>
            {(row) => (
              <div class="lane-row" classList={{ weekend: row.weekend }}>
                <span class="lane-day">{row.day}</span>
                <div class="lane-cells">
                  <For each={row.cells}>
                    {(cell) => (
                      <span
                        class="lane-cell"
                        classList={{ inside: cell.inside }}
                        title={cell.title}
                      />
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}

/**
 * The last known state at `at`: the newest hour at or before it. Sparse replies
 * are the norm — the tracker is quiet whenever the phone is — so the state holds
 * until the next one, and an hour before the first fix has none yet.
 */
function stateAt(known: OfficeHour[], at: number): number | null {
  let state: number | null = null
  for (const row of known) {
    if (row.t * 1000 > at) break
    state = row.s0
  }
  return state
}
