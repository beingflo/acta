import { batch, createEffect, createSignal, on, onCleanup, onMount } from 'solid-js'
import { Dynamic } from 'solid-js/web'

import DashboardPicker from './components/DashboardPicker'
import LiveIndicator from './components/LiveIndicator'
import RangePicker from './components/RangePicker'
import SignIn from './components/SignIn'
import { DASHBOARDS } from './dashboards'
import { fetchData } from './lib/api'
import { fullscreenTile, installFullscreenShortcuts } from './lib/fullscreen'
import { customRange, installRangeShortcuts, preset, setDataBounds } from './lib/range'
import { installRefreshShortcut, refreshTick } from './lib/refresh'
import { applyRangeFromUrl, dashboardPath, rangeQuery, readDashboard, writeUrl } from './lib/url'
import './App.css'

export default function App() {
  const [active, setActive] = createSignal(knownDashboard(readDashboard()))
  const current = () => DASHBOARDS.find((dashboard) => dashboard.id === active()) ?? DASHBOARDS[0]

  const syncFromUrl = () =>
    batch(() => {
      setActive(knownDashboard(readDashboard()))
      applyRangeFromUrl()
    })

  /** The data extents, which only the `all` range reads. */
  const refreshBounds = () =>
    void fetchData<{ mn: number; mx: number }>(
      'SELECT to_json(struct_pack(mn := epoch(CAST(min(timestamp) AS TIMESTAMP)), mx := epoch(CAST(max(timestamp) AS TIMESTAMP))))::VARCHAR FROM events',
    )
      .then((bounds) => {
        if (bounds && Number.isFinite(bounds.mn) && Number.isFinite(bounds.mx)) {
          setDataBounds(new Date(bounds.mn * 1000), new Date(bounds.mx * 1000))
        }
      })
      .catch((error) => console.warn('could not determine the data time bounds', error))

  onMount(() => {
    window.addEventListener('popstate', syncFromUrl)
    onCleanup(() => window.removeEventListener('popstate', syncFromUrl))

    const uninstallFullscreen = installFullscreenShortcuts()
    onCleanup(uninstallFullscreen)

    const uninstallRange = installRangeShortcuts()
    onCleanup(uninstallRange)

    const uninstallRefresh = installRefreshShortcut()
    onCleanup(uninstallRefresh)

    refreshBounds()
    // Only `all` depends on the extents; a hidden tab can miss data, so pick
    // them up again on return rather than on a timer.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && preset() === 'all') refreshBounds()
    }
    document.addEventListener('visibilitychange', onVisible)
    onCleanup(() => document.removeEventListener('visibilitychange', onVisible))
  })

  // `all` spans everything, so its extents are re-read when it is chosen.
  createEffect(
    on(
      preset,
      (current) => {
        if (current === 'all') refreshBounds()
      },
      { defer: true },
    ),
  )

  // A manual refresh on `all` should include rows ingested since the extents
  // were last read.
  createEffect(
    on(
      refreshTick,
      () => {
        if (preset() === 'all') refreshBounds()
      },
      { defer: true },
    ),
  )

  // Dashboard -> path, keeping the current range.
  createEffect(
    on(
      active,
      (id) => writeUrl(dashboardPath(id) + rangeQuery(preset(), customRange()), false),
      { defer: true },
    ),
  )

  // Range -> query string. A range change is a history entry of its own, so
  // Back steps through the windows visited before leaving the dashboard.
  // Back/forward land here too, but their URL already matches and `writeUrl`
  // then leaves the stack alone.
  createEffect(
    on(
      [preset, customRange],
      ([nextPreset, nextCustom]) =>
        writeUrl(window.location.pathname + rangeQuery(nextPreset, nextCustom), false),
      { defer: true },
    ),
  )

  // Prevent the page behind a maximized tile from scrolling.
  createEffect(() => {
    document.body.classList.toggle('fullscreen-tile', fullscreenTile() !== null)
  })

  return (
    <div class="app">
      <header class="app-header">
        <DashboardPicker active={active()} onSelect={setActive} />
        <div class="spacer" />
        <LiveIndicator />
        <RangePicker />
      </header>
      <main>
        <Dynamic component={current().component} />
      </main>
      <SignIn />
    </div>
  )
}

function knownDashboard(id: string): string {
  return DASHBOARDS.some((dashboard) => dashboard.id === id) ? id : DASHBOARDS[0].id
}
