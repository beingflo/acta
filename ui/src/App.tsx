import { createEffect, createSignal, on, onCleanup, onMount } from 'solid-js'
import { Dynamic } from 'solid-js/web'

import DashboardPicker from './components/DashboardPicker'
import RangePicker from './components/RangePicker'
import { DASHBOARDS } from './dashboards'
import { fetchData } from './lib/api'
import { fullscreenTile, installFullscreenShortcuts } from './lib/fullscreen'
import { customRange, preset, setDataBounds } from './lib/range'
import { applyRangeFromUrl, dashboardPath, rangeQuery, readDashboard, writeUrl } from './lib/url'
import './App.css'

export default function App() {
  const [active, setActive] = createSignal(knownDashboard(readDashboard()))
  const current = () => DASHBOARDS.find((dashboard) => dashboard.id === active()) ?? DASHBOARDS[0]

  const syncFromUrl = () => {
    setActive(knownDashboard(readDashboard()))
    applyRangeFromUrl()
  }

  onMount(() => {
    window.addEventListener('popstate', syncFromUrl)
    onCleanup(() => window.removeEventListener('popstate', syncFromUrl))

    const uninstallFullscreen = installFullscreenShortcuts()
    onCleanup(uninstallFullscreen)

    void fetchData<{ mn: number; mx: number }>(
      'SELECT to_json(struct_pack(mn := epoch(CAST(min(timestamp) AS TIMESTAMP)), mx := epoch(CAST(max(timestamp) AS TIMESTAMP))))::VARCHAR FROM events',
    )
      .then((bounds) => {
        if (bounds && Number.isFinite(bounds.mn) && Number.isFinite(bounds.mx)) {
          setDataBounds(new Date(bounds.mn * 1000), new Date(bounds.mx * 1000))
        }
      })
      .catch((error) => console.warn('could not determine the data time bounds', error))
  })

  // Dashboard -> path, keeping the current range.
  createEffect(
    on(
      active,
      (id) => writeUrl(dashboardPath(id) + rangeQuery(preset(), customRange()), false),
      { defer: true },
    ),
  )

  // Range -> query string.
  createEffect(
    on(
      [preset, customRange],
      ([nextPreset, nextCustom]) =>
        writeUrl(window.location.pathname + rangeQuery(nextPreset, nextCustom), true),
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
        <RangePicker />
      </header>
      <main>
        <Dynamic component={current().component} />
      </main>
    </div>
  )
}

function knownDashboard(id: string): string {
  return DASHBOARDS.some((dashboard) => dashboard.id === id) ? id : DASHBOARDS[0].id
}
