import { createMemo, For, Show } from 'solid-js'

import { formatNumber } from '../lib/format'
import { latestReadings } from '../lib/latest'

/**
 * Newest value of every chart on the dashboard, in one row above the charts.
 * The values are published by the tiles themselves, so this shows exactly what
 * the right-hand end of each chart shows.
 */
export default function LatestStrip() {
  const readings = createMemo(() => latestReadings())

  return (
    <Show when={readings().length > 0}>
      <div class="latest-strip">
        <For each={readings()}>
          {(reading) => (
            <div class="latest-card">
              <div class="latest-card-title">{reading.title}</div>
              <div class="latest-card-value">
                {reading.value === null ? '—' : formatNumber(reading.value)}
                <span class="latest-card-unit">{reading.unit}</span>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
