import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'

import { fetchData } from '../lib/api'
import { byteParts, formatAge, formatCompact, formatNumber } from '../lib/format'
import {
  type BackupStats,
  backupSql,
  type FileStats,
  filesSql,
  type Overview,
  overviewSql,
} from '../lib/query'
import { range } from '../lib/range'
import { autoRefresh } from '../lib/refresh'
import StatsStrip, { type Stat } from './StatsStrip'

/** A backup older than a day no longer describes the system that is running. */
const BACKUP_STALE_S = 86_400

/**
 * Scalars above the acta dashboard: how much is stored, how quickly it is
 * arriving, and whether it is still arriving at all. Three queries, because the
 * file sizes come from the Parquet footers and the backup age from the backup's
 * own rows, and neither should take the event totals down with it.
 */
export default function ActaStats() {
  const [overview, setOverview] = createSignal<Overview | null>(null)
  const [files, setFiles] = createSignal<FileStats | null>(null)
  const [backup, setBackup] = createSignal<BackupStats | null>(null)
  let requestId = 0

  const load = async () => {
    const request = ++requestId
    const { from, to } = range()
    const [nextOverview, nextFiles, nextBackup] = await Promise.all([
      fetchData<Overview>(overviewSql(from, to)).catch((error) => {
        console.warn('overview stats query failed', error)
        return null
      }),
      fetchData<FileStats>(filesSql()).catch((error) => {
        console.warn('file stats query failed', error)
        return null
      }),
      fetchData<BackupStats>(backupSql()).catch((error) => {
        console.warn('backup stats query failed', error)
        return null
      }),
    ])
    if (request !== requestId) return
    if (nextOverview) setOverview(nextOverview)
    if (nextFiles) setFiles(nextFiles)
    if (nextBackup) setBackup(nextBackup)
  }

  createEffect(() => {
    range() // re-run when the selected window changes
    void load()
  })

  onMount(() => {
    onCleanup(autoRefresh(load))
    onCleanup(() => {
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

    // The backup card only appears once a pass has been recorded. Before that
    // the backup may simply be off, and a red "never" on a box that does not
    // back up would be noise; a backup that is on but has never succeeded does
    // report, so it cannot hide here.
    const lastBackup = backup()
    const backupStats: Stat[] = []
    if (lastBackup && lastBackup.passes > 0) {
      const age = lastBackup.last_success == null
        ? null
        : Date.now() / 1000 - lastBackup.last_success
      const failed = lastBackup.newest_ok === false
      backupStats.push({
        label: 'Last backup',
        value: age == null ? 'never' : formatAge(age),
        unit: age == null ? undefined : 'ago',
        detail: failed
          ? `failed: ${lastBackup.last_error ?? 'unknown error'}`
          : `${lastBackup.last_uploaded ?? 0} uploaded`,
        title: failed ? (lastBackup.last_error ?? undefined) : 'hourly S3 pass',
        alert: age == null || age > BACKUP_STALE_S,
      })
    }

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
      ...backupStats,
    ]
  })

  return <StatsStrip stats={stats()} />
}
