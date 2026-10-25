import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'

import { fetchData } from '../lib/api'
import { byteParts, formatAge, formatCompact, formatNumber } from '../lib/format'
import { type FileStats, filesSql, type Overview, overviewSql } from '../lib/query'
import { range } from '../lib/range'
import StatsStrip, { type Stat } from './StatsStrip'

const REFRESH_MS = 30_000
const JITTER_MS = 5_000

/**
 * Scalars above the acta dashboard: how much is stored, how quickly it is
 * arriving, and whether it is still arriving at all. Two queries, because the
 * file sizes come from the Parquet footers and must not take the event totals
 * down with them if the data directory cannot be found.
 */
export default function ActaStats() {
  const [overview, setOverview] = createSignal<Overview | null>(null)
  const [files, setFiles] = createSignal<FileStats | null>(null)
  let requestId = 0

  const load = async () => {
    const request = ++requestId
    const { from, to } = range()
    const [nextOverview, nextFiles] = await Promise.all([
      fetchData<Overview>(overviewSql(from, to)).catch((error) => {
        console.warn('overview stats query failed', error)
        return null
      }),
      fetchData<FileStats>(filesSql()).catch((error) => {
        console.warn('file stats query failed', error)
        return null
      }),
    ])
    if (request !== requestId) return
    if (nextOverview) setOverview(nextOverview)
    if (nextFiles) setFiles(nextFiles)
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

  const sizeDetail = () => {
    const current = files()
    if (!current) return undefined
    const parts = [`${formatCompact(current.files)} files`]
    if (current.rows > 0) parts.push(`${formatNumber(current.bytes / current.rows)} B/row`)
    return parts.join(' · ')
  }

  const stats = createMemo((): Stat[] => {
    const events = overview()
    const disk = files()
    const { from, to } = range()
    const spanMinutes = Math.max((to.getTime() - from.getTime()) / 60_000, 0)
    const hourMinutes = Math.min(spanMinutes, 60)
    const size = disk ? byteParts(disk.bytes) : null
    const newestAge = events?.newest == null ? null : Date.now() / 1000 - events.newest

    return [
      {
        label: 'Data on disk',
        value: size?.value ?? '—',
        unit: size?.unit,
        detail: sizeDetail(),
      },
      {
        label: 'Stored rows',
        value: disk ? formatCompact(disk.rows) : '—',
        detail: 'all files',
      },
      {
        label: 'In range',
        value: events ? formatCompact(events.rows) : '—',
        unit: 'entries',
        detail: events && spanMinutes > 0
          ? `${formatNumber(events.rows / spanMinutes)}/min`
          : undefined,
      },
      {
        label: 'Last hour',
        value: events && hourMinutes > 0
          ? formatNumber(events.last_hour / hourMinutes)
          : '—',
        unit: events && hourMinutes > 0 ? '/min' : undefined,
        detail: events ? `${formatCompact(events.last_hour)} entries` : undefined,
      },
      {
        label: 'Newest entry',
        value: newestAge === null ? '—' : formatAge(newestAge),
        unit: newestAge === null ? undefined : 'ago',
      },
      {
        label: 'Sources',
        value: events ? String(events.sources) : '—',
        title: events?.source_names.slice().sort().join(', '),
      },
    ]
  })

  return <StatsStrip stats={stats()} />
}
