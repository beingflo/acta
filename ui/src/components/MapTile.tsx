import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import type { FeatureCollection } from 'geojson'
import { Map as MapLibreMap, addProtocol, type GeoJSONSource, LngLatBounds, type StyleSpecification } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { layers, namedFlavor } from '@protomaps/basemaps'
import 'maplibre-gl/dist/maplibre-gl.css'

import { fetchData } from '../lib/api'
import { formatTimestamp } from '../lib/format'
import { TRACK } from '../lib/palette'
import { locationPointsSql } from '../lib/query'
import { range } from '../lib/range'

// PMTiles archives served by the service (see `service/src/api.rs`), coarsest
// first. Each archive's zoom range comes from its own header (the PMTiles
// protocol exposes it as TileJSON), so nothing is hardcoded here: the world set
// overzooms past z6 where no finer tile exists, `all` covers z7-12 everywhere
// the fixes are, and `tier1` adds street detail (z13-15) where they are
// frequent. Both extracts are derived from the fixes by `tools/map_regions.py`.
const BASEMAPS = [
  { id: 'world', url: '/tiles/world.pmtiles' },
  { id: 'all', url: '/tiles/all.pmtiles' },
  { id: 'tier1', url: '/tiles/tier1.pmtiles' },
]

const THEME = 'light'
const CENTER: [number, number] = [8.543415, 47.367249]

// Protomaps glyphs and sprites, matching the basemap style.
const GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf'
const SPRITE = `https://protomaps.github.io/basemaps-assets/sprites/v3/${THEME}`
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

type Fix = { t: number; lon: number; lat: number }
type LocationMode = 'points' | 'line'

/** How near the pointer has to be to the track, in pixels, for it to answer. */
const HOVER_RADIUS = 12
/** Room saved under the map for MapLibre's attribution, which a tooltip pinned
 *  to the bottom of the tile would otherwise sit on top of. */
const TOOLTIP_INSET = 28

let protocolRegistered = false

/** The message of whatever MapLibre handed us: an `Error`, or a bare string. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string' && error) return error
  return 'the map failed to start'
}

function buildStyle(): StyleSpecification {
  const base = layers('protomaps', namedFlavor(THEME), { lang: 'local' })
  // The background layer has no source; every other layer is duplicated per
  // archive, painted in order so the finest set sits on top.
  const background = base.filter((layer) => layer.type === 'background')
  const data = base.filter((layer) => layer.type !== 'background')
  const perSource = (source: string) =>
    data.map((layer) => ({ ...layer, id: `${source}-${layer.id}`, source }))

  return {
    version: 8,
    glyphs: GLYPHS,
    sprite: SPRITE,
    sources: Object.fromEntries(
      BASEMAPS.map(({ id, url }) => [
        id,
        {
          type: 'vector',
          url: `pmtiles://${window.location.origin}${url}`,
          attribution: ATTRIBUTION,
        },
      ]),
    ) as StyleSpecification['sources'],
    layers: [
      ...background,
      ...BASEMAPS.flatMap(({ id }) => perSource(id)),
    ] as StyleSpecification['layers'],
  }
}

function toPoints(fixes: Fix[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: fixes.map((fix) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [fix.lon, fix.lat] },
      properties: {},
    })),
  }
}

/** The fixes in time order, joined into a single line. */
function toLine(fixes: Fix[]): FeatureCollection {
  if (fixes.length < 2) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: fixes.map((fix) => [fix.lon, fix.lat]) },
        properties: {},
      },
    ],
  }
}

/** One stretch of track, for the hover highlight. */
function toSegment(from: Fix, to: Fix): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[from.lon, from.lat], [to.lon, to.lat]] },
        properties: {},
      },
    ],
  }
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

/** Squared distance from a point to a segment, all in screen pixels — squared
 *  because it is only ever compared against a radius, never displayed. */
function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax
  const vy = by - ay
  const length = vx * vx + vy * vy
  const along = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / length))
  const dx = ax + along * vx - px
  const dy = ay + along * vy - py
  return dx * dx + dy * dy
}

