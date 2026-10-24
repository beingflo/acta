import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  type Setter,
  Show,
} from 'solid-js'

import { fetchData } from '../lib/api'
import { formatNumber } from '../lib/format'
import { requestCountSql, requestPageSql, type RequestRow } from '../lib/query'
import { range } from '../lib/range'

/** Rows per query. Pages are cached, so scrolling back costs nothing. */
const PAGE_ROWS = 500
/** Rows rendered above and below the viewport, so the next screenful is already
 *  in the DOM when the scroller moves. */
const OVERSCAN_ROWS = 40
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
 * One rendered row. The object is the `<For>` key, so it has to keep its
 * identity while the row stays in the window: a fresh object per scroll frame
 * would move the whole window again on every frame. The row itself is a signal
 * because a page can be replaced underneath an entry (see `storePage`).
 */
type WindowRow = { index: number; row: Accessor<RequestRow>; set: Setter<RequestRow> }

/**
 * Access-log table. Rows are addressed by timestamp, not by an offset: a page
 * is fetched as "the 500 rows at or below this instant", so page 4000 costs the
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
  let entries = new Map<number, WindowRow>()
  let loading = new Set<number>()
  let token = 0
  let scroller!: HTMLDivElement

  const renderedRows = () => Math.ceil(viewport() / ROW_HEIGHT) + OVERSCAN_ROWS * 2
  const firstIndex = createMemo(() =>
    Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN_ROWS),
  )

  const windowRows = createMemo(() => {
    version() // re-read when a page lands
    const start = firstIndex()
    const end = Math.min(total() ?? 0, start + renderedRows())
    const rows: WindowRow[] = []
    for (let index = start; index < end; index++) {
      const row = cache.get(Math.floor(index / PAGE_ROWS))?.[index % PAGE_ROWS]
      if (!row) continue
      let entry = entries.get(index)
      if (!entry) {
        const [value, set] = createSignal(row)
        entry = { index, row: value, set }
        entries.set(index, entry)
      }
      rows.push(entry)
    }
    // Entries that left the window go with it, so the map tracks the window
    // rather than every row ever scrolled past.
    for (const index of entries.keys()) {
      if (index < start || index >= end) entries.delete(index)
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

  /** Rows for one page, without touching the caches: a refresh stages the
   *  visible window and swaps it in, instead of blanking the table first. */
  const fetchPage = async (page: number, current: number): Promise<RequestRow[] | null> => {
    const start = page * PAGE_ROWS
    let anchor = nearestAnchor(start)
    if (start - anchor.index > MAX_SKIP) anchor = await bisect(start, current)
    if (current !== token) return null
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
    if (current !== token) return null
    return rows ?? []
  }

  const storePage = (page: number, rows: RequestRow[]) => {
    cache.set(page, rows)
    if (rows.length > 0) remember({ index: page * PAGE_ROWS, cursorUs: rows[0].us })
    // Rows already on screen keep their elements (see `WindowRow`), so a
    // replaced page has to push its new rows into the entries it covers.
    const base = page * PAGE_ROWS
    rows.forEach((row, offset) => entries.get(base + offset)?.set(row))
    setVersion((n) => n + 1)
  }

  const loadPage = async (page: number, current: number) => {
    if (cache.has(page) || loading.has(page)) return
    loading.add(page)
    try {
      const rows = await fetchPage(page, current)
      if (rows) storePage(page, rows)
    } catch (error) {
      if (current === token) console.error('request table query failed', error)
    } finally {
      loading.delete(page)
    }
  }

  /** Fetch the pages the window needs and does not have yet, in order, so each
   *  page can anchor off the previous one. */
  const fillWindow = async (current: number) => {
    const pages = windowPages()
    const missing = pages.filter((page) => !cache.has(page))
    if (missing.length > 0) {
      setBusy(true)
      try {
        for (const page of missing) await loadPage(page, current)
      } finally {
        if (current === token) setBusy(false)
      }
    }
    void prefetch(current, pages)
  }

  /** One page beyond each edge of the window, so a scroll in either direction
   *  finds rows already rendered instead of blank space. */
  const prefetch = async (current: number, pages: number[]) => {
    if (pages.length === 0) return
    const last = Math.ceil((total() ?? 0) / PAGE_ROWS) - 1
    for (const page of [pages[0] - 1, pages[pages.length - 1] + 1]) {
      if (current !== token) return
      if (page >= 0 && page <= last) await loadPage(page, current)
    }
  }

  /** Re-read the window after a range change or a refresh: the row count first,
   *  because it sizes the scrollbar, then whatever the window needs. */
  const reload = async () => {
    const current = ++token
    cache = new Map()
    anchors = [{ index: 0, cursorUs: null }]
    entries = new Map()
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
   *  row under the cursor stays the row under the cursor. The replacements are
   *  staged and swapped in together: deleting before fetching would empty the
   *  table for as long as the queries take. */
  const refresh = async () => {
    if (total() === null) return
    const current = token
    const pages = windowPages()
    try {
      const { from, to } = range()
      const counts = await fetchData<{ n: number }>(requestCountSql(props.source, from, to))
      if (current !== token) return
      setTotal(counts?.n ?? 0)
      const fresh: [number, RequestRow[]][] = []
      for (const page of pages) {
        const rows = await fetchPage(page, current)
        if (current !== token) return
        if (rows) fresh.push([page, rows])
      }
      for (const [page, rows] of fresh) storePage(page, rows)
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
          <span class="col-time">Time</span>
          <span class="col-method">Method</span>
          <span class="col-uri">URI</span>
          <span class="col-status">Status</span>
          <span class="col-latency">Latency</span>
          <span class="col-referrer">Referrer</span>
          <span class="col-agent">User agent</span>
          <span class="col-error">Error</span>
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
                {(entry) => {
                  const time = () => timeParts(entry.row().us)
                  return (
                    <div class="table-row" style={{ height: `${ROW_HEIGHT}px` }}>
                      {/* The day is dropped on narrow screens, where it would
                          ellipsize the clock away. */}
                      <span class="table-time col-time">
                        <span class="table-day">{time().day} </span>
                        {time().clock}
                      </span>
                      <span class="table-method col-method">{entry.row().method ?? '—'}</span>
                      <span class="col-uri" title={entry.row().uri ?? ''}>
                        {entry.row().uri ?? '—'}
                      </span>
                      <span
                        class="col-status"
                        classList={{
                          status: true,
                          failed: (entry.row().status ?? 0) >= 400,
                        }}
                      >
                        {entry.row().status ?? '—'}
                      </span>
                      <span class="col-latency">{formatLatency(entry.row().latency)}</span>
                      <span class="muted col-referrer" title={entry.row().referrer ?? ''}>
                        {emptyAsDash(entry.row().referrer)}
                      </span>
                      <span class="muted col-agent" title={entry.row().agent ?? ''}>
                        {emptyAsDash(entry.row().agent)}
                      </span>
                      <span class="failed col-error" title={entry.row().error ?? ''}>
                        {shortError(entry.row().error ?? '')}
                      </span>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** `DD-MM` and `HH:MM:SS` in local time, from microseconds since the epoch,
 *  day first like the chart axes. */
function timeParts(us: number): { day: string; clock: string } {
  const date = new Date(Math.floor(us / 1000))
  const pad = (part: number) => String(part).padStart(2, '0')
  return {
    day: `${pad(date.getDate())}-${pad(date.getMonth() + 1)}`,
    clock: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  }
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
