import { createSignal, onCleanup, onMount, Show } from 'solid-js'

import MapTile from '../components/MapTile'
import TimeSeriesTile from '../components/TimeSeriesTile'
import TrackRug from '../components/TrackRug'
import { locationAltitudeSql, locationBatterySql } from '../lib/query'
import { PERCENT } from '../lib/scale'

type View = 'map' | 'profile'

/** The views in tab order, which is also the order `⌘H` and `⌘L` walk. */
const VIEWS: View[] = ['map', 'profile']

/**
 * Where the phone has been, and what the track looked like along the way.
 *
 * Two views rather than one wall of tiles: the map wants the whole viewport and
 * a chart wants a real height, so they take turns instead of sharing a column.
 * The strip at the bottom belongs to neither view — it is the window's fixes on
 * a bare time axis, and the quickest way to narrow the range to the stretch that
 * matters.
 */
export default function Location() {
  const [view, setView] = createSignal<View>('map')

  // `⌘H` and `⌘L` step between the views, left and right. Both are keys a desktop
  // browser keeps for itself — hide the window, focus the address bar — so the
  // handler asks for the key and takes it when it is given; where it is not, the
  // tabs themselves remain the way. A lone `h` or `l` is history, and belongs to
  // `lib/history.ts`.
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const letter = event.key.toLowerCase()
      if (letter !== 'h' && letter !== 'l') return
      event.preventDefault()
      const step = letter === 'h' ? -1 : 1
      const next = (VIEWS.indexOf(view()) + step + VIEWS.length) % VIEWS.length
      setView(VIEWS[next])
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    <div class="dashboard map">
      <div class="views">
        <button classList={{ active: view() === 'map' }} onClick={() => setView('map')}>
          Map
        </button>
        <button classList={{ active: view() === 'profile' }} onClick={() => setView('profile')}>
          Profile
        </button>
      </div>
      {/* The map stays mounted behind the profile rather than being torn down and
          rebuilt on every switch: MapLibre keeps its context, its tiles and the
          view it was panned to, and its own ResizeObserver picks the size back up
          when the slot comes out of `display: none`. */}
      <div class="map-slot" classList={{ hidden: view() !== 'map' }}>
        <MapTile />
      </div>
      <Show when={view() === 'profile'}>
        <div class="profile">
          <TimeSeriesTile
            wide
            title="Altitude"
            series={[{ label: 'Altitude', expr: '' }]}
            query={locationAltitudeSql}
            yLabel="Altitude [m]"
            yFit={{ pad: 0.2, span: 20 }}
            height={240}
          />
          <TimeSeriesTile
            wide
            step
            title="Battery charge"
            series={[{ label: 'Charge', expr: '' }]}
            query={locationBatterySql}
            yLabel="Charge [%]"
            yFit={PERCENT}
            height={240}
          />
        </div>
      </Show>
      <Show when={view() === 'map'}>
        <TrackRug />
      </Show>
    </div>
  )
}
