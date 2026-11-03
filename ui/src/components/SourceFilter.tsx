import { createEffect, createSignal } from 'solid-js'

import { fetchData } from '../lib/api'
import { formatCompact } from '../lib/format'
import { type EventSourceFacet, eventSourceFacetsSql, sourcesSql } from '../lib/query'
import { range } from '../lib/range'
import FacetSelect from './FacetSelect'

/**
 * The acta table's state: which source it is narrowed to, the sources the
 * selected window holds, and the roster of every source the dataset holds. A
 * plain column, so unlike the request filters these reads stay cheap on any
 * window.
 */
export function createSourceFilter() {
  const [source, setSource] = createSignal('')
  const [facets, setFacets] = createSignal<EventSourceFacet[] | null>(null)
  const [roster, setRoster] = createSignal<string[]>([])

  // The roster is not a window's answer but the dataset's, so it is read once:
  // it is what the chart's colours are ordered by, and re-reading it with every
  // range would re-decide shades that are meant to stay put. A collector that
  // starts later takes its place on the next page load.
  void fetchData<string[]>(sourcesSql())
    .then((names) => setRoster(names ?? []))
    .catch((error) => console.warn('could not read the source roster', error))

  // Per window, not per poll: a collector that starts or stops is worth noticing
  // when the range moves, not every ten seconds.
  let facetRead = 0
  createEffect(() => {
    const { from, to } = range()
    const current = ++facetRead
    void fetchData<EventSourceFacet[]>(eventSourceFacetsSql(from, to))
      .then((rows) => {
        if (current === facetRead) setFacets(rows ?? [])
      })
      .catch((error) => {
        if (current === facetRead) console.error('could not read the event sources', error)
      })
  })

  return { source, setSource, facets, roster }
}

/** The filter row above the acta chart: one source, chosen from the sources the
 *  window actually holds, with their row counts. */
export default function SourceFilter(props: {
  /** `null` until the first read lands; the dropdown then holds only "source". */
  facets: EventSourceFacet[] | null
  source: string
  onChange: (source: string) => void
}) {
  return (
    <div class="filters">
      <FacetSelect
        label="source"
        options={(props.facets ?? []).map((facet) => ({
          value: facet.v,
          label: `${facet.v} · ${formatCompact(facet.n)}`,
        }))}
        value={props.source}
        onChange={props.onChange}
      />
    </div>
  )
}
