import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import { fetchData } from '../lib/api'
import { formatAge, formatClock, formatNumber, formatTimestamp } from '../lib/format'
import {
  ALERTS,
  type AlertCheck,
  type AlertSpec,
  type StaleCheck,
  alertCheckSql,
} from '../lib/query'
import { range } from '../lib/range'
import { autoRefresh } from '../lib/refresh'

/**
 * The share of a window's samples that has to be there before its mean counts.
 * The service's checks use the same rule (`MIN_COVERAGE` in `alerts.rs`): a mean
 * over a gap is not a reading, so a thin window meets no mark.
 */
const MIN_COVERAGE = 0.5

const covered = (n: number, windowS: number, sampleS: number) =>
  n >= (MIN_COVERAGE * windowS) / sampleS

/** A window as the card writes it: `1 h`, `5 min`, `10 min`. */
const span = (seconds: number) =>
  seconds % 3_600 === 0 ? `${seconds / 3_600} h` : `${Math.round(seconds / 60)} min`

const number = (value: number | null | undefined) => (value == null ? '—' : formatNumber(value))

/** The level the service's check would reach, from the same means and the same
 *  windows: `unknown` is a lookback with nothing to average. */
type Level = 'ok' | 'warn' | 'crit' | 'unknown'

/** One check's answer, in whichever shape its spec asked for. */
type Check = AlertCheck | StaleCheck

const secondsAgo = (epoch: number) => Date.now() / 1_000 - epoch

function levelOf(spec: AlertSpec, check: Check | null): Level {
  if (check == null) return 'unknown'

  if (spec.kind === 'stale') {
    const stale = check as StaleCheck
    // Nothing in the lookback is the longest silence there is, so it counts as
    // silent rather than as unknown — the service says the same.
    const silent = stale.newest == null || secondsAgo(stale.newest) >= spec.afterS
    return silent ? 'warn' : 'ok'
  }

  const mean = check as AlertCheck
  if (!mean.marks.some((mark) => mark.mean != null)) return 'unknown'
  let level: Level = 'ok'
  spec.marks.forEach((mark, index) => {
    const read = mean.marks[index]
    if (!read || read.mean == null) return
    if (!covered(read.n, mark.windowS, spec.sampleS)) return
    const met = mark.side === 'above' ? read.mean > mark.threshold : read.mean < mark.threshold
    if (met) level = index === 0 ? 'warn' : 'crit'
  })
  return level
}

/** One scalar inside a card: a label, the number with its unit, and the line that
 *  says what the number is compared against. */
type Metric = {
  label: string
  value: string
  unit?: string
  detail?: string
  /** The reading that would (or does) raise the alert. */
  hot?: boolean
}

function meanMetrics(spec: AlertSpec & { kind: 'mean' }, check: AlertCheck | null): Metric[] {
  const side = spec.marks[0].side
  const lowest = spec.marks[0]
  const lookback = Math.max(spec.settleS, ...spec.marks.map((mark) => mark.windowS))
  const newestAge = check?.newest == null ? null : secondsAgo(check.newest)
  const since = check?.since == null ? null : formatClock(check.since)
  const extreme = side === 'above' ? check?.highest : check?.lowest
  const mean = (read: { n: number; mean: number | null } | undefined, windowS: number) =>
    read && covered(read.n, windowS, spec.sampleS) ? number(read.mean) : '—'

  const marks = spec.marks.map((mark, index): Metric => {
    const read = check?.marks[index]
    const met =
      !!read &&
      covered(read.n, mark.windowS, spec.sampleS) &&
      (mark.side === 'above' ? (read.mean ?? 0) > mark.threshold : (read.mean ?? 0) < mark.threshold)
    return {
      label: `mean ${span(mark.windowS)}`,
      value: mean(read, mark.windowS),
      unit: spec.unit,
      detail: `${index === 0 ? 'warn' : 'crit'} ${mark.side} ${mark.threshold} ${spec.unit}`,
      hot: met,
    }
  })

  return [
    {
      label: 'now',
      value: number(check?.current),
      unit: check?.current == null ? undefined : spec.unit,
      detail: newestAge == null ? 'no reading' : `newest sample ${formatAge(newestAge)} ago`,
    },
    ...marks,
    {
      label: `mean ${span(spec.settleS)}`,
      value: mean(
        check ? { n: check.n_settle, mean: check.mean_settle } : undefined,
        spec.settleS,
      ),
      unit: spec.unit,
      detail: `clears ${side === 'above' ? 'at or below' : 'at or above'} ${lowest.threshold} ${
        spec.unit
      }`,
      hot:
        !!check &&
        covered(check.n_settle, spec.settleS, spec.sampleS) &&
        (side === 'above'
          ? (check.mean_settle ?? 0) > lowest.threshold
          : (check.mean_settle ?? 0) < lowest.threshold),
    },
    {
      label: `${side === 'above' ? 'highest' : 'lowest'}, ${span(lookback)}`,
      value: number(extreme),
      unit: extreme == null ? undefined : spec.unit,
      detail: since ? `first ${side} ${lowest.threshold} at ${since}` : undefined,
    },
  ]
}

