import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'

import { fetchData } from '../lib/api'
import { exitFullscreen, fullscreenTile, setHoveredTile } from '../lib/fullscreen'
import { formatNumber } from '../lib/format'
import { range } from '../lib/range'
import { autoRefresh } from '../lib/refresh'

/** Rows per query. Pages are cached, so scrolling back costs nothing. */
const PAGE_ROWS = 500
/** Rows rendered above and below the viewport, so the next screenful is already
 *  in the DOM when the scroller moves. */
const OVERSCAN_ROWS = 40
/** Default row height in CSS pixels, and the virtualizer's unit of measure. */
const DEFAULT_ROW_HEIGHT = 24
/** How many rows we are willing to skip with `OFFSET` inside an anchor before
 *  bisecting for a closer one instead. */
const MAX_SKIP = 1_200

/** A row that can serve as a page cursor. */
export type CursoredRow = { us: number }

/** One page request, as the query builder receives it. */
export type PageQuery = {
  from: Date
  to: Date
  limit: number
  offset: number
  cursorUs?: number
}

/** A row index whose timestamp is known, so pages near it need no offset. */
type Anchor = { index: number; cursorUs: number | null }

/**
 * One rendered row. The object is the `<For>` key, so it has to keep its
 * identity while the row stays in the window: a fresh object per scroll frame
 * would move the whole window again on every frame. The row itself is a signal
 * because a page can be replaced underneath an entry (see `storePage`).
 */
type WindowRow<T> = {
  index: number
  row: Accessor<T>
  set: (value: T) => void
}

/**
 * A virtualized table paged by timestamp, shared by every dashboard that lists
 * individual events.
 *
 * Rows are addressed by time, not by an offset: a page is fetched as "the 500
 * rows at or below this instant", so page 4000 costs the same as page 1. A
 * `count(*)` sizes a spacer for the scrollbar, and a short bisection over that
 * same count finds an anchor when the window is jumped somewhere far from
 * anything loaded so far.
 *
 * The caller supplies the two SQL queries and how a row renders; everything
 * about scrolling, caching and refreshing lives here.
 */
