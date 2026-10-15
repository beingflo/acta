import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

import { fetchData } from '../lib/api'
import { exitFullscreen, fullscreenTile, setHoveredTile } from '../lib/fullscreen'
import { fillFor, strokeFor } from '../lib/palette'
import { bucketFor, timeSeriesSql, toAligned, type Series } from '../lib/query'
import { range, setCustomRange } from '../lib/range'

const REFRESH_MS = 30_000
const JITTER_MS = 5_000
const AXIS_FONT = '11px ui-sans-serif, system-ui, sans-serif'
const DEFAULT_HEIGHT = 300
// Header height (`--header-height`) plus the tile's own title, label and padding.
const FULLSCREEN_CHROME = 130

export default function TimeSeriesTile(props: {
  title: string
  source: string
  series: Series[]
  yLabel?: string
  height?: number
  wide?: boolean
}) {
  const id = props.title
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
    cursor: { drag: { x: true, y: false, setScale: false } },
    hooks: {
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

  const load = async () => {
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
    try {
      const rows = await fetchData<Array<Record<string, number | string>>>(sql)
      if (request !== requestId || !chart) return
      chart.setData(toAligned(rows ?? [], props.series.length))
    } catch (error) {
      if (request === requestId) console.error(`tile "${props.title}" query failed`, error)
    }
  }

  onMount(() => {
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
        await load()
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
      if (isFullscreen()) exitFullscreen()
    })
  })

  createEffect(() => {
    const chartWidth = width()
    if (chartWidth <= 0) return
    range() // re-run when the selected range changes
    if (!chart) {
      chart = new uPlot(options(chartWidth), [[], ...props.series.map(() => [])], container)
    }
    void load()
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
        <div class="tile-chart" ref={container} />
      </div>
    </section>
  )
}
