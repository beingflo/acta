import type { Accessor } from 'solid-js'

import { fetchData } from '../lib/api'
import { eventDetail } from '../lib/detail'
import { latencyParts, tableTimeParts } from '../lib/format'
import {
  type RequestFilter,
  type RequestRow,
  type StoredEvent,
  eventDetailSql,
  requestCountSql,
  requestPageSql,
} from '../lib/query'
import PagedTable from './PagedTable'

const Table = PagedTable<RequestRow>

/** Access-log table: one row per request in the selected window, narrowed by the
 *  dashboard's filter row. */
export default function RequestTable(props: {
  source: string
  title: string
  /** What the rows are cut down to. Empty fields leave them whole. */
  filter: RequestFilter
}) {
  return (
    <Table
      title={props.title}
      variant="requests"
      // A narrower list is a different list: re-count and re-page from its top.
      reloadOn={() => props.filter}
      countSql={(from, to, cursorUs) =>
        requestCountSql(props.source, from, to, cursorUs, props.filter)
      }
      pageSql={(query) =>
        requestPageSql({ source: props.source, ...query, filter: props.filter })
      }
      head={
        <>
          <span class="col-time">Time</span>
          <span class="col-method">Method</span>
          <span class="col-uri">URI</span>
          <span class="col-status">Status</span>
          <span class="col-latency">Latency</span>
          <span class="col-referrer">Referrer</span>
          <span class="col-agent">User agent</span>
          <span class="col-error">Error</span>
        </>
      }
      row={(row) => <RequestCells row={row} />}
      // The table keeps the six columns it displays; a request row carries more
      // than that (and different fields from source to source), so the overlay
      // asks for the stored event itself.
      detail={async (row) => {
        const stored = await fetchData<StoredEvent | null>(eventDetailSql(props.source, row.us))
        return eventDetail(row.us, stored?.source ?? props.source, stored?.data ?? null)
      }}
    />
  )
}

function RequestCells(props: { row: Accessor<RequestRow> }) {
  const time = () => tableTimeParts(props.row().us)

  return (
    <>
      {/* The day is dropped on narrow screens, where it would ellipsize the
          clock away. */}
      <span class="table-time col-time">
        <span class="table-day">{time().day} </span>
        {time().clock}
      </span>
      <span class="table-method col-method">{props.row().method ?? '—'}</span>
      <span class="col-uri" title={props.row().uri ?? ''}>
        {props.row().uri ?? '—'}
      </span>
      <span
        class="col-status"
        classList={{ status: true, failed: (props.row().status ?? 0) >= 400 }}
      >
        {props.row().status ?? '—'}
      </span>
      <span class="col-latency">{formatLatency(props.row().latency)}</span>
      <span class="muted col-referrer" title={props.row().referrer ?? ''}>
        {emptyAsDash(props.row().referrer)}
      </span>
      <span class="muted col-agent" title={props.row().agent ?? ''}>
        {emptyAsDash(props.row().agent)}
      </span>
      <span class="failed col-error" title={props.row().error ?? ''}>
        {shortError(props.row().error ?? '')}
      </span>
    </>
  )
}

function formatLatency(ms: number | null): string {
  const parts = latencyParts(ms)
  return parts ? `${parts.value} ${parts.unit}` : '—'
}

function emptyAsDash(value: string | null): string {
  return value === null || value === '' ? '—' : value
}

/** The payload's `errors` field is DuckDB's text form of a Variant array; the
 *  message inside it is the part worth reading. */
function shortError(raw: string): string {
  const match = raw.match(/'error':\s*'([^']*)'/)
  return match ? match[1] : raw
}