export default function PagedTable<T extends CursoredRow>(props: {
  title: string
  /** Class on `.table`, which selects the column template in App.css. */
  variant: string
  /** Row height in CSS pixels. Must stay constant for the virtualizer. */
  rowHeight?: number
  /** Number of rows in the window, or in `[from, cursor]`, for the spacer and
   *  the bisection that finds an anchor at a given row. */
  countSql: (from: Date, to: Date, cursorUs?: number) => string
  /** One page of rows, newest first, continuing at `cursorUs` when the caller
   *  already knows where the page starts. */
  pageSql: (query: PageQuery) => string
  head: JSX.Element
  /** The row's cells. Called once per row; read the accessor to stay live when
   *  a refresh replaces the page. */
  row: (row: Accessor<T>) => JSX.Element
}) {
  const [total, setTotal] = createSignal<number | null>(null)
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewport, setViewport] = createSignal(0)
  const [version, setVersion] = createSignal(0)
  const [busy, setBusy] = createSignal(false)

  // The tile id for the `v` shortcut; the title is unique per dashboard.
  const id = props.title
  const isFullscreen = createMemo(() => fullscreenTile() === id)

  const rowHeight = () => props.rowHeight ?? DEFAULT_ROW_HEIGHT

  // Plain state plus a version signal: the caches are written from async
  // callbacks and read while rendering, and making them reactive would make the
  // fill effect retrigger itself.
  let cache = new Map<number, T[]>()
  let anchors: Anchor[] = [{ index: 0, cursorUs: null }]
  let entries = new Map<number, WindowRow<T>>()
  let loading = new Set<number>()
  let token = 0
  let scroller!: HTMLDivElement

  const renderedRows = () => Math.ceil(viewport() / rowHeight()) + OVERSCAN_ROWS * 2
  const firstIndex = createMemo(() =>
    Math.max(0, Math.floor(scrollTop() / rowHeight()) - OVERSCAN_ROWS),
  )

  const windowRows = createMemo(() => {
    version() // re-read when a page lands
    const start = firstIndex()
    const end = Math.min(total() ?? 0, start + renderedRows())
    const rows: WindowRow<T>[] = []
    for (let index = start; index < end; index++) {
      const row = cache.get(Math.floor(index / PAGE_ROWS))?.[index % PAGE_ROWS]
      if (!row) continue
      let entry = entries.get(index)
      if (!entry) {
        // `createSignal` cannot take a generic value that might be a function,
        // so the signal is typed `unknown` and the setter narrowed back to `T`.
        const [value, set] = createSignal<unknown>(row)
        entry = { index, row: value as Accessor<T>, set: (next: T) => set(() => next) }
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
   * can be bridged with a bounded offset, which for event data is a couple of
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
      const counts = await fetchData<{ n: number }>(props.countSql(from, to, cursorUs))
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
  const fetchPage = async (page: number, current: number): Promise<T[] | null> => {
    const start = page * PAGE_ROWS
    let anchor = nearestAnchor(start)
    if (start - anchor.index > MAX_SKIP) anchor = await bisect(start, current)
    if (current !== token) return null
    const { from, to } = range()
    const rows = await fetchData<T[]>(
      props.pageSql({
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

  const storePage = (page: number, rows: T[]) => {
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
      if (current === token) console.error('table page query failed', error)
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
      const counts = await fetchData<{ n: number }>(props.countSql(from, to))
      if (current !== token) return
      setTotal(counts?.n ?? 0)
      await fillWindow(current)
    } catch (error) {
      if (current === token) console.error('table count query failed', error)
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
      const counts = await fetchData<{ n: number }>(props.countSql(from, to))
      if (current !== token) return
      setTotal(counts?.n ?? 0)
      const fresh: [number, T[]][] = []
      for (const page of pages) {
        const rows = await fetchPage(page, current)
        if (current !== token) return
        if (rows) fresh.push([page, rows])
      }
      for (const [page, rows] of fresh) storePage(page, rows)
    } catch (error) {
      if (current === token) console.error('table refresh failed', error)
    }
  }

  createEffect(() => {
    range() // re-run when the selected window changes
    void reload()
  })

  createEffect(
    on([firstIndex, total, renderedRows], () => {
      void fillWindow(token)
    }),
  )

  onMount(() => {
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0].contentRect.height)
      if (next > 0) setViewport(next)
    })
    observer.observe(scroller)

    // Refresh on the charts' cadence, and only while the window is live.
    onCleanup(autoRefresh(refresh))

    onCleanup(() => {
      observer.disconnect()
      token++ // drop replies that are still in flight
      if (isFullscreen()) exitFullscreen()
    })
  })

  return (
    <section
      class="tile table"
      classList={{ fullscreen: isFullscreen() }}
      onMouseEnter={() => setHoveredTile(id)}
      onMouseLeave={() => setHoveredTile(null)}
    >
      <header class="tile-title">
        {props.title}
        <Show when={total() !== null}>
          <span class="tile-count"> · {formatNumber(total()!)}</span>
        </Show>
        <Show when={busy()}>
          <span class="tile-count"> · loading</span>
        </Show>
      </header>
      <Show when={isFullscreen()}>
        <button class="tile-close" onClick={exitFullscreen} aria-label="Exit fullscreen">
          ×
        </button>
      </Show>
      <div class={`table ${props.variant}`}>
        <div class="table-head">{props.head}</div>
        <div
          class="table-scroll"
          ref={scroller}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div class="table-spacer" style={{ height: `${(total() ?? 0) * rowHeight()}px` }}>
            <div
              class="table-window"
              style={{ transform: `translateY(${firstIndex() * rowHeight()}px)` }}
            >
              <For each={windowRows()}>
                {(entry) => (
                  <div class="table-row" style={{ height: `${rowHeight()}px` }}>
                    {props.row(entry.row)}
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
