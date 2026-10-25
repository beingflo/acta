/** URL <-> state mapping.
 *
 *   /marending                  dashboard path (`/` is Home)
 *   ?range=30d                  shorthand range preset
 *   ?from=2026-10-10T…&to=…     custom range (ISO, UTC)
 */

import { type Preset, type Range, endsNow, setCustomRange, setPreset } from './range'

const SHORTHANDS: Preset[] = ['all', '1y', '30d', '7d', '1d', '6h', '30m']

export function dashboardPath(id: string): string {
  return `/${id}`
}

/** Land on `/home` rather than a bare `/`, which would otherwise produce
 *  ugly URLs like `/?range=1d`. */
export function canonicalizePath(): void {
  const { pathname, search } = window.location
  if (pathname === '/' || pathname === '') {
    window.history.replaceState(null, '', `/home${search}`)
  }
}

/** Dashboard ids that have been renamed, so an older bookmark still lands on
 *  the dashboard rather than falling back to Home. */
const RENAMED: Record<string, string> = { website: 'marending' }

export function readDashboard(): string {
  const id = window.location.pathname.split('/').filter(Boolean)[0] ?? 'home'
  return RENAMED[id] ?? id
}

export function readRange(): { preset: Preset; custom: Range | null } {
  const params = new URLSearchParams(window.location.search)

  const from = params.get('from')
  const to = params.get('to')
  if (from) {
    const start = new Date(from)
    if (!Number.isNaN(start.getTime())) {
      // No `to` means the end follows the clock: that is how a live custom
      // range is written, so reopening the URL keeps ending at the new now.
      if (!to) {
        if (start.getTime() < Date.now()) {
          return { preset: 'custom', custom: { from: start, to: new Date(), liveEnd: true } }
        }
      } else {
        const end = new Date(to)
        if (!Number.isNaN(end.getTime()) && end > start) {
          // A URL written moments ago still ends "now"; an older one is a
          // historical window and stays fixed.
          return { preset: 'custom', custom: { from: start, to: end, liveEnd: endsNow(end) } }
        }
      }
    }
  }

  const range = params.get('range') as Preset | null
  if (range && SHORTHANDS.includes(range)) return { preset: range, custom: null }

  return { preset: '1d', custom: null }
}

/** Load the range from the current URL into the shared range state. */
export function applyRangeFromUrl(): void {
  const { preset, custom } = readRange()
  if (preset === 'custom' && custom) setCustomRange(custom)
  else setPreset(preset)
}

export function rangeQuery(preset: Preset, custom: Range | null): string {
  if (preset === 'custom' && custom) {
    const params = new URLSearchParams({ from: custom.from.toISOString() })
    // The end of a live range is deliberately absent: it is resolved from the
    // wall clock when the URL is read, so a reopened tab keeps following now.
    // A fixed end is written out, since nothing else can recover it.
    if (!custom.liveEnd) params.set('to', custom.to.toISOString())
    return `?${params}`
  }
  return `?range=${preset}`
}

/** Write `url` unless it already points at the same place as the address bar,
 *  so reacting to `popstate` does not push a duplicate history entry. Compared
 *  by path and query parameters rather than by string: the same URL can be
 *  spelled with different but equivalent percent-encoding, and Back to a
 *  hand-typed URL must not push a duplicate encoded copy (which would truncate
 *  forward history). */
export function writeUrl(url: string, replace: boolean): void {
  if (sameLocation(url)) return
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
}

function sameLocation(url: string): boolean {
  return canonical(new URL(url, window.location.origin)) === canonical(new URL(window.location.href))
}

function canonical(url: URL): string {
  const params = [...url.searchParams].sort(([a], [b]) => a.localeCompare(b))
  return `${url.pathname}?${new URLSearchParams(params).toString()}`
}
