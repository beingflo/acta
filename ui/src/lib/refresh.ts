/** Auto-refresh policy.
 *
 *  Only a live window is polled: a selection that ends at the wall clock and
 *  spans at most six hours (the 1h and 6h presets, or a custom range ending
 *  now). Any other selection is a historical snapshot, fetched when it is chosen
 *  and then left alone — polling it would only repeat the same query. The `r`
 *  shortcut reloads the current view either way.
 *
 *  Nothing is polled while the tab is hidden, and coming back reloads at once —
 *  for any window up to a month, live or not, since re-reading one is cheap and
 *  the rows may well have changed since. A year or `all` waits for `r`.
 */

import { createEffect, createSignal, on } from 'solid-js'

import { range } from './range'

/** The longest window still treated as live. Six hours covers the 1h and 6h
 *  presets and a hand-picked window around them; 1d and wider are explicit
 *  snapshots, where polling would re-run the same expensive query every 10 s. */
const LIVE_SPAN_MS = 6 * 3_600_000
/** How far the window's end may sit from the wall clock and still count as
 *  "now": a custom range picked in the datetime inputs has minute precision. */
const END_TOLERANCE_MS = 60_000
const REFRESH_MS = 10_000
const JITTER_MS = 2_000
/** The widest window a returning tab reloads on its own. Re-running a month of
 *  aggregation is worth it to avoid stale charts; a year of it, or `all`, is
 *  left to an explicit `r`. */
const CATCH_UP_SPAN_MS = 30 * 86_400_000

/** Bumped by the `r` shortcut; every autoRefresh subscriber reloads. */
const [refreshTick, setRefreshTick] = createSignal(0)

/** Read-only view for listeners that want to acknowledge a manual refresh
 *  (the live mark flashes). */
export { refreshTick }

export function requestRefresh() {
  setRefreshTick((n) => n + 1)
}

/** True when the current selection should follow the wall clock. */
export function isLiveWindow(now = new Date()): boolean {
  const { from, to } = range(now)
  return (
    Math.abs(now.getTime() - to.getTime()) <= END_TOLERANCE_MS &&
    to.getTime() - from.getTime() <= LIVE_SPAN_MS
  )
}

/** How long the selected window is, in milliseconds. */
function selectedSpanMs(): number {
  const { from, to } = range()
  return to.getTime() - from.getTime()
}

/** Load without letting a rejected query break the refresh loop. */
function quiet(load: () => Promise<void> | void) {
  return Promise.resolve()
    .then(load)
    .catch((error) => console.error('refresh failed', error))
}

/**
 * Keep `load` current: every ten seconds while the selection is a live window
 * and the tab is on screen, immediately when the tab becomes visible again,
 * and on the `r` shortcut whatever the selection is. Returns the cleanup.
 */
export function autoRefresh(load: () => Promise<void> | void): () => void {
  let timer = 0

  function schedule() {
    // A hidden tab does not poll. The browser would throttle the timer to
    // roughly once a minute anyway, and the visibility handler reloads on
    // return, so a background timer buys nothing and costs the query pool.
    if (document.visibilityState === 'hidden') return
    window.clearTimeout(timer)
    timer = window.setTimeout(tick, REFRESH_MS + Math.random() * JITTER_MS)
  }

  async function tick() {
    try {
      if (isLiveWindow()) await load()
    } catch (error) {
      console.error('auto-refresh failed', error)
    } finally {
      // `schedule` re-checks visibility: a tick that lands while the tab is
      // being hidden does not start another one.
      schedule()
    }
  }

  // `r` reloads the data without touching the range.
  createEffect(on(refreshTick, () => void quiet(load), { defer: true }))

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      // Stop the loop here rather than letting it fire once more and decide it
      // has nothing to do.
      window.clearTimeout(timer)
      return
    }
    // Back on screen: catch up at once instead of waiting out a timer, for any
    // window short enough that re-reading it is cheaper than stale charts.
    if (selectedSpanMs() <= CATCH_UP_SPAN_MS) void quiet(load)
    schedule()
  }
  document.addEventListener('visibilitychange', onVisibility)

  schedule()
  return () => {
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

/** Install the `r` shortcut. Returns an uninstall function. */
export function installRefreshShortcut(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return

    const target = event.target as HTMLElement | null
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return
    }

    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault()
      requestRefresh()
    }
  }

  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
