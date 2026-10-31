import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'

import { fetchData } from '../lib/api'
import { formatCompact } from '../lib/format'
import type { RequestFacet, RequestFilter } from '../lib/query'
import { requestFacetsSql } from '../lib/query'
import { range } from '../lib/range'
import FacetSelect from './FacetSelect'

/**
 * The fields worth narrowing the log by, in the order they usually do it: a
 * method and a status answer "what happened", a path area "to which part of the
 * site" — the pages and files it has, its feeds, and the two kinds of path it
 * does not, which is where most of this traffic goes. The long free-text fields
 * (URI, agent, referrer) are the search box, and everything else in a request —
 * content type, host, language — is rare enough to read in the row detail
 * instead of filtering the list for.
 */
const FIELDS = [
  { key: 'method', label: 'method', facet: 'method' },
  { key: 'status', label: 'status', facet: 'status' },
  { key: 'pathArea', label: 'path area', facet: 'path_area' },
] as const

type Field = (typeof FIELDS)[number]

/** Nothing narrowed. Empty strings rather than `undefined`, so a cleared field
 *  needs no special case anywhere else. */
export const NO_FILTER: RequestFilter = { method: '', status: '', pathArea: '', search: '' }

/** Typing in the search field must not fire a query per keystroke; a quarter
 *  second is below the point where the result feels late. */
const SEARCH_DEBOUNCE_MS = 250

/**
 * The filter row's state: what narrows the rows, what the search field holds,
 * and the values the dropdowns offer for the selected window. It lives above the
 * dashboard's chart and table rather than in either of them, because both are
 * narrowed by it — the chart is the same log counted per bucket.
 */
export function createRequestFilter(source: string) {
  const [filter, setFilter] = createSignal<RequestFilter>(NO_FILTER)
  const [typed, setTyped] = createSignal('')
  const [facets, setFacets] = createSignal<RequestFacet[] | null>(null)

  const change = (patch: Partial<RequestFilter>) =>
    setFilter((previous) => ({ ...previous, ...patch }))

  // The field follows the keystrokes, the queries follow the pause.
  let searchTimer = 0
  const type = (value: string) => {
    setTyped(value)
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => change({ search: value }), SEARCH_DEBOUNCE_MS)
  }

  const clear = () => {
    window.clearTimeout(searchTimer)
    setTyped('')
    setFilter({ ...NO_FILTER })
  }

  onCleanup(() => window.clearTimeout(searchTimer))

  // Read per window and per filter, but not on every poll: a narrowed view has a
  // different vocabulary, ten seconds of new requests do not.
  let facetRead = 0
  createEffect(() => {
    const { from, to } = range()
    const narrowed = filter()
    const current = ++facetRead
    void fetchData<RequestFacet[]>(requestFacetsSql(source, from, to, narrowed))
      .then((rows) => {
        if (current === facetRead) setFacets(rows ?? [])
      })
      .catch((error) => {
        if (current === facetRead) console.error('could not read the request facets', error)
      })
  })

  const active = () =>
    filter().method !== '' || filter().status !== '' || filter().pathArea !== '' || typed() !== ''

  return { filter, typed, facets, active, type, change, clear }
}

/** The filter row itself: the values the selected window actually contains, and
 *  a substring search over the two long text columns. */
export default function RequestFilters(props: {
  /** `null` until the first read lands; the dropdowns then hold only "all". */
  facets: RequestFacet[] | null
  filter: RequestFilter
  onChange: (patch: Partial<RequestFilter>) => void
  /** What the search field shows, which runs ahead of `filter.search`. */
  typed: string
  onType: (value: string) => void
  onClear: () => void
  active: boolean
}) {
  const options = (field: Field) => {
    const values = (props.facets ?? []).filter((facet) => facet.f === field.facet)
    // A status reads in numeric order and the areas alphabetically; a method
    // stays most frequent first, which is the order the query returns it in.
    if (field.facet === 'status') values.sort((a, b) => Number(a.v) - Number(b.v))
    if (field.facet === 'path_area') values.sort((a, b) => a.v.localeCompare(b.v))
    return values.map((facet) => ({
      value: facet.v,
      label: `${facet.v} · ${formatCompact(facet.n)}`,
    }))
  }

  return (
    <div class="filters">
      <For each={FIELDS}>
        {(field) => (
          <FacetSelect
            label={field.label}
            options={options(field)}
            value={props.filter[field.key]}
            onChange={(value) => props.onChange({ [field.key]: value })}
          />
        )}
      </For>
      <input
        class="filter-search"
        classList={{ set: props.typed !== '' }}
        type="search"
        placeholder="uri, user agent or referrer"
        aria-label="search uri, user agent and referrer"
        value={props.typed}
        onInput={(event) => props.onType(event.currentTarget.value)}
      />
      <Show when={props.active}>
        <button class="filter-clear" onClick={() => props.onClear()}>
          clear
        </button>
      </Show>
    </div>
  )
}
