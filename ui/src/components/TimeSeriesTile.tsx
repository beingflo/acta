import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

import { fetchData, fetchSeries, type SeriesMetric } from '../lib/api'
import { exitFullscreen, fullscreenTile, setHoveredTile } from '../lib/fullscreen'
import ExpandButton from './ExpandButton'
import { axisTickLabels, formatBucket, formatNumber, formatTimestamp, unitOf } from '../lib/format'
import { clearReadings, claimReadingOrder, publishReadings } from '../lib/latest'
import { BAR_FILL, fillFor, strokeFor } from '../lib/palette'
import { bucketFor, timeSeriesSql, toAligned, type Series } from '../lib/query'
import { fitRange, type YFit } from '../lib/scale'
import { range, setCustomRange } from '../lib/range'
import { autoRefresh } from '../lib/refresh'

const AXIS_FONT = '11px ui-sans-serif, system-ui, sans-serif'
const DEFAULT_HEIGHT = 300

// uPlot reserves a flat 50px for every axis, whatever its labels need; these
// three numbers turn that into the room the labels actually take: the tick
// marks, the gap between a tick and its label, and one line of 11px text. A
// line is `font-size × lineGap` (uPlot's lineGap is 1.5), not the font size —
// two rows of a rollover label need 33px, and reserving less clips the date.
const AXIS_TICK = 10
const AXIS_GAP = 5
const AXIS_LINE = 17

/** Width of a piece of text in the axis font, for sizing the y axis. */
const measure = (() => {
  let context: CanvasRenderingContext2D | null | undefined
  return (text: string) => {
    if (context === undefined) {
      context = document.createElement('canvas').getContext('2d')
      if (context) context.font = AXIS_FONT
    }
    if (!context) return 0
    context.font = AXIS_FONT
    return context.measureText(text).width
  }
})()

/** Room for `rows` lines of tick label, plus the ticks themselves. */
const tickRoom = (rows: number) => AXIS_TICK + AXIS_GAP + rows * AXIS_LINE

/** Rows a set of labels needs: a tick that starts a day or a year gets two. */
const rowsOf = (values: (string | null)[] | null) =>
  values?.reduce((rows, value) => Math.max(rows, String(value ?? '').split('\n').length), 1) ?? 1

/** uPlot's own bookkeeping for an axis: the labels it last drew, and its size. */
const bookkeeping = (self: uPlot, index: number) =>
  self.axes[index] as unknown as { _values?: (string | null)[]; _size?: number }

/**
 * How far half of a tick label hangs past the edge of the plot. The first and
 * last ticks sit on the plot's corners, so a label wider than the axis that
 * offsets it is cut by the canvas — which is what clipped "6pm" to "6pr" on a
 * phone, where the plot ends at the window's right edge.
 */
const overhang = (values: (string | null)[] | null | undefined, index: number) => {
  const value = index === -1 ? values?.[(values?.length ?? 0) - 1] : values?.[index]
  if (!value) return 0
  const widest = Math.max(...String(value).split('\n').map(measure))
  // A couple of pixels of slack: uPlot draws the label centred on the canvas
  // pixel it rounds the tick to, so an exact half hangs over by a hair.
  return Math.ceil(widest / 2) + 3
}
// Bars are drawn one per bucket, so they need room: a bucket per pixel would
// render as a solid block with no gaps between the bars.
const BAR_BUCKET_PX = 10
// Below this much room per point a line stops being readable, so the series
// also gets markers. Sparse windows (a few samples in a short range) would
// otherwise show nothing at all.
const DOT_SPACING_PX = 16
// A drag shorter than this stays a click, and a finished selection is only
// acted on once it has stopped changing: uPlot fires `setSelect` on every
// pointer move, and each one would otherwise re-query every tile.
const MIN_SELECTION_PX = 8
const SELECT_SETTLE_MS = 200
// Header height (`--header-height`) plus the tile's own title, label and padding:
// 50 + 10 + 17 + 8 + 15 + 2 + 6, the tile's chrome as `App.css` sets it.
const FULLSCREEN_CHROME = 108

