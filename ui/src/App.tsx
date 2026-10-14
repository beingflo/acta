import { createSignal, onMount } from 'solid-js'
import { Dynamic } from 'solid-js/web'

import DashboardPicker from './components/DashboardPicker'
import RangePicker from './components/RangePicker'
import { DASHBOARDS } from './dashboards'
import { fetchData } from './lib/api'
import { setLatestData } from './lib/range'
import './App.css'

export default function App() {
  const [active, setActive] = createSignal(DASHBOARDS[0].id)
  const current = () => DASHBOARDS.find((dashboard) => dashboard.id === active()) ?? DASHBOARDS[0]

  onMount(async () => {
    try {
      const epoch = await fetchData<number>(
        'SELECT to_json(epoch(CAST(max(timestamp) AS TIMESTAMP)))::VARCHAR FROM events',
      )
      if (typeof epoch === 'number' && Number.isFinite(epoch)) {
        setLatestData(new Date(epoch * 1000))
      }
    } catch (error) {
      console.warn('could not determine the latest data timestamp', error)
    }
  })

  return (
    <div class="app">
      <header class="app-header">
        <h1>Acta</h1>
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
