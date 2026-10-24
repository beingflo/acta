import { createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import type { FeatureCollection } from 'geojson'
import { Map as MapLibreMap, addProtocol, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { layers, namedFlavor } from '@protomaps/basemaps'
import 'maplibre-gl/dist/maplibre-gl.css'

import { fetchData } from '../lib/api'
import { STROKE } from '../lib/palette'
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

type Fix = { lon: number; lat: number }
type LocationMode = 'points' | 'line'

let protocolRegistered = false

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

export default function MapTile() {
  let container!: HTMLDivElement
  let map: MapLibreMap | undefined
  let ready = false
  let fixes: Fix[] = []

  const [mode, setMode] = createSignal<LocationMode>('line')
  const [hovered, setHovered] = createSignal(false)

  const applyData = () => {
    if (!map || !ready) return
    const points = map.getSource('location-points') as GeoJSONSource | undefined
    const line = map.getSource('location-line') as GeoJSONSource | undefined
    points?.setData(toPoints(fixes))
    line?.setData(toLine(fixes))
    map.setLayoutProperty('location-line-layer', 'visibility', mode() === 'line' ? 'visible' : 'none')
    map.setLayoutProperty('location-points-layer', 'visibility', mode() === 'points' ? 'visible' : 'none')
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

  onMount(() => {
    if (!protocolRegistered) {
      addProtocol('pmtiles', new Protocol().tile as never)
      protocolRegistered = true
    }

    map = new MapLibreMap({
      container,
      style: buildStyle(),
      center: CENTER,
      zoom: 12,
      attributionControl: { compact: true },
    })

    map.on('load', () => {
      if (!map) return
      map.addSource('location-points', { type: 'geojson', data: toPoints([]) })
      map.addSource('location-line', { type: 'geojson', data: toLine([]) })
      map.addLayer({
        id: 'location-line-layer',
        type: 'line',
        source: 'location-line',
        layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'visible' },
        paint: { 'line-color': STROKE, 'line-width': 1.5, 'line-opacity': 0.7 },
      })
      map.addLayer({
        id: 'location-points-layer',
        type: 'circle',
        source: 'location-points',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 2.5,
          'circle-color': STROKE,
          'circle-opacity': 0.55,
        },
      })
      ready = true
      applyData()
      void loadFixes()
    })
    map.on('error', (event) => console.error('map error', event.error))

    // `p` toggles points / line, but only while the pointer is over the map.
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (!hovered() || event.key.toLowerCase() !== 'p') return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      event.preventDefault()
      setMode((current) => (current === 'points' ? 'line' : 'points'))
    }
    window.addEventListener('keydown', onKey)

    const observer = new ResizeObserver(() => map?.resize())
    observer.observe(container)

    onCleanup(() => {
      window.removeEventListener('keydown', onKey)
      observer.disconnect()
      map?.remove()
      map = undefined
      ready = false
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
    </section>
  )
}