/** All tiles join one uPlot sync group, so the cursor is shared between them. */
const CURSOR_SYNC = 'acta-cursor'

/** uPlot's aligned data, as this tile builds it: plain arrays it can pad. */
type Columns = [number[], ...(number | null)[][]]

/**
 * Cumulative columns, so each series can be drawn as one slice of a stack: the
 * topmost total draws the whole bar, and every lower column paints only the
 * band between itself and the layer above it.
 */
function stack(columns: Columns): Columns {
  const [xs, ...layers] = columns
  const out: Columns = [xs]
  let below: (number | null)[] = xs.map(() => 0)
  for (const layer of layers) {
    below = layer.map((value, index) => (value ?? 0) + (below[index] ?? 0))
    out.push(below)
  }
  return out
}

export default function TimeSeriesTile(props: {
  title: string
  /** Omit to aggregate every source, as the acta dashboard does. */
  source?: string
  /** The SQL the owner's credential may write. Omit when `metrics` is given. */
  series?: Series[]
  /**
   * Readings the service defines (`service/src/metrics.rs`), for dashboards a
   * restricted viewer may open: the tile then asks `/api/series` and never sends
   * SQL of its own. Several draw several lines, each in its own shade of the
   * chart green, named by its label in the tooltip.
   */
  metrics?: SeriesMetric[]
  yLabel?: string
  height?: number
  wide?: boolean
  /** Draw bars instead of a line, for counts per bucket. */
  bars?: boolean
  /** Stack the bars, bottom series first, so a bucket is one bar split by
   *  series rather than one bar per series. */
  stacked?: boolean
  /** Fill per series, for bars. */
  fills?: string[]
  /** Fixed y bounds, for a value with a natural scale such as a percentage. */
  yRange?: [number, number]
  /**
   * Fit the y axis to the plotted data with headroom, instead of the fixed
   * `yRange` — see `lib/scale.ts` for the presets and what each part means.
   */
  yFit?: YFit
  /**
   * Draw the line as a step: each value holds until the next point. For a state
   * that persists between samples, where a diagonal would invent a crossing the
   * data never showed — at the office until the next fix.
   */
  step?: boolean
  /** Names for the y axis' ticks, which uPlot otherwise prints as raw numbers:
   *  `(minutes) => '07:30'` for a time of day, or `in`/`out` for a state. */
  yTicks?: (value: number) => string
  /** Label only the ends of `yRange` and draw no ticks between them, for an
   *  axis that is a state rather than a quantity. */
  yTickEnds?: boolean
  /**
   * A whole query instead of the aggregate `series`, for a series no bucket
   * aggregate can express — the fixes themselves, say, where quantising would
   * move the steps. It must return the usual `[{ t, s0, … }]` JSON; `series` then
   * only names the columns, its `expr` unused.
   */
  query?: (from: Date, to: Date) => string
}) {
  // A metric tile draws one line per reading; a SQL tile as many as it was
  // given. Everything below reads `series()` rather than the prop.
  const series = (): Series[] =>
    props.metrics
      ? props.metrics.map((entry) => ({ label: entry.label, expr: entry.metric }))
      : (props.series ?? [])

  const id = props.title
  // Claimed during setup rather than when the query returns, so the summary
  // strip lists the charts in dashboard order, not reply order.
  const order = claimReadingOrder()
  // A tile is only worth syncing while it is on screen: a maximized tile covers
  // the others, and having them follow the cursor would float their tooltips
  // over it.
  const inSync = () => isFullscreen() || fullscreenTile() === null
  // A memo (not a plain accessor) so toggling one tile does not re-run every
  // other tile's effects.
  const isFullscreen = createMemo(() => fullscreenTile() === id)
  const [viewport, setViewport] = createSignal(window.innerHeight)
  const height = () =>
    isFullscreen() ? viewport() - FULLSCREEN_CHROME : (props.height ?? DEFAULT_HEIGHT)

  let container!: HTMLDivElement
  let chart: uPlot | undefined
  let requestId = 0
  const [width, setWidth] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  // The bar width in milliseconds, for the subtitle: a bar is a count over a
  // span, and a span is picked from the range and the tile's width, so it has
  // to be stated rather than guessed from the axis.
  const [barMs, setBarMs] = createSignal<number | null>(null)
  // x scale bounds in seconds, and whether the series is too sparse for a bare
  // line. Both are set per load, before the data reaches the chart.
  let xWindow: [number, number] = [0, 1]
  let showDots = false
  // The values the query returned, as opposed to the stacked ones handed to
  // uPlot: the tooltip and the cards must show each series, not its cumulative
  // height.
  let raw: Columns = [[]]
  // Tooltip lines drawn from a series' `extras`, keyed by the point's epoch
  // milliseconds — the same `t` the query returned, so a point and its row meet
  // exactly however the reply was laid out on the bucket grid.
  let notes = new Map<number, (string | null)[]>()
  let selectTimer = 0

  /** Colour that stands for a series in the tooltip and on the chart. */
  const colorOf = (index: number) =>
    props.bars ? (props.fills?.[index] ?? BAR_FILL) : strokeFor(index)

  /**
   * Hand one card per series to the summary strip. A tile that draws more than
   * one line names the line in the card's title: two cards called "Living room
   * temperature" would say nothing about which sensor each one belongs to.
   */
  const publish = (values: (number | null)[]) => {
    const unit = unitOf(props.yLabel)
    const drawn = series()
    publishReadings(
      id,
      order,
      drawn.map((entry, index) => ({
        title: drawn.length > 1 ? `${props.title} · ${entry.label}` : props.title,
        unit,
        value: values[index] ?? null,
      })),
    )
  }

  /**
   * Newest value of every series in the plotted data, so the card always agrees
   * with the right-hand end of the chart and costs no extra query.
   */
  const newestValues = (columns: Columns): (number | null)[] =>
    series().map((_, index) => {
      const points = columns[index + 1] ?? []
      for (let at = points.length - 1; at >= 0; at--) {
        const value = points[at]
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return null
    })

  /**
   * The tooltip's second lines, one per series that has a `note`: the absolute
   * each bucket's percentage stands for, built from the row the tile already
   * fetched. Buckets whose extras are all missing are left out, so the tooltip
   * shows nothing rather than an empty line.
   */
  const noteMap = (rows: Array<Record<string, number | string>>) => {
    const map = new Map<number, (string | null)[]>()
    for (const row of rows) {
      const lines = series().map((entry, i) => {
        if (!entry.note) return null
        const values = (entry.extras ?? []).map((_, j) => {
          const value = row[`x${i}_${j}`]
          return typeof value === 'number' ? value : null
        })
        return entry.note(values)
      })
      if (lines.some((line) => line !== null)) map.set(Math.round(Number(row.t) * 1000), lines)
    }
    return map
  }

  // Built imperatively, like the tooltip and for the same underlying reason:
  // uPlot owns everything inside `container`, and Solid clears the children of
  // an element it manages. A conditional child here is compiled to a
  // markerless insert, whose cleanup is `parent.textContent = ""` — which took
  // uPlot's canvas with it.
  let spinner: HTMLDivElement | undefined

  const buildSpinner = (host: HTMLElement) => {
    const element = document.createElement('div')
    element.className = 'chart-spinner'
    element.style.display = 'none'
    host.append(element)
    return element
  }

  // The tooltip lives inside uPlot's `.u-over` element, which is the coordinate
  // space `cursor.left`/`cursor.top` are reported in.
  let tooltip: HTMLDivElement | undefined
  let tooltipTime: HTMLDivElement | undefined
  let tooltipValues: { value: HTMLSpanElement; note: HTMLSpanElement }[] = []

  const buildTooltip = (over: HTMLElement) => {
    const box = document.createElement('div')
    box.className = 'chart-tooltip'
    box.style.display = 'none'

    const time = document.createElement('div')
    time.className = 'chart-tooltip-time'
    box.append(time)

    tooltipValues = series().map((entry, index) => {
      const row = document.createElement('div')
      row.className = 'chart-tooltip-row'
      if (series().length > 1) {
        const swatch = document.createElement('span')
        swatch.className = 'chart-tooltip-swatch'
        swatch.style.background = colorOf(index)
        row.append(swatch)
      }
      const label = document.createElement('span')
      label.className = 'chart-tooltip-label'
      label.textContent = entry.label
      const value = document.createElement('span')
      value.className = 'chart-tooltip-value'
      const text = document.createElement('span')
      const note = document.createElement('span')
      note.className = 'chart-tooltip-note'
      value.append(text, note)
      row.append(label, value)
      box.append(row)
      return { value: text, note }
    })

    over.append(box)
    tooltip = box
    tooltipTime = time
  }

  const updateTooltip = (self: uPlot) => {
    if (!tooltip || !tooltipTime) return
    const { idx, left, top } = self.cursor
    const x = idx == null ? undefined : (self.data[0]?.[idx] as number | null | undefined)
    if (idx == null || left == null || top == null || left < 0 || x == null || !Number.isFinite(x)) {
      tooltip.style.display = 'none'
      return
    }

    const { from, to } = range()
    tooltipTime.textContent = formatTimestamp(x, to.getTime() - from.getTime())
    const unit = unitOf(props.yLabel)
    const at = Math.round(x * 1000)
    const lines = notes.get(at)
    series().forEach((_, index) => {
      const value = raw[index + 1]?.[idx]
      const cell = tooltipValues[index]
      cell.value.textContent =
        typeof value === 'number' ? `${formatNumber(value)}${unit ? ` ${unit}` : ''}` : '\u2014'
      // The absolute the plotted value stands for, when the series carries one.
      cell.note.textContent = lines?.[index] ?? ''
    })

    // Keep the box inside the plot: offset from the crosshair, flipping when
    // there is not enough room to the right or below. A synced cursor carries no
    // y of its own (see the sync config above), so that tooltip pins to the top
    // of the plot rather than sitting at an arbitrary height.
    tooltip.style.display = ''
    const anchorY = top < 0 ? 0 : top
    const gap = 12
    const boxWidth = tooltip.offsetWidth
    const boxHeight = tooltip.offsetHeight
    const offsetX = left + gap + boxWidth > self.over.clientWidth ? left - gap - boxWidth : left + gap
    const offsetY =
      anchorY + gap + boxHeight > self.over.clientHeight ? anchorY - gap - boxHeight : anchorY + gap
    tooltip.style.transform = `translate(${offsetX}px, ${offsetY}px)`
  }

  const options = (chartWidth: number): uPlot.Options => ({
    width: chartWidth,
    height: height(),
    pxAlign: 0,
    // uPlot pads the top and right edges of every chart by half its default
    // axis width (25px each) so an axis label cannot be clipped, even when
    // there is no top or right axis. Both are too generous here: the top needs
    // half a line of text so a tick at the very top of a fixed scale is whole,
    // and the edges need exactly as much as the corner labels hang over — no
    // more, and not a pixel less.
    padding: [
      8,
      (self) => Math.max(8, overhang(bookkeeping(self, 0)._values, -1)),
      0,
      (self) =>
        Math.max(0, overhang(bookkeeping(self, 0)._values, 0) - (bookkeeping(self, 1)._size ?? 0)),
    ],
    series: [
      {},
      ...series().map((s, index) =>
        props.bars
          ? {
              label: s.label,
              stroke: colorOf(index),
              width: 0,
              fill: colorOf(index),
              // 80% of the bucket width, at most 24px: a bucket is a census of
              // a time span, so the bar should read as that span.
              paths: uPlot.paths.bars!({ size: [0.8, 24] }),
              // uPlot turns point markers on by default once points are more
              // than a few pixels apart, which would dot the top of every bar
              // in a sparse window.
              points: { show: false },
            }
          : {
              label: s.label,
              stroke: strokeFor(index),
              width: 1,
              // Every series carries its own wash; each fades to the baseline,
              // so a lower series simply paints over the upper one's.
              fill: fillFor,
              // A bucket that holds no sample keeps its slot as null, and a null
              // breaks the line. A series sampled less often than the bucket —
              // container figures, once a minute — would disappear when zoomed
              // in; connect across it, as uPlot already does across a bucket that
              // has no rows at all.
              spanGaps: true,
              // A bucket without a fix is not a change of state: the step holds
              // the previous one until the next fix arrives. Spread rather than
              // set to undefined — uPlot merges options over its defaults, and an
              // explicit `paths: undefined` leaves it with no path builder at all.
              ...(props.step ? { paths: uPlot.paths.stepped!({ align: 1 }) } : {}),
              points: {
                show: () => showDots,
                size: 4,
                width: 1,
                stroke: strokeFor(index),
                fill: strokeFor(index),
              },
            },
      ),
    ],
    // A stack is drawn as bands: the topmost cumulative column fills from zero,
    // and every lower column paints only the slice between itself and the one
    // above it. Its own `fill` colours that slice, so the layers keep their
    // order — first series at the bottom — without uPlot having to know about
    // stacking.
    bands: props.stacked
      ? series()
          .slice(1)
          .map((_, index) => ({ series: [index + 2, index + 1] as [number, number] }))
      : undefined,
    axes: [
      {
        stroke: '#222',
        font: AXIS_FONT,
        grid: { show: false },
        ticks: { stroke: '#e0e0e0', width: 1 },
        // uPlot's own day/month/year ticks are month-first.
        values: (_self, splits, _axisIdx, _space, spacing) => axisTickLabels(splits, spacing),
        // Sized to the tallest label rather than uPlot's flat 50px: a rollover
        // tick carries a second line, the rest only one.
        size: (_self, values) => tickRoom(rowsOf(values)),
      },
      {
        stroke: '#222',
        font: AXIS_FONT,
        grid: { stroke: '#f0f0f0', width: 1 },
        ticks: { stroke: '#e0e0e0', width: 1 },
        // Spread rather than set to `undefined`: uPlot merges options over its
        // own defaults, so an explicit `values: undefined` replaces the formatter
        // it would have used and the axis throws on every frame.
        // A state axis has no values worth reading between its ends.
        ...(props.yTickEnds && props.yRange
          ? { splits: (_self: uPlot, _axis: number, _min: number, _max: number) => [props.yRange![0], props.yRange![1]] }
          : {}),
        ...(props.yTicks
          ? { values: (_self: uPlot, splits: number[]) => splits.map((split) => props.yTicks!(split)) }
          : {}),
        // As wide as the widest value it has to print, not a fixed 50px.
        size: (_self, values) =>
          tickRoom(1) + Math.max(0, ...(values ?? []).map((value) => measure(String(value ?? '')))),
      },
    ],
    // The x scale is the requested window rather than the extent of the data:
    // a window with no rows, or one that resolves to a single point, would
    // otherwise give a zero-width scale with no axis at all. Bars read their
    // height from the y axis, so theirs has to start at zero with a little
    // headroom above the tallest bucket; a line chart's comes from `yRange` or
    // `yFit`, and without either from uPlot's own extent.
    scales: props.bars
      ? {
          x: { time: true, range: () => xWindow },
          y: { range: (_self, _min, max) => [0, max ? max * 1.03 : 1] },
        }
      : props.yRange
        ? { x: { time: true, range: () => xWindow }, y: { range: () => props.yRange! } }
        : props.yFit
          ? { x: { time: true, range: () => xWindow }, y: { range: fitRange(props.yFit) } }
          : { x: { time: true, range: () => xWindow } },
    // No legend: the tile's title names the chart and the hover tooltip names
    // each line (with its own swatch), so a legend would only take height off
    // the plot — enough of it to push the chart under the tile below.
    legend: { show: false },
    cursor: {
      drag: { x: true, y: false, setScale: false },
      // uPlot shares the cursor between every tile with this key. Only x means
      // anything across tiles — each has its own y scale — so the y match always
      // fails: subscribers get top = -10, which uPlot turns into the `u-off`
      // class and hides the horizontal line, leaving the tile under the pointer
      // with its full crosshair.
      sync: {
        key: CURSOR_SYNC,
        scales: ['x', 'y'],
        match: [() => true, () => false],
        setSeries: true,
        // uPlot replaces the whole defaults object instead of merging into it,
        // so both filters have to be supplied even though they agree.
        filters: { pub: inSync, sub: inSync },
      },
    },
    hooks: {
      setCursor: [(self) => updateTooltip(self)],
      setSelect: [(self) => settleSelection(self)],
    },
  })

  /**
   * Hand a finished drag to the shared range. `setSelect` runs on every move of
   * the drag, so the range is only committed once the selection has been still
   * for a moment; until then uPlot keeps drawing the selection rectangle.
   */
  const settleSelection = (self: uPlot) => {
    window.clearTimeout(selectTimer)
    // uPlot mirrors a drag into every chart in the cursor sync group, and each
    // mirrored chart asks us to commit it too. Only the chart under the pointer
    // owns the selection: its events carry the DOM event, the mirrors get a
    // synthesised one.
    if (!self.cursor.event) {
      self.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
      return
    }
    const { left, width } = self.select
    const from = new Date(self.posToVal(left, 'x') * 1000)
    const to = new Date(self.posToVal(left + width, 'x') * 1000)
    const next = width >= MIN_SELECTION_PX && to > from ? { from, to } : null
    selectTimer = window.setTimeout(() => {
      self.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
      if (next) setCustomRange(next)
    }, SELECT_SETTLE_MS)
  }

  /** `background` is the periodic refresh, which must not flash the spinner. */
  const load = async (background = false) => {
    const chartWidth = width()
    if (!chartWidth || !chart) return

    const { from, to } = range()
    // A count bucket that saw no requests is zero, not missing. Bars therefore
    // get the complete bucket grid; a line just connects across a quiet spell.
    const bucket = bucketFor(from, to, chartWidth, props.bars ? BAR_BUCKET_PX : 1)
    if (props.bars) setBarMs(bucket.ms)
    const sql = props.query
      ? props.query(from, to)
      : timeSeriesSql({
          source: props.source,
          series: series(),
          bucket: bucket.sql,
          from,
          to,
        })

    // uPlot draws the epoch when the scale is unset, so a tile that is still
    // loading (or whose query failed) would show 1970 on its axis.
    xWindow = [from.getTime() / 1000, to.getTime() / 1000]

    const request = ++requestId
    if (!background) setLoading(true)
    try {
      const rows = props.metrics
        ? await fetchSeries<Array<Record<string, number | string>>>(
            props.metrics.map((entry) => entry.metric),
            bucket.ms,
            from,
            to,
          )
        : await fetchData<Array<Record<string, number | string>>>(sql)
      if (request !== requestId || !chart) return
      const columns = toAligned(
        rows ?? [],
        series().length,
        props.bars ? { from, to, bucketMs: bucket.ms, fill: 0 } : undefined,
      ) as Columns
      // A single bucket has no neighbour: uPlot derives a bar's width from the
      // gap to the next point, and a lone point draws no line. Pad the series
      // with a second, empty bucket so the bar keeps its bucket width.
      if (props.bars && columns[0].length === 1) {
        columns[0].push(columns[0][0] + bucket.ms / 1000)
        for (let i = 1; i < columns.length; i++) columns[i].push(0)
      }
      raw = columns
      notes = noteMap(rows ?? [])
      const xs = columns[0]
      xWindow = [
        Math.min(from.getTime() / 1000, xs[0] ?? Infinity),
        Math.max(
          to.getTime() / 1000,
          props.bars && xs.length > 0 ? xs[xs.length - 1] + bucket.ms / 1000 : -Infinity,
        ),
      ]
      showDots = !props.bars && xs.length > 0 && xs.length * DOT_SPACING_PX < chartWidth
      chart.setData(props.stacked ? stack(columns) : columns)
      publish(newestValues(columns))
    } catch (error) {
      if (request === requestId) console.error(`tile "${props.title}" query failed`, error)
    } finally {
      if (request === requestId) setLoading(false)
    }
  }

  onMount(() => {
    // Reserve the summary cards before the first query comes back, so the strip
    // appears at its final size (values reading `—`) instead of growing.
    publish(series().map(() => null))

    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0].contentRect.width)
      if (next > 0) setWidth(next)
    })
    observer.observe(container)

    const onViewportResize = () => setViewport(window.innerHeight)
    window.addEventListener('resize', onViewportResize)

    onCleanup(autoRefresh(() => load(true)))

    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener('resize', onViewportResize)
      clearTimeout(selectTimer)
      chart?.destroy()
      chart = undefined
      clearReadings(id)
      spinner = undefined
      tooltip = undefined
      tooltipTime = undefined
      tooltipValues = []
      if (isFullscreen()) exitFullscreen()
    })
  })

  createEffect(() => {
    const chartWidth = width()
    if (chartWidth <= 0) return
    range() // re-run when the selected range changes
    if (!chart) {
      chart = new uPlot(options(chartWidth), [[], ...series().map(() => [])], container)
      buildTooltip(chart.over)
      spinner = buildSpinner(container)
    }
    void load()
  })

  // Only a first load or a range change raises `loading`; the background refresh
  // leaves it alone, so this never flickers on the 30s tick. `loading()` is read
  // before the guard on purpose: behind it the effect would subscribe to nothing
  // and never re-run.
  createEffect(() => {
    const show = loading()
    if (spinner) spinner.style.display = show ? '' : 'none'
  })

  // Keep the plot matched to the tile, including when it goes fullscreen.
  createEffect(() => {
    const chartWidth = width()
    const chartHeight = height()
    if (chart && chartWidth > 0) chart.setSize({ width: chartWidth, height: chartHeight })
  })

  return (
    <section
      class="tile"
      classList={{ wide: props.wide, fullscreen: isFullscreen() }}
      onMouseEnter={() => setHoveredTile(id)}
      onMouseLeave={() => setHoveredTile(null)}
    >
      <header class="tile-title">
        {props.title}
        <Show when={props.bars && barMs()}>
          <span class="tile-note"> · per {formatBucket(barMs()!)}</span>
        </Show>
      </header>
      <Show when={!isFullscreen()}>
        <ExpandButton tile={id} />
      </Show>
      <Show when={isFullscreen()}>
        <button class="tile-close" onClick={exitFullscreen} aria-label="Exit fullscreen">
          ×
        </button>
      </Show>
      <div class="tile-body">
        {props.yLabel && <div class="tile-ylabel">↑ {props.yLabel}</div>}
        {/* Height is set up front so the tile does not grow when uPlot lands.
            Deliberately childless: uPlot owns this element. */}
        <div class="tile-chart" ref={container} style={{ height: `${height()}px` }} />
      </div>
    </section>
  )
}
