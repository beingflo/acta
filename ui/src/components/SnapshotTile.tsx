import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import { fetchData } from '../lib/api'
import { formatNumber, formatTimestamp } from '../lib/format'
import { range } from '../lib/range'

const REFRESH_MS = 30_000
const JITTER_MS = 5_000

type Sample = { at: number; data: unknown }

/**
 * The newest row of a source, flattened to one key/value row per leaf. Charts
 * only show what a tile was told to plot; a collector that keeps adding fields
 * (per container, per mount, per thermal zone) would otherwise need a tile per
 * field before it can be seen at all.
 */
export default function SnapshotTile(props: { source: string; title: string; wide?: boolean }) {
  const [sample, setSample] = createSignal<Sample | null>(null)
  const [loading, setLoading] = createSignal(true)
  let requestId = 0

  const load = async () => {
    const { from, to } = range()
    // The payload is JSON stored in a Variant, so it goes straight back out as
    // JSON text; `/api/data` returns exactly the one string the query produced.
    const sql = `SELECT coalesce((
  SELECT to_json(struct_pack(
           at := epoch(CAST(timestamp AS TIMESTAMP)),
           data := data
         ))::VARCHAR
  FROM events
  WHERE source = '${props.source.replace(/'/g, "''")}'
    AND timestamp >= TIMESTAMPTZ '${from.toISOString()}'
    AND timestamp <  TIMESTAMPTZ '${to.toISOString()}'
  ORDER BY timestamp DESC
  LIMIT 1
), 'null')`

    const request = ++requestId
    try {
      const row = await fetchData<Sample | null>(sql)
      if (request === requestId) setSample(row)
    } catch (error) {
      if (request === requestId) console.error(`snapshot "${props.title}" query failed`, error)
    } finally {
      if (request === requestId) setLoading(false)
    }
  }

  const rows = createMemo(() => {
    const current = sample()
    return current ? leaves(current.data) : []
  })

  const at = () => {
    const current = sample()
    if (!current) return ''
    const { from, to } = range()
    return formatTimestamp(current.at, to.getTime() - from.getTime())
  }

  createEffect(() => {
    range() // re-run when the selected window changes
    void load()
  })

  onMount(() => {
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await load()
        schedule()
      }, REFRESH_MS + Math.random() * JITTER_MS)
    }
    schedule()
    onCleanup(() => {
      clearTimeout(timer)
      requestId++ // drop replies that are still in flight
    })
  })

  return (
    <section class="tile snapshot" classList={{ wide: props.wide }}>
      <header class="tile-title">
        {props.title}
        <Show when={sample()}>
          <span class="tile-count"> · {at()}</span>
        </Show>
      </header>
      <Show
        when={rows().length > 0}
        fallback={
          <div class="snapshot-empty">
            {loading() ? 'loading…' : 'no sample in this selected range'}
          </div>
        }
      >
        <div class="snapshot-rows">
          <For each={rows()}>
            {(row) => (
              <div class="snapshot-row">
                <span class="snapshot-key">{row.key}</span>
                <span class="snapshot-value">{row.value}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}

/** Every leaf of the payload as `path -> text`, so nesting stays readable. */
function leaves(value: unknown, prefix = ''): { key: string; value: string }[] {
  if (value === null || typeof value !== 'object') {
    return [{ key: prefix || 'value', value: text(value) }]
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return [{ key: prefix, value: '{}' }]
  return entries.flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key))
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return formatNumber(value)
  return String(value)
}
