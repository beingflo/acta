import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'

import { fetchData } from '../lib/api'
import { formatAge, formatClock, formatNumber } from '../lib/format'
import {
  BOARD_CRIT_C,
  BOARD_CRIT_HOLD_S,
  BOARD_SAMPLE_S,
  BOARD_SETTLE_S,
  BOARD_WARN_C,
  BOARD_WARN_HOLD_S,
  type BoardAlert,
  boardAlertSql,
} from '../lib/query'
import { range } from '../lib/range'
import { autoRefresh } from '../lib/refresh'
import StatsStrip, { type Stat } from './StatsStrip'

/**
 * The share of a window's samples that has to be there before its mean counts.
 * The service's check uses the same rule (`MIN_COVERAGE` in `alerts.rs`): a mean
 * over a gap is not a reading, so a thin window meets no level.
 */
const MIN_COVERAGE = 0.5

const covered = (samples: number, windowSeconds: number) =>
  samples >= (MIN_COVERAGE * windowSeconds) / BOARD_SAMPLE_S

const temperature = (value: number | null | undefined) =>
  value == null ? '—' : formatNumber(value)

/**
 * The board temperature alert as the service's check sees it: the same three
 * means over the same three windows, the sample counts they rest on, and the
 * level they add up to. The windows are fixed — they are the check's, not the
 * range picker's — so this strip reads the last hour of the data every time,
 * whatever span the chart below is showing.
 */
export default function AlertChecks(props: { source: string }) {
  const [check, setCheck] = createSignal<BoardAlert | null>(null)
  let requestId = 0

  const load = async () => {
    const request = ++requestId
    try {
      const next = await fetchData<BoardAlert>(boardAlertSql(props.source, new Date()))
      if (request === requestId) setCheck(next)
    } catch (error) {
      if (request === requestId) console.warn('alert check query failed', error)
    }
  }

  // Neither signal is read by the query — the windows are the check's own — but a
  // dashboard that names another source, and a window the reader just changed, are
  // both the moment to read again.
  createEffect(() => {
    props.source
    range()
    void load()
  })

  onMount(() => {
    onCleanup(autoRefresh(load))
    onCleanup(() => {
      requestId++ // drop replies that are still in flight
    })
  })

  // The level the service would mail about, from the same means and the same
  // covered windows. `unknown` is a lookback with nothing in it at all.
  const level = createMemo((): 'crit' | 'warn' | 'ok' | 'unknown' => {
    const sample = check()
    if (!sample) return 'unknown'
    if (sample.samples === 0) return 'unknown'
    const crit =
      covered(sample.n_5m, BOARD_CRIT_HOLD_S) && (sample.mean_5m ?? 0) > BOARD_CRIT_C
    if (crit) return 'crit'
    const warn = covered(sample.n_1h, BOARD_WARN_HOLD_S) && (sample.mean_1h ?? 0) > BOARD_WARN_C
    return warn ? 'warn' : 'ok'
  })

  const stats = createMemo((): Stat[] => {
    const sample = check()
    const mean = (value: number | null, windowSeconds: number, samples: number) =>
      covered(samples, windowSeconds) ? temperature(value) : '—'
    const newestAge = sample?.newest == null ? null : Date.now() / 1_000 - sample.newest
    const since = sample?.since == null ? null : formatClock(sample.since)
    const thin = sample ? !covered(sample.n_1h, BOARD_WARN_HOLD_S) : false

    const levelDetail = {
      crit: `mean over ${BOARD_CRIT_HOLD_S / 60} min above ${BOARD_CRIT_C} °C`,
      warn: `mean over ${BOARD_WARN_HOLD_S / 60} min above ${BOARD_WARN_C} °C`,
      ok: `no level met`,
      unknown: `no samples in the last hour`,
    }

    return [
      {
        label: 'check',
        value: level(),
        detail: levelDetail[level()],
        alert: level() !== 'ok' && level() !== 'unknown',
      },
      {
        label: 'Board now',
        value: temperature(sample?.current),
        unit: sample?.current == null ? undefined : '°C',
        detail:
          newestAge == null
            ? 'no reading'
            : `newest sample ${formatAge(newestAge)} ago`,
      },
      {
        label: `Mean ${BOARD_WARN_HOLD_S / 60} min`,
        value: mean(sample?.mean_1h ?? null, BOARD_WARN_HOLD_S, sample?.n_1h ?? 0),
        unit: '°C',
        detail: `warns above ${BOARD_WARN_C} °C`,
        alert:
          !!sample &&
          covered(sample.n_1h, BOARD_WARN_HOLD_S) &&
          (sample.mean_1h ?? 0) > BOARD_WARN_C,
      },
      {
        label: `Mean ${BOARD_CRIT_HOLD_S / 60} min`,
        value: mean(sample?.mean_5m ?? null, BOARD_CRIT_HOLD_S, sample?.n_5m ?? 0),
        unit: '°C',
        detail: `critical above ${BOARD_CRIT_C} °C`,
        alert:
          !!sample &&
          covered(sample.n_5m, BOARD_CRIT_HOLD_S) &&
          (sample.mean_5m ?? 0) > BOARD_CRIT_C,
      },
      {
        label: `Mean ${BOARD_SETTLE_S / 60} min`,
        value: mean(sample?.mean_settle ?? null, BOARD_SETTLE_S, sample?.n_settle ?? 0),
        unit: '°C',
        detail: `clears at or below ${BOARD_WARN_C} °C`,
        alert:
          !!sample &&
          covered(sample.n_settle, BOARD_SETTLE_S) &&
          (sample.mean_settle ?? 0) > BOARD_WARN_C,
      },
      {
        label: 'Peak, last hour',
        value: temperature(sample?.peak),
        unit: sample?.peak == null ? undefined : '°C',
        detail: since ? `first above ${BOARD_WARN_C} °C at ${since}` : undefined,
      },
      {
        label: 'Samples',
        value: sample ? formatNumber(sample.samples) : '—',
        detail: sample
          ? `${BOARD_CRIT_HOLD_S / 60} min ${sample.n_5m} · ${
              BOARD_SETTLE_S / 60
            } min ${sample.n_settle}`
          : undefined,
        alert: thin,
        title: sample
          ? `A window needs ${Math.round(
              (MIN_COVERAGE * BOARD_WARN_HOLD_S) / BOARD_SAMPLE_S,
            )} of the ${BOARD_WARN_HOLD_S / 3_600} h window's samples before its mean counts`
          : undefined,
      },
    ]
  })

  return <StatsStrip stats={stats()} />
}
