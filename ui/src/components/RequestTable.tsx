import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'

import { fetchData } from '../lib/api'
import { formatNumber } from '../lib/format'
import { requestCountSql, requestPageSql, type RequestRow } from '../lib/query'
import { range } from '../lib/range'

/** Rows per query. Pages are cached, so scrolling back costs nothing. */
const PAGE_ROWS = 200
/** Rows rendered above and below the viewport, to cover the fetch latency. */
const OVERSCAN = 8
/** Row height in CSS pixels, and the virtualizer's unit of measure. */
const ROW_HEIGHT = 24
/** How many rows we are willing to skip with `OFFSET` inside an anchor before
 *  bisecting for a closer one instead. */
const MAX_SKIP = 1_200
const REFRESH_MS = 30_000
const JITTER_MS = 5_000

/** A row index whose timestamp is known, so pages near it need no offset. */
type Anchor = { index: number; cursorUs: number | null }

/**
 * Access-log table. Rows are addressed by timestamp, not by an offset: a page
 * is fetched as "the 200 rows at or below this instant", so page 4000 costs the
 * same as page 1. A `count(*)` sizes a spacer for the scrollbar, and a short
 * bisection over that same count finds an anchor when the window is jumped
 * somewhere far from anything loaded so far.
 */
export default function RequestTable(props: { source: string; title: string }) {
  const [total, setTotal] = createSignal<number | null>(null)
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewport, setViewport] = createSignal(0)
  const [version, setVersion] = createSignal(0)
  const [busy, setBusy] = createSignal(false)

  // Plain state plus a version signal: the caches are written from async
  // callbacks and read while rendering, and making them reactive would make the
  // fill effect retrigger itself.
  let cache = new Map<number, RequestRow[]>()
  let anchors: Anchor[] = [{ index: 0, cursorUs: null }]
  let loading = new Set<number>()
  let token = 0
  let scroller!: HTMLDivElement

  const renderedRows = () => Math.ceil(viewport() / ROW_HEIGHT) + OVERSCAN * 2
  const firstIndex = createMemo(() => Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN))

  const windowRows = createMemo(() => {
    version() // re-read when a page lands
    const end = Math.min(total() ?? 0, firstIndex() + renderedRows())
    const rows: { row: RequestRow; index: number }[] = []
    for (let index = firstIndex(); index < end; index++) {
      const row = cache.get(Math.floor(index / PAGE_ROWS))?.[index % PAGE_ROWS]
      if (row) rows.push({ row, index })
    }
    return rows
  })

  /** Pages the current window touches: the fetch unit and the render window. */
  const windowPages = (): number[] => {
    const count = total()
    if (count === null) return []
    const from = firstIndex()
    const to = Math.min(count, from + renderedRows()) - 1
    if (to < from) return []
    const pages: number[] = []
    for (let page = Math.floor(from / PAGE_ROWS); page <= Math.floor(to / PAGE_ROWS); page++) {
      pages.push(page)
    }
    return pages
  }

  const nearestAnchor = (index: number): Anchor => {
    let best: Anchor = anchors[0]
    for (const anchor of anchors) {
      if (anchor.index <= index && anchor.index > best.index) best = anchor
    }
    return best
  }

  const remember = (anchor: Anchor) => {
    if (anchors.some((known) => known.index === anchor.index)) return
    anchors.push(anchor)
    anchors.sort((a, b) => a.index - b.index)
  }

  /**
   * Find an anchor close to `target` by bisecting on `count(timestamp <= t)`.
   * Each step is one cheap count query; it stops as soon as the remaining gap
   * can be bridged with a bounded offset, which for request logs is a couple of
   * steps rather than the ~40 a fixed-precision search would need.
   */
  const bisect = async (target: number, current: number): Promise<Anchor> => {
    const { from, to } = range()
    let lo = from.getTime()
    let hi = to.getTime()
    let best: Anchor = nearestAnchor(target)
    for (let step = 0; step < 40 && hi - lo > 1_000; step++) {
      const mid = Math.floor((lo + hi) / 2)
      const cursorUs = mid * 1000
      const counts = await fetchData<{ n: number }>(
        requestCountSql(props.source, from, to, cursorUs),
      )
      if (current !== token) return best
      const n = counts?.n ?? 0
      if (n === 0) {
        lo = mid
        continue
      }
      const index = n - 1
      if (Math.abs(target - index) <= MAX_SKIP) return { index, cursorUs }
      best = { index, cursorUs }
      if (index < target) lo = mid
      else hi = mid
    }
    return best
  }

  const loadPage = async (page: number, current: number) => {
    if (cache.has(page) || loading.has(page)) return
    loading.add(page)
    try {
      const start = page * PAGE_ROWS
      let anchor = nearestAnchor(start)
      if (start - anchor.index > MAX_SKIP) anchor = await bisect(start, current)
      const { from, to } = range()
      const rows = await fetchData<RequestRow[]>(
        requestPageSql({
          source: props.source,
          from,
          to,
          limit: PAGE_ROWS,
          offset: start - anchor.index,
          cursorUs: anchor.cursorUs ?? undefined,
        }),
      )
      if (current !== token) return
      const pageRows = rows ?? []
      cache.set(page, pageRows)
      if (pageRows.length > 0) remember({ index: start, cursorUs: pageRows[0].us })
      setVersion((n) => n + 1)
    } catch (error) {
      if (current === token) console.error('request table query failed', error)
    } finally {
      loading.delete(page)
    }
  }

  /** Fetch the pages the window needs and does not have yet, in order, so each
   *  page can anchor off the previous one. */
  const fillWindow = async (current: number) => {
    const missing = windowPages().filter((page) => !cache.has(page))
    if (missing.length === 0) return
    setBusy(true)
    try {
      for (const page of missing) await loadPage(page, current)
    } finally {
      if (current === token) setBusy(false)
    }
  }

  /** Re-read the window after a range change or a refresh: the row count first,
   *  because it sizes the scrollbar, then whatever the window needs. */
  const reload = async () => {
    const current = ++token
    cache = new Map()
    anchors = [{ index: 0, cursorUs: null }]
    loading = new Set()
    setTotal(null)
    setVersion((n) => n + 1)
    setBusy(true)
    try {
      const { from, to } = range()
      const counts = await fetchData<{ n: number }>(requestCountSql(props.source, from, to))
      if (current !== token) return
      setTotal(counts?.n ?? 0)
      await fillWindow(current)
    } catch (error) {
      if (current === token) console.error('request table count failed', error)
    } finally {
      if (current === token) setBusy(false)
    }
  }

  /** Periodic refresh: keep the total and the scroll position, re-count, and
   *  replace only the pages on screen. Rows are addressed by timestamp, so the
   *  row under the cursor stays the row under the cursor. */
  const refresh = async () => {
    if (total() === null) return
    const current = token
    try {
      const { from, to } = range()
      const counts = await fetchData<{ n: number }>(requestCountSql(props.source, from, to))
      if (current !== token) return
      setTotal(counts?.n ?? 0)
      for (const page of windowPages()) cache.delete(page)
      await fillWindow(current)
    } catch (error) {
      if (current === token) console.error('request table refresh failed', error)
    }
  }

  createEffect(() => {
    range() // re-run when the selected window changes
    void reload()
  })

  createEffect(
    on([firstIndex, total], () => {
      void fillWindow(token)
    }),
  )

  onMount(() => {
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0].contentRect.height)
      if (next > 0) setViewport(next)
    })
    observer.observe(scroller)

    // Refresh on the charts' cadence.
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await refresh()
        schedule()
      }, REFRESH_MS + Math.random() * JITTER_MS)
    }
    schedule()

    onCleanup(() => {
      observer.disconnect()
      clearTimeout(timer)
      token++ // drop replies that are still in flight
    })
  })

  return (
    <section class="tile table">
      <header class="tile-title">
        {props.title}
        <Show when={total() !== null}>
          <span class="tile-count"> · {formatNumber(total()!)}</span>
        </Show>
        <Show when={busy()}>
          <span class="tile-count"> · loading</span>
        </Show>
      </header>
      <div class="table">
        <div class="table-head">
          <span>Time</span>
          <span>Method</span>
          <span>URI</span>
          <span>Status</span>
          <span>Latency</span>
          <span>Referrer</span>
          <span>User agent</span>
          <span>Error</span>
        </div>
        <div
          class="table-scroll"
          ref={scroller}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div class="table-spacer" style={{ height: `${(total() ?? 0) * ROW_HEIGHT}px` }}>
            <div
              class="table-window"
              style={{ transform: `translateY(${firstIndex() * ROW_HEIGHT}px)` }}
            >
              <For each={windowRows()}>
                {(entry) => (
                  <div class="table-row" style={{ height: `${ROW_HEIGHT}px` }}>
                    <span class="table-time">{formatTime(entry.row.us)}</span>
                    <span class="table-method">{entry.row.method ?? '—'}</span>
                    <span title={entry.row.uri ?? ''}>{entry.row.uri ?? '—'}</span>
                    <span classList={{ status: true, failed: (entry.row.status ?? 0) >= 400 }}>
                      {entry.row.status ?? '—'}
                    </span>
                    <span>{formatLatency(entry.row.latency)}</span>
                    <span class="muted" title={entry.row.referrer ?? ''}>
                      {emptyAsDash(entry.row.referrer)}
                    </span>
                    <span class="muted" title={entry.row.agent ?? ''}>
                      {emptyAsDash(entry.row.agent)}
                    </span>
                    <span class="failed" title={entry.row.error ?? ''}>
                      {entry.row.error ? shortError(entry.row.error) : ''}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** `MM-DD HH:MM:SS` in local time, from microseconds since the epoch. */
function formatTime(us: number): string {
  const date = new Date(Math.floor(us / 1000))
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`
}

function formatLatency(ms: number | null): string {
  if (ms === null) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`
  return ms >= 100 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(1)} ms`
}

function emptyAsDash(value: string | null): string {
  return value === null || value === '' ? '—' : value
}

/** The payload's `errors` field is DuckDB's text form of a Variant array; the
 *  message inside it is the part worth reading. */
function shortError(raw: string): string {
  const match = raw.match(/'error':\s*'([^']*)'/)
  return match ? match[1] : raw
}
