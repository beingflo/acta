import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'

import { fetchData } from '../lib/api'
import { formatClock } from '../lib/format'
import { locationFixTimesSql } from '../lib/query'
import { range, setCustomRange } from '../lib/range'
import { autoRefresh } from '../lib/refresh'

/** The strip's height in CSS pixels: the stems above, the axis and its labels
 *  below. `STEM_BOTTOM` and `AXIS_Y` leave the gap that keeps a stem off the
 *  rule, and the shortest drag that means a selection rather than a click on the
 *  way past. */
const HEIGHT = 48
const STEM_TOP = 2
const STEM_BOTTOM = 24
const AXIS_Y = 27
const LABEL_Y = 30
const MIN_DRAG = 4
/** The axis labels' font, the room one needs on the strip (so the step is picked
 *  to keep them `LABEL_GAP` apart), and the clearance kept for the window's own
 *  edge label at either end. */
const LABEL_FONT = '11px ui-sans-serif, system-ui, sans-serif'
const LABEL_GAP = 100
const EDGE_ROOM = 30
/** Dates are the anchor on this axis and clocks are the ticks between them, so
 *  the two are not set in the same grey. Both are dark: the strip is 10px text
 *  under a map, and a grey that looks quiet at a desk is unreadable on a phone
 *  in daylight. */
const DATE_FILL = '#222222'
const CLOCK_FILL = '#555555'

/** Tick spacings the strip may use, in seconds: the chart axis' ladder, coarse
 *  because a strip a few pixels tall has room for a handful of labels. */
const STEPS = [
  60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86_400, 172_800,
  604_800, 1_209_600, 2_592_000, 7_776_000, 31_536_000,
]

const pad = (value: number) => String(value).padStart(2, '0')

/** The label at one end of the strip: a clock, with the day in front when the
 *  window's two ends do not share one. */
function edgeLabel(date: Date, withDay: boolean): string {
  const clock = formatClock(date.getTime() / 1000)
  return withDay ? `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${clock}` : clock
}

/**
 * A tick's label, from the spacing the ticks are drawn at: a date once they are
 * a day or more apart, a clock before that, and the date spelled out on a tick
 * that starts a new day — which is the only place a window a couple of days long
 * says which day a `6pm` belongs to. `date` says which of the two fills it takes.
 *
 * Deliberately not `axisTickLabels`: a chart axis can spend a second line on the
 * rollover, and a strip this thin cannot, so it has to choose one of the two.
 */