export default function MapTile() {
  let container!: HTMLDivElement
  let map: MapLibreMap | undefined
  let ready = false
  let fixes: Fix[] = []

  // Screen positions of the fixes, one x, y pair each. The hover search runs on
  // every pointer move, and projecting a year of fixes on each of them would be
  // the whole cost of the feature; the camera settling is what invalidates them.
  let screen = new Float32Array(0)
  let tooltip: HTMLDivElement | undefined
  let tooltipTime: HTMLDivElement | undefined
  let hoverFrame = 0
  let hoverPoint: { x: number; y: number } | null = null
  // A pan or zoom moves the fixes under the pointer, so nothing is answered
  // until it settles — otherwise the tooltip would chase the camera with the
  // positions it had before the drag.
  let panning = false

  const [mode, setMode] = createSignal<LocationMode>('line')
  const [hovered, setHovered] = createSignal(false)

  // MapLibre reports a failure — no WebGL2 context, a tile answered 401, a style
  // resource that never arrives — as a throw from its constructor or as an
  // `error` event, and nowhere else. On a desktop that is a console line; on the
  // phone this dashboard is mostly opened from, it is a white rectangle. Keep the
  // first message on the tile itself.
  const [failure, setFailure] = createSignal<string | null>(null)
  const fail = (error: unknown) => setFailure((current) => current ?? describe(error))

  const applyData = () => {
    if (!map || !ready) return
    const points = map.getSource('location-points') as GeoJSONSource | undefined
    const line = map.getSource('location-line') as GeoJSONSource | undefined
    points?.setData(toPoints(fixes))
    line?.setData(toLine(fixes))
    const lineVisibility = mode() === 'line' ? 'visible' : 'none'
    map.setLayoutProperty('location-line-layer', 'visibility', lineVisibility)
    map.setLayoutProperty('location-points-layer', 'visibility', mode() === 'points' ? 'visible' : 'none')
    map.setLayoutProperty(
      'location-hover-point-layer',
      'visibility',
      mode() === 'points' ? 'visible' : 'none',
    )
    clearHover()
    projectFixes()
  }

  const loadFixes = async () => {
    if (!map || !ready) return
    const { from, to } = range()
    try {
      fixes = (await fetchData<Fix[]>(locationPointsSql(from, to))) ?? []
      applyData()
    } catch (error) {
      console.error('location query failed', error)
    }
  }

  /**
   * Frame the window's fixes: their bounding box, with room around it for the
   * stroke and for the attribution at the bottom.
   *
   * The map opens on a fixed centre, which is the right frame for a day at home
   * and the wrong one for a day three valleys away; this is the answer to "where
   * is the track" without hunting for it by hand. A window with a single fix has
   * no box to fit, so `maxZoom` stands in for one — it lands on the fix rather
   * than at the deepest zoom the tiles have.
   */
  const fitToFixes = () => {
    if (!map || fixes.length === 0) return
    const bounds = new LngLatBounds()
    for (const fix of fixes) bounds.extend([fix.lon, fix.lat])
    map.fitBounds(bounds, { padding: 48, maxZoom: 16, duration: 500 })
  }

  /** Where every fix is on screen, for the hover search. Rebuilt when the camera
   *  settles rather than per pointer move. */
  const projectFixes = () => {
    if (!map) return
    screen = new Float32Array(fixes.length * 2)
    for (let i = 0; i < fixes.length; i++) {
      const at = map.project([fixes[i].lon, fixes[i].lat])
      screen[i * 2] = at.x
      screen[i * 2 + 1] = at.y
    }
  }

  /**
   * What the track near `x, y` is: the nearest stretch of it, or the nearest fix
   * when the map draws points.
   *
   * A stretch rather than a fix, because most of a drawn track is between two
   * fixes — and the question being asked of the map is "when was this bit",
   * which the two ends of the stretch answer together.
   */
  const hoverAt = (x: number, y: number): { from: Fix; to: Fix | null } | null => {
    if (fixes.length === 0 || screen.length !== fixes.length * 2) return null
    const limit = HOVER_RADIUS * HOVER_RADIUS
    let best = -1
    let nearest = limit
    if (mode() === 'points' || fixes.length === 1) {
      for (let i = 0; i < fixes.length; i++) {
        const away = segmentDistance(x, y, screen[i * 2], screen[i * 2 + 1], screen[i * 2], screen[i * 2 + 1])
        if (away < nearest) {
          nearest = away
          best = i
        }
      }
      return best < 0 ? null : { from: fixes[best], to: null }
    }
    for (let i = 0; i < fixes.length - 1; i++) {
      const away = segmentDistance(
        x,
        y,
        screen[i * 2],
        screen[i * 2 + 1],
        screen[i * 2 + 2],
        screen[i * 2 + 3],
      )
      if (away < nearest) {
        nearest = away
        best = i
      }
    }
    return best < 0 ? null : { from: fixes[best], to: fixes[best + 1] }
  }

  /** The tooltip, placed beside the pointer and kept inside the tile. */
  const showTooltip = (fix: Fix, x: number, y: number) => {
    if (!tooltip || !tooltipTime) return
    const { from, to } = range()
    tooltipTime.textContent = formatTimestamp(fix.t, to.getTime() - from.getTime())
    tooltip.style.display = ''
    const gap = 12
    const boxWidth = tooltip.offsetWidth
    const boxHeight = tooltip.offsetHeight
    const left =
      x + gap + boxWidth > container.clientWidth ? x - gap - boxWidth : x + gap
    const top =
      y + gap + boxHeight > container.clientHeight - TOOLTIP_INSET
        ? y - gap - boxHeight
        : y + gap
    tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  }

  const clearHover = () => {
    if (!map || !ready) return
    const source = map.getSource('location-hover') as GeoJSONSource | undefined
    if (tooltip && tooltip.style.display !== 'none') {
      tooltip.style.display = 'none'
      source?.setData(EMPTY)
    }
  }

  const updateHover = (x: number, y: number) => {
    if (!map || !ready || panning) return
    const hit = hoverAt(x, y)
    if (!hit) {
      clearHover()
      return
    }
    const source = map.getSource('location-hover') as GeoJSONSource | undefined
    source?.setData(
      hit.to
        ? toSegment(hit.from, hit.to)
        : {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [hit.from.lon, hit.from.lat] },
                properties: {},
              },
            ],
          },
    )
    showTooltip(hit.from, x, y)
  }

  /** One search per frame: pointer moves arrive faster than the search is worth. */
  const queueHover = (point: { x: number; y: number }) => {
    hoverPoint = point
    if (hoverFrame) return
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0
      const at = hoverPoint
      hoverPoint = null
      if (at) updateHover(at.x, at.y)
    })
  }

  onMount(() => {
    if (!protocolRegistered) {
      addProtocol('pmtiles', new Protocol().tile as never)
      protocolRegistered = true
    }

    try {
      map = new MapLibreMap({
        container,
        style: buildStyle(),
        center: CENTER,
        zoom: 12,
        attributionControl: { compact: true },
      })
    } catch (error) {
      // The constructor throws when the browser cannot hand it a WebGL2 context
      // (`GPUInitializationError`), which an older phone cannot. Everything below
      // would throw in turn, so there is nothing left to set up.
      fail(error)
      return
    }

    // The sprite and the glyphs come from outside this service. A request that
    // hangs rather than fails keeps `style.loaded()` false, so `load` never fires
    // and no layer is ever added — silence rather than an error. Put a floor under
    // that wait instead of showing nothing for as long as the tab is open.
    const watchdog = window.setTimeout(() => {
      if (!ready) fail('the map style did not finish loading')
    }, 10_000)

    map.on('load', () => {
      if (!map) return
      window.clearTimeout(watchdog)
      map.addSource('location-points', { type: 'geojson', data: toPoints([]) })
      map.addSource('location-line', { type: 'geojson', data: toLine([]) })
      map.addLayer({
        id: 'location-line-layer',
        type: 'line',
        source: 'location-line',
        layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'visible' },
        paint: { 'line-color': TRACK, 'line-width': 1.5, 'line-opacity': 0.85 },
      })
      map.addLayer({
        id: 'location-points-layer',
        type: 'circle',
        source: 'location-points',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 2.5,
          'circle-color': TRACK,
          'circle-opacity': 0.7,
        },
      })
      // The hovered stretch, drawn in the track's own ink over a white casing so
      // it reads as "this bit" rather than as a second kind of line.
      map.addSource('location-hover', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'location-hover-casing-layer',
        type: 'line',
        source: 'location-hover',
        // Butt caps rather than round: a stretch between two fixes a few pixels
        // apart would otherwise render as a stadium shape and read as two dots.
        layout: { 'line-join': 'round', 'line-cap': 'butt' },
        paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.85 },
      })
      map.addLayer({
        id: 'location-hover-layer',
        type: 'line',
        source: 'location-hover',
        layout: { 'line-join': 'round', 'line-cap': 'butt' },
        paint: { 'line-color': TRACK, 'line-width': 3 },
      })
      // The same source carries a point when the map draws points; each layer
      // ignores the other's geometry. Kept hidden while the map draws the track
      // as a line — there the highlighted stretch is the answer, and a marker on
      // top of it only looked like the stretch had two round ends.
      map.addLayer({
        id: 'location-hover-point-layer',
        type: 'circle',
        source: 'location-hover',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 5,
          'circle-color': TRACK,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      })
      ready = true
      applyData()
      void loadFixes()
    })

      map.on('mousemove', (event) => queueHover(event.point))
      map.on('click', (event) => queueHover(event.point))
      map.on('mouseout', () => clearHover())
      map.on('movestart', () => {
        panning = true
        clearHover()
      })
      map.on('moveend', () => {
        panning = false
        projectFixes()
      })
    map.on('error', (event) => {
      console.error('map error', event.error)
      // Once the style is up an error is one tile or one glyph range, and the map
      // is still usable; before that it is the reason nothing is drawn.
      if (!ready) fail(event.error)
    })

    // `f` frames the window's fixes and is the answer to "where is the track"
    // from anywhere on the dashboard — where the pointer usually is after a drag
    // on the range strip. `p` changes what the map draws, so it stays the map's
    // own key and acts only while the pointer is over it.
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      const letter = event.key.toLowerCase()
      if (letter === 'f') {
        event.preventDefault()
        fitToFixes()
        return
      }
      if (letter !== 'p' || !hovered()) return
      event.preventDefault()
      setMode((current) => (current === 'points' ? 'line' : 'points'))
    }
    window.addEventListener('keydown', onKey)

    const observer = new ResizeObserver(() => {
      map?.resize()
      projectFixes()
    })
    observer.observe(container)

    // The tooltip is built imperatively and lives inside the map container, the
    // way the chart tiles' tooltips live inside uPlot's overlay: MapLibre owns
    // everything it is given, and a Solid-managed child would be cleared with it.
    tooltip = document.createElement('div')
    tooltip.className = 'map-tooltip'
    tooltip.style.display = 'none'
    tooltipTime = document.createElement('div')
    tooltipTime.className = 'map-tooltip-time'
    tooltip.append(tooltipTime)
    container.append(tooltip)

    onCleanup(() => {
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(watchdog)
      observer.disconnect()
      cancelAnimationFrame(hoverFrame)
      tooltip?.remove()
      tooltip = undefined
      tooltipTime = undefined
      map?.remove()
      map = undefined
      ready = false
      screen = new Float32Array(0)
    })
  })

  // Re-plot when the selected range changes.
  createEffect(() => {
    range()
    void loadFixes()
  })

  // Swap the rendered representation when the mode changes.
  createEffect(() => {
    mode()
    applyData()
  })

  return (
    <section
      class="tile wide map"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div class="map" ref={container} />
      <Show when={failure()}>{(message) => <p class="map-failure">{message()}</p>}</Show>
    </section>
  )
}
