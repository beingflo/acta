import type { Accessor } from 'solid-js'

import { latencyParts, tableTimeParts } from '../lib/format'
import { type RequestRow, requestCountSql, requestPageSql } from '../lib/query'
import PagedTable from './PagedTable'

const Table = PagedTable<RequestRow>

/** Access-log table: one row per request in the selected window. */
export default function RequestTable(props: { source: string; title: string }) {
  return (
    <Table
      title={props.title}
      variant="requests"
      countSql={(from, to, cursorUs) => requestCountSql(props.source, from, to, cursorUs)}
      pageSql={(query) => requestPageSql({ source: props.source, ...query })}
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