function staleMetrics(spec: AlertSpec & { kind: 'stale' }, check: StaleCheck | null): Metric[] {
  const newest = check?.newest ?? null
  const age = newest == null ? null : secondsAgo(newest)
  const silent = age == null || age >= spec.afterS
  const lookback = 2 * spec.afterS

  return [
    {
      label: 'silent for',
      value: age == null ? `> ${formatAge(lookback)}` : formatAge(age),
      detail: `fires after ${formatAge(spec.afterS)}`,
      hot: silent,
    },
    {
      label: 'newest sample',
      value: newest == null ? '—' : formatClock(newest),
      // The day behind the clock, at the width the card has room for.
      detail: newest == null ? 'nothing in the lookback' : formatTimestamp(newest, lookback * 1_000).slice(0, 10),
    },
    {
      label: `samples, ${formatAge(lookback)}`,
      value: check == null ? '—' : formatNumber(check.samples),
      detail: 'any one clears it',
    },
  ]
}

function metricsOf(spec: AlertSpec, check: Check | null): Metric[] {
  if (spec.kind === 'stale') return staleMetrics(spec, check as StaleCheck | null)
  return meanMetrics(spec, check as AlertCheck | null)
}

function Card(props: { spec: AlertSpec; check: Check | null }) {
  const level = createMemo(() => levelOf(props.spec, props.check))
  const metrics = createMemo(() => metricsOf(props.spec, props.check))

  return (
    <section
      class="alert-card"
      classList={{
        'alert-card-warn': level() === 'warn',
        'alert-card-crit': level() === 'crit',
      }}
    >
      <header class="alert-card-head">
        <span class="alert-card-title">{props.spec.title}</span>
        {/* A check reads on its own cadence, so the card says which: the numbers
            are as fresh as this and no fresher. */}
        <span class="alert-card-cadence">every {formatAge(props.spec.everyS)}</span>
        <span class="alert-card-level">{level()}</span>
      </header>
      <div class="alert-metrics">
        <For each={metrics()}>
          {(metric) => (
            <div class="alert-metric" classList={{ 'alert-metric-hot': metric.hot }}>
              <div class="alert-metric-label">{metric.label}</div>
              <div class="alert-metric-value">
                {metric.value}
                <Show when={metric.unit}>
                  <span class="alert-metric-unit">{metric.unit}</span>
                </Show>
              </div>
              {/* Drawn even when empty, so the numbers of a row sit on one line. */}
              <div class="alert-metric-detail" title={metric.detail ?? ''}>
                {metric.detail ?? ''}
              </div>
            </div>
          )}
        </For>
      </div>
    </section>
  )
}

/**
 * Every alert the service evaluates, one card each: the level it is at and the
 * numbers its check reads. A threshold check shows the reading now, the mean over
 * each of its windows with the threshold that window is measured against, the
 * window it clears on, and how far its lookback went; a silence check shows how
 * long the source has been quiet, when it was last heard from, and how much would
 * have to arrive to clear it.
 *
 * The windows are the checks' own, not the range picker's, so the cards read the
 * same data every time, whatever span the table below is showing — and each card
 * names its check's cadence, because the numbers are only as fresh as that.
 */
export default function AlertCards() {
  const [checks, setChecks] = createSignal<(Check | null)[]>([])
  let requestId = 0

  const load = async () => {
    const request = ++requestId
    const now = new Date()
    const next = await Promise.all(
      ALERTS.map(async (spec) => {
        try {
          return await fetchData<Check>(alertCheckSql(spec, now))
        } catch (error) {
          console.warn(`alert check "${spec.id}" query failed`, error)
          return null
        }
      }),
    )
    if (request === requestId) setChecks(next)
  }

  // Neither signal is read by the queries — the windows are the checks' own — but
  // a window the reader just changed is still a moment to read again, and the
  // cards are about now.
  createEffect(() => {
    range()
    void load()
  })

  onMount(() => {
    onCleanup(autoRefresh(load))
    onCleanup(() => {
      requestId++ // drop replies that are still in flight
    })
  })

  return (
    <div class="alert-cards">
      <For each={ALERTS}>
        {(spec, index) => <Card spec={spec} check={checks()[index()] ?? null} />}
      </For>
    </div>
  )
}
