import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

import { fetchData } from '../lib/api'
import { exitFullscreen, fullscreenTile, setHoveredTile } from '../lib/fullscreen'
import { formatNumber, formatTimestamp, unitOf } from '../lib/format'
import { clearReadings, claimReadingOrder, publishReadings } from '../lib/latest'
import { fillFor, strokeFor } from '../lib/palette'
import { bucketFor, timeSeriesSql, toAligned, type Series } from '../lib/query'
import { dateOnlyRange, range, setCustomRange } from '../lib/range'

const REFRESH_MS = 30_000
const JITTER_MS = 5_000
const AXIS_FONT = '11px ui-sans-serif, system-ui, sans-serif'
const DEFAULT_HEIGHT = 300
// Header height (`--header-height`) plus the tile's own title, label and padding.
const FULLSCREEN_CHROME = 130

/** All tiles join one uPlot sync group, so the cursor is shared between them. */
const CURSOR_SYNC = 'acta-cursor'


export default function TimeSeriesTile(props: {
  title: string
  source: string
  series: Series[]
  yLabel?: string
  height?: number
  wide?: boolean
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
  const newestValues = (aligned: uPlot.AlignedData): (number | null)[] => {
    const columns = aligned.slice(1) as (number | null | undefined)[][]
    return props.series.map((_, index) => {
      const points = columns[index] ?? []
      for (let at = points.length - 1; at >= 0; at--) {
        const value = points[at]
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return null
    })
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
  let tooltipValues: HTMLSpanElement[] = []

  const buildTooltip = (over: HTMLElement) => {
    const box = document.createElement('div')
    box.className = 'chart-tooltip'
    box.style.display = 'none'

    const time = document.createElement('div')
    time.className = 'chart-tooltip-time'
    box.append(time)

    tooltipValues = props.series.map((series) => {
      const row = document.createElement('div')
      row.className = 'chart-tooltip-row'
      if (props.series.length > 1) {
        const swatch = document.createElement('span')
        swatch.className = 'chart-tooltip-swatch'
        swatch.style.background = strokeFor(series.metric)
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

    tooltipTime.textContent = formatTimestamp(x, dateOnlyRange())
    const unit = unitOf(props.yLabel)
    props.series.forEach((_, index) => {
      const value = self.data[index + 1]?.[idx]
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
    series: [
      {},
      ...props.series.map((s) => ({
        label: s.label,
        stroke: strokeFor(s.metric),
        width: 1,
        fill: fillFor(s.metric),
      })),
    ],
    axes: [
      {
        stroke: '#222',
        font: AXIS_FONT,
        grid: { show: false },
        ticks: { stroke: '#e0e0e0', width: 1 },
      },
      {
        stroke: '#222',
        font: AXIS_FONT,
        grid: { stroke: '#f0f0f0', width: 1 },
        ticks: { stroke: '#e0e0e0', width: 1 },
      },
    ],
    scales: { x: { time: true } },
    legend: { show: props.series.length > 1 },
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
      setSelect: [
        (self) => {
          const { left, width: selection } = self.select
          self.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
          if (selection < 8) return
          const from = new Date(self.posToVal(left, 'x') * 1000)
          const to = new Date(self.posToVal(left + selection, 'x') * 1000)
          if (to > from) setCustomRange({ from, to })
        },
      ],
    },
  })

  /** `background` is the periodic refresh, which must not flash the spinner. */
  const load = async (background = false) => {
    const chartWidth = width()
    if (!chartWidth || !chart) return

    const { from, to } = range()
    const sql = timeSeriesSql({
      source: props.source,
      series: props.series,
      bucket: bucketFor(from, to, chartWidth),
      from,
      to,
    })

    const request = ++requestId
    if (!background) setLoading(true)
    try {
      const rows = await fetchData<Array<Record<string, number | string>>>(sql)
      if (request !== requestId || !chart) return
      const aligned = toAligned(rows ?? [], props.series.length)
      chart.setData(aligned)
      publish(newestValues(aligned))
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

    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await load(true)
        schedule()
      }, REFRESH_MS + Math.random() * JITTER_MS)
    }
    schedule()

    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener('resize', onViewportResize)
      clearTimeout(timer)
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
      <header class="tile-title">{props.title}</header>
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