function tickLabel(date: Date, stepSeconds: number): { text: string; date: boolean } {
  if (stepSeconds >= 31_536_000) return { text: String(date.getFullYear()), date: true }
  const day = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`
  if (stepSeconds >= 86_400) return { text: day, date: true }
  if (date.getHours() === 0 && date.getMinutes() === 0) return { text: `${day} 12am`, date: true }
  const text =
    stepSeconds < 3600
      ? formatClock(date.getTime() / 1000)
      : `${date.getHours() % 12 || 12}${date.getHours() < 12 ? 'am' : 'pm'}`
  return { text, date: false }
}

/**
 * The ticks of the strip's time axis: round local times, not the window's own
 * start and end.
 *
 * Stepped on the clock rather than in milliseconds, so a tick keeps its wall
 * time across a DST change; day steps walk local midnights for the same reason.
 * The first tick is the first round time at or after the window's start.
 */
function ticksWithin(from: Date, to: Date, stepSeconds: number): number[] {
  const ticks: number[] = []
  const guard = 512
  if (stepSeconds >= 86_400) {
    const days = Math.round(stepSeconds / 86_400)
    let at = new Date(from.getFullYear(), from.getMonth(), from.getDate())
    for (let i = 0; at.getTime() <= to.getTime() && i < guard; i++) {
      if (at.getTime() >= from.getTime()) ticks.push(at.getTime() / 1000)
      at = new Date(at.getFullYear(), at.getMonth(), at.getDate() + days)
    }
    return ticks
  }

  const minutes = Math.max(1, Math.round(stepSeconds / 60))
  const clockMinutes = from.getHours() * 60 + from.getMinutes()
  let at = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate(),
    0,
    Math.ceil(clockMinutes / minutes) * minutes,
  )
  for (let i = 0; at.getTime() <= to.getTime() && i < guard; i++) {
    if (at.getTime() >= from.getTime()) ticks.push(at.getTime() / 1000)
    at = new Date(at.getTime())
    at.setMinutes(at.getMinutes() + minutes)
  }
  return ticks
}

/**
 * The window's fixes on a bare time axis: one short stem per position fix.
 *
 * It reads two ways at once. As a picture it is when the phone was moving and
 * when it was not — the tracker is silent while the phone is still, so a cluster
 * of stems is a journey. As a control it is the quickest way to narrow the
 * window to the stretch that matters: dragging across it selects that span, so
 * finding the hour of a walk never means opening the range picker and typing two
 * dates. Widening is left to the presets; a drag can only pick what is on screen.
 *
 * A canvas rather than a chart: there is no y to read, nothing to hover, and a
 * year of fixes is a few thousand lines, which a DOM node each would turn into a
 * few thousand elements. Not built on uPlot either — a drag here is the whole
 * interaction, and uPlot's own selection would have to be undone to use it.
 */
export default function TrackRug() {
  let canvas!: HTMLCanvasElement
  const [times, setTimes] = createSignal<number[]>([])
  const [width, setWidth] = createSignal(0)
  // The span under the pointer while a drag is in progress, left edge first.
  const [drag, setDrag] = createSignal<[number, number] | null>(null)
  let dragFrom: number | null = null
  let requestId = 0

  const load = async () => {
    const request = ++requestId
    const { from, to } = range()
    const reply = await fetchData<number[]>(locationFixTimesSql(from, to)).catch((error) => {
      console.warn('fix times query failed', error)
      return null
    })
    if (request !== requestId) return
    setTimes(reply ?? [])
  }

  createEffect(() => {
    range() // re-run when the selected window changes
    void load()
  })

  onMount(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.floor(entries[0].contentRect.width)),
    )
    observer.observe(canvas)
    onCleanup(autoRefresh(load))
    onCleanup(() => {
      requestId++ // drop replies that are still in flight
      observer.disconnect()
    })
  })

  /** The instant under a horizontal position in the strip, and back. */
  const timeAt = (x: number) => {
    const { from, to } = range()
    const span = Math.max(to.getTime() - from.getTime(), 1)
    return new Date(from.getTime() + (x / Math.max(width(), 1)) * span)
  }

  /** Where the pointer is, in the canvas' own coordinates, clamped to it. */
  const offsetX = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect()
    return Math.min(Math.max(event.clientX - box.left, 0), box.width)
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    canvas.setPointerCapture(event.pointerId)
    dragFrom = offsetX(event)
    setDrag([dragFrom, dragFrom])
  }

  const onPointerMove = (event: PointerEvent) => {
    if (dragFrom === null) return
    const x = offsetX(event)
    setDrag([Math.min(dragFrom, x), Math.max(dragFrom, x)])
  }

  const endDrag = (event: PointerEvent) => {
    if (dragFrom === null) return
    const from = dragFrom
    const x = offsetX(event)
    dragFrom = null
    setDrag(null)
    // A click is not a range: a drag too short to see is a slip, and the presets
    // are there for the windows this cannot express anyway.
    if (Math.abs(x - from) < MIN_DRAG) return
    setCustomRange({ from: timeAt(Math.min(from, x)), to: timeAt(Math.max(from, x)) })
  }

  const onPointerCancel = () => {
    dragFrom = null
    setDrag(null)
  }

  // Redraw on a new width, a new window, new fixes or a live drag.
  createEffect(() => {
    const w = width()
    const marks = times()
    const band = drag()
    const { from, to } = range()

    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(w * ratio))
    canvas.height = Math.round(HEIGHT * ratio)
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, w, HEIGHT)

    const start = from.getTime()
    const span = Math.max(to.getTime() - start, 1)
    const xOf = (at: number) => ((at - start) / span) * w
    // One stem per fix, inset from the edges so a busy edge still reads as a
    // stem rather than as a filled block. Halfway between the track's black and
    // a grey, and opaque rather than translucent: stems a pixel apart composite,
    // and a busy day would come out darker than a quiet one instead of denser.
    context.fillStyle = '#373737'
    for (const at of marks) {
      const x = Math.round(xOf(at * 1000))
      if (x < 0 || x > w) continue
      context.fillRect(x, STEM_TOP, 1, STEM_BOTTOM - STEM_TOP)
    }

    // The time axis: a hairline with a tick per round local time, labelled the
    // way the charts above label theirs, day first.
    context.fillStyle = '#eeeeee'
    context.fillRect(0, AXIS_Y, w, 1)
    const room = Math.max(w / LABEL_GAP, 2)
    const step = STEPS.find((candidate) => candidate * room >= span / 1000) ?? STEPS[STEPS.length - 1]
    const ticks = ticksWithin(from, to, step)
    context.font = LABEL_FONT
    context.textBaseline = 'top'
    for (const tick of ticks) {
      const x = Math.round(xOf(tick * 1000)) + 0.5
      context.fillStyle = '#dcdcdc'
      context.fillRect(Math.floor(x), AXIS_Y, 1, 3)
      // A label that would run into the window's own edge label is dropped; the
      // tick mark stays, and the axis still says where the round times fall.
      if (x < EDGE_ROOM || x > w - EDGE_ROOM) continue
      const label = tickLabel(new Date(tick * 1000), step)
      context.fillStyle = label.date ? DATE_FILL : CLOCK_FILL
      context.textAlign = 'center'
      context.fillText(label.text, x, LABEL_Y)
    }

    if (band) {
      const [left, right] = band
      context.fillStyle = 'rgba(0, 0, 0, 0.07)'
      context.fillRect(left, 0, right - left, STEM_BOTTOM)
      context.fillStyle = 'rgba(0, 0, 0, 0.4)'
      context.fillRect(left, 0, 1, STEM_BOTTOM)
      context.fillRect(right - 1, 0, 1, STEM_BOTTOM)
    }
  })

  const ends = createMemo(() => {
    const { from, to } = range()
    const withDay = from.toDateString() !== to.toDateString()
    return [edgeLabel(from, withDay), edgeLabel(to, withDay)] as const
  })

  return (
    <div class="rug" title="Drag across the strip to narrow the window to that span">
      <span class="rug-edge">{ends()[0]}</span>
      <canvas
        ref={canvas}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={onPointerCancel}
      />
      <span class="rug-edge">{ends()[1]}</span>
    </div>
  )
}
