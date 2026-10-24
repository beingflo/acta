/** URL <-> state mapping.
 *
 *   /location                   dashboard path (`/` is Home)
 *   ?range=30d                  shorthand range preset
 *   ?from=2026-10-10T…&to=…     custom range (ISO, UTC)
 */

import { type Preset, type Range, setCustomRange, setPreset } from './range'

const SHORTHANDS: Preset[] = ['all', '2y', '1y', '6m', '30d', '7d', '1d', '6h']

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

export function readDashboard(): string {
  return window.location.pathname.split('/').filter(Boolean)[0] ?? 'home'
}

export function readRange(): { preset: Preset; custom: Range | null } {
  const params = new URLSearchParams(window.location.search)

  const from = params.get('from')
  const to = params.get('to')
  if (from && to) {
    const start = new Date(from)
    const end = new Date(to)
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start) {
      return { preset: 'custom', custom: { from: start, to: end } }
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
    const params = new URLSearchParams({
      from: custom.from.toISOString(),
      to: custom.to.toISOString(),
    })
    return `?${params}`
  }
  return `?range=${preset}`
}

/** Write `url` unless it already matches the address bar, so reacting to
 *  `popstate` does not push a duplicate history entry. */
export function writeUrl(url: string, replace: boolean): void {
  if (url === window.location.pathname + window.location.search) return
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
}
