import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'

import { fetchData } from '../lib/api'
import { formatAge, formatCompact, formatNumber, latencyParts } from '../lib/format'
import { type RequestOverview, requestOverviewSql } from '../lib/query'
import { range } from '../lib/range'
import StatsStrip, { type Stat } from './StatsStrip'

const REFRESH_MS = 30_000
const JITTER_MS = 5_000

/**
 * Scalars above the request chart: volume and rate, how much of it was
 * rejected, how slow it was, and when the newest request arrived. The all-time
 * count and the newest request ignore the selected window, so they keep
 * reading correctly when the window is stepped back in time.
 */
export default function MarendingStats(props: { source: string }) {
  const [overview, setOverview] = createSignal<RequestOverview | null>(null)
  let requestId = 0

  const load = async () => {
    const request = ++requestId
    const { from, to } = range()
    try {
      const next = await fetchData<RequestOverview>(
        requestOverviewSql(props.source, from, to),
      )
      if (request === requestId) setOverview(next)
    } catch (error) {
      if (request === requestId) console.warn('request stats query failed', error)
    }
  }

  createEffect(() => {
    range() // re-run when the selected window changes
    void load()
  })

  onMount(() => {
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await load()
        schedule()
      }, REFRESH_MS + Math.random() * JITTER_MS)
    }
    schedule()
    onCleanup(() => {
      clearTimeout(timer)
      requestId++ // drop replies that are still in flight
    })
  })

  const stats = createMemo((): Stat[] => {
    const requests = overview()
    const { from, to } = range()
    const spanMinutes = Math.max((to.getTime() - from.getTime()) / 60_000, 0)
    const hourMinutes = Math.min(spanMinutes, 60)
    const p95 = latencyParts(requests?.p95_ns == null ? null : requests.p95_ns / 1e6)
    const p50 = latencyParts(requests?.p50_ns == null ? null : requests.p50_ns / 1e6)
    const errorRate =
      requests && requests.rows > 0 ? (requests.errors / requests.rows) * 100 : null
    const newestAge =
      requests?.newest == null ? null : Date.now() / 1000 - requests.newest

    return [
      {
        label: 'All requests',
        value: requests ? formatCompact(requests.all_rows) : '—',
        detail: 'all time',
      },
      {
        label: 'In range',
        value: requests ? formatCompact(requests.rows) : '—',
        unit: 'requests',
        detail: requests && spanMinutes > 0
          ? `${formatNumber(requests.rows / spanMinutes)}/min`
          : undefined,
      },
      {
        label: 'Last hour',
        value: requests && hourMinutes > 0
          ? formatNumber(requests.last_hour / hourMinutes)
          : '—',
        unit: requests && hourMinutes > 0 ? '/min' : undefined,
        detail: requests ? `${formatCompact(requests.last_hour)} requests` : undefined,
      },
      {
        label: 'Error rate',
        value: errorRate === null ? '—' : formatNumber(errorRate),
        unit: errorRate === null ? undefined : '%',
        detail: requests ? `${formatCompact(requests.errors)} errors` : undefined,
      },
      {
        label: 'Latency p95',
        value: p95?.value ?? '—',
        unit: p95?.unit,
        detail: p50 ? `median ${p50.value} ${p50.unit}` : undefined,
      },
      {
        label: 'Newest request',
        value: newestAge === null ? '—' : formatAge(newestAge),
        unit: newestAge === null ? undefined : 'ago',
      },
    ]
  })

  return <StatsStrip stats={stats()} />
}
