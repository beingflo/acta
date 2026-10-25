import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

import { fetchData } from '../lib/api'
import { exitFullscreen, fullscreenTile, setHoveredTile } from '../lib/fullscreen'
import ExpandButton from './ExpandButton'
import { axisTickLabels, formatBucket, formatNumber, formatTimestamp, unitOf } from '../lib/format'
import { clearReadings, claimReadingOrder, publishReadings } from '../lib/latest'
import { BAR_FILL, fillFor, STROKE } from '../lib/palette'
import { bucketFor, timeSeriesSql, toAligned, type Series } from '../lib/query'
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
  series: Series[]
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
}) {
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
  let selectTimer = 0

  /** Colour that stands for a series in the tooltip and on the chart. */
  const colorOf = (index: number) => (props.bars ? (props.fills?.[index] ?? BAR_FILL) : STROKE)

  /** Hand one card per series to the summary strip. */
  const publish = (values: (number | null)[]) => {
    const unit = unitOf(props.yLabel)
    publishReadings(
      id,
      order,
      props.series.map((_, index) => ({ title: props.title, unit, value: values[index] ?? null })),
    )
  }

  /**
   * Newest value of every series in the plotted data, so the card always agrees
   * with the right-hand end of the chart and costs no extra query.
   */
  const newestValues = (columns: Columns): (number | null)[] =>
    props.series.map((_, index) => {
      const points = columns[index + 1] ?? []
      for (let at = points.length - 1; at >= 0; at--) {
        const value = points[at]
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return null
    })

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
  let tooltipValues: HTMLSpanElement[] = []

  const buildTooltip = (over: HTMLElement) => {
    const box = document.createElement('div')
    box.className = 'chart-tooltip'
    box.style.display = 'none'

    const time = document.createElement('div')
    time.className = 'chart-tooltip-time'
    box.append(time)

    tooltipValues = props.series.map((series, index) => {
      const row = document.createElement('div')
      row.className = 'chart-tooltip-row'
      if (props.series.length > 1) {
        const swatch = document.createElement('span')
        swatch.className = 'chart-tooltip-swatch'
        swatch.style.background = colorOf(index)
        row.append(swatch)
      }
      const label = document.createElement('span')
      label.className = 'chart-tooltip-label'
      label.textContent = series.label
      const value = document.createElement('span')
      value.className = 'chart-tooltip-value'
      row.append(label, value)
      box.append(row)
      return value
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
    props.series.forEach((_, index) => {
      const value = raw[index + 1]?.[idx]
      tooltipValues[index].textContent =
        typeof value === 'number' ? `${formatNumber(value)}${unit ? ` ${unit}` : ''}` : '\u2014'
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
      ...props.series.map((s, index) =>
        props.bars
          ? {
              label: s.label,
              stroke: STROKE,
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
              stroke: STROKE,
              width: 1,
              fill: fillFor,
              // A bucket that holds no sample keeps its slot as null, and a null
              // breaks the line. A series sampled less often than the bucket —
              // container figures, once a minute — would disappear when zoomed
              // in; connect across it, as uPlot already does across a bucket that
              // has no rows at all.
              spanGaps: true,
              points: { show: () => showDots, size: 4, width: 1, stroke: STROKE, fill: STROKE },
            },
      ),
    ],
    // A stack is drawn as bands: the topmost cumulative column fills from zero,
    // and every lower column paints only the slice between itself and the one
    // above it. Its own `fill` colours that slice, so the layers keep their
    // order — first series at the bottom — without uPlot having to know about
    // stacking.
    bands: props.stacked
      ? props.series
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
        // As wide as the widest value it has to print, not a fixed 50px.
        size: (_self, values) =>
          tickRoom(1) + Math.max(0, ...(values ?? []).map((value) => measure(String(value ?? '')))),
      },
    ],
    // The x scale is the requested window rather than the extent of the data:
    // a window with no rows, or one that resolves to a single point, would
    // otherwise give a zero-width scale with no axis at all. Bars read their
    // height from the y axis, so their scale has to start at zero, with a little
    // headroom above the tallest bar; a line chart is free to use the full
    // vertical space.
    scales: props.bars
      ? {
          x: { time: true, range: () => xWindow },
          y: { range: (_self, _min, max) => [0, max ? max * 1.03 : 1] },
        }
      : props.yRange
        ? { x: { time: true, range: () => xWindow }, y: { range: () => props.yRange! } }
        : { x: { time: true, range: () => xWindow } },
    legend: { show: props.series.length > 1 && !props.stacked },
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
    const sql = timeSeriesSql({
      source: props.source,
      series: props.series,
      bucket: bucket.sql,
      from,
      to,
    })

    const request = ++requestId
    if (!background) setLoading(true)
    try {
      const rows = await fetchData<Array<Record<string, number | string>>>(sql)
      if (request !== requestId || !chart) return
      const columns = toAligned(
        rows ?? [],
        props.series.length,
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
    publish(props.series.map(() => null))

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
      chart = new uPlot(options(chartWidth), [[], ...props.series.map(() => [])], container)
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
