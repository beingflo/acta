/** Auto-refresh policy.
 *
 *  Only a live window is polled: a selection that ends at the wall clock and
 *  spans at most an hour (the 30m preset, or a custom range ending now). Any
 *  other selection is a historical snapshot, fetched when it is chosen and then
 *  left alone — polling it would only repeat the same query. The `r` shortcut
 *  reloads the current view either way.
 */

import { createEffect, createSignal, on } from 'solid-js'

import { range } from './range'

/** The longest window still treated as live. */
const LIVE_SPAN_MS = 3_600_000
/** How far the window's end may sit from the wall clock and still count as
 *  "now": a custom range picked in the datetime inputs has minute precision. */
const END_TOLERANCE_MS = 60_000
const REFRESH_MS = 10_000
const JITTER_MS = 2_000

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

/** Load without letting a rejected query break the refresh loop. */
function quiet(load: () => Promise<void> | void) {
  return Promise.resolve()
    .then(load)
    .catch((error) => console.error('refresh failed', error))
}

/**
 * Keep `load` current: every ten seconds while the selection is a live window,
 * immediately when the tab becomes visible again, and on the `r` shortcut
 * whatever the selection is. Returns the cleanup.
 */
export function autoRefresh(load: () => Promise<void> | void): () => void {
  let timer = 0

  function schedule() {
    timer = window.setTimeout(tick, REFRESH_MS + Math.random() * JITTER_MS)
  }

  async function tick() {
    try {
      if (isLiveWindow()) await load()
    } catch (error) {
      console.error('auto-refresh failed', error)
    } finally {
      schedule()
    }
  }

  // `r` reloads the data without touching the range.
  createEffect(on(refreshTick, () => void quiet(load), { defer: true }))

  // Returning to a backgrounded tab catches up at once instead of waiting for a
  // throttled timer to fire.
  const onVisibility = () => {
    if (document.visibilityState === 'visible' && isLiveWindow()) void quiet(load)
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
