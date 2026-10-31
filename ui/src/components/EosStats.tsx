import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'

import { fetchData } from '../lib/api'
import { byteParts, formatAge, formatCompact, formatNumber } from '../lib/format'
import { type EosOverview, eosOverviewSql } from '../lib/query'
import { range } from '../lib/range'
import { autoRefresh } from '../lib/refresh'
import StatsStrip, { type Stat } from './StatsStrip'

/** MiB as a card's two-part byte value: `{ value: '1.6', unit: 'GB' }`. */
const mib = (value: number) => byteParts(value * 1024 ** 2)

/**
 * Scalars above the eos charts: how long the box has been up, whether it is
 * still reporting, and the host gauges at their worst in the window. CPU,
 * memory and board temperature show the window's average with its peak beside
 * it — an average says what the box did, the peak says how far it went. Disk,
 * battery and containers read the newest sample instead, since they are state
 * rather than traffic. The age of the newest sample is taken over the whole
 * dataset, so a collector that stopped is visible even when the window has been
 * stepped back in time.
 */
export default function EosStats(props: { source: string }) {
  const [overview, setOverview] = createSignal<EosOverview | null>(null)
  let requestId = 0

  const load = async () => {
    const request = ++requestId
    const { from, to } = range()
    try {
      const next = await fetchData<EosOverview>(eosOverviewSql(props.source, from, to))
      if (request === requestId) setOverview(next)
    } catch (error) {
      if (request === requestId) console.warn('eos stats query failed', error)
    }
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

  const stats = createMemo((): Stat[] => {
    const sample = overview()
    const newestAge = sample?.newest == null ? null : Date.now() / 1000 - sample.newest
    const memory = sample?.mem_avg_mb == null ? null : mib(sample.mem_avg_mb)
    const total = sample?.mem_total_mb == null ? null : mib(sample.mem_total_mb)
    const containerMemory =
      sample?.containers_mem_mb == null ? null : mib(sample.containers_mem_mb)
    const cpuDetail = [
      sample?.cpu_peak == null ? null : `peak ${formatNumber(sample.cpu_peak)}%`,
      sample?.load1 == null ? null : `load ${formatNumber(sample.load1)}`,
    ]
    const memoryDetail = [
      total ? `of ${total.value} ${total.unit}` : null,
      sample?.mem_peak_pct == null ? null : `peak ${formatNumber(sample.mem_peak_pct)}%`,
    ]
    const diskDetail = [
      sample?.disk_used_gb == null ? null : `${formatNumber(sample.disk_used_gb)} GB used`,
      sample?.boot_used_pct == null ? null : `/boot ${formatNumber(sample.boot_used_pct)}%`,
    ]
    const batteryDetail = [
      sample?.battery_status?.toLowerCase() ?? null,
      sample?.battery_power_w == null ? null : `${formatNumber(sample.battery_power_w)} W`,
    ]
    const containerDetail = [
      sample?.containers_cpu_pct == null
        ? null
        : `${formatNumber(sample.containers_cpu_pct)}% CPU`,
      containerMemory ? `${containerMemory.value} ${containerMemory.unit}` : null,
    ]
    const detail = (parts: Array<string | null>) =>
      parts.filter((part) => part !== null).join(' · ') || undefined

    return [
      {
        label: 'Uptime',
        value: sample?.uptime_s == null ? '—' : formatAge(sample.uptime_s),
        detail: sample?.cores == null ? undefined : `${sample.cores} cores`,
      },
      {
        label: 'Newest sample',
        value: newestAge === null ? '—' : formatAge(newestAge),
        unit: newestAge === null ? undefined : 'ago',
        detail: sample ? `${formatCompact(sample.samples)} samples` : undefined,
      },
      {
        label: 'CPU',
        value: sample?.cpu_avg == null ? '—' : formatNumber(sample.cpu_avg),
        unit: sample?.cpu_avg == null ? undefined : '%',
        detail: detail(cpuDetail),
      },
      {
        label: 'Memory',
        value: memory?.value ?? '—',
        unit: memory?.unit,
        detail: detail(memoryDetail),
      },
      {
        label: 'Board temperature',
        value: sample?.temp_peak_c == null ? '—' : formatNumber(sample.temp_peak_c),
        unit: sample?.temp_peak_c == null ? undefined : '°C',
        detail: detail([
          sample?.temp_avg_c == null ? null : `avg ${sample.temp_avg_c.toFixed(1)} °C`,
        ]),
      },
      {
        label: 'Disk',
        value: sample?.disk_used_pct == null ? '—' : formatNumber(sample.disk_used_pct),
        unit: sample?.disk_used_pct == null ? undefined : '%',
        detail: detail(diskDetail),
      },
      {
        label: 'Battery',
        value: sample?.charge_pct == null ? '—' : formatNumber(sample.charge_pct),
        unit: sample?.charge_pct == null ? undefined : '%',
        detail: detail(batteryDetail),
      },
      {
        label: 'Containers',
        value: sample?.containers == null ? '—' : String(sample.containers),
        detail: detail(containerDetail),
      },
    ]
  })

  return <StatsStrip stats={stats()} />
}
