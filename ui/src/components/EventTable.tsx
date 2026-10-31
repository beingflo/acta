import type { Accessor } from 'solid-js'

import { tableTimeParts } from '../lib/format'
import { eventDetail } from '../lib/detail'
import { type EventRow, eventCountSql, eventPageSql } from '../lib/query'
import PagedTable from './PagedTable'

/** Taller than a request row: the payload wraps to two lines. */
const ROW_HEIGHT = 44

const Table = PagedTable<EventRow>

/**
 * Every row that entered the system, or one source's rows. The payload stays one
 * JSON column rather than a column per key: each source has its own shape, and a
 * wide event (the server stats) carries dozens of fields.
 */
export default function EventTable(props: { title: string; source?: string }) {
  return (
    <Table
      title={props.title}
      variant="events"
      rowHeight={ROW_HEIGHT}
      // A narrower list is a different list: re-count and re-page from its top.
      reloadOn={() => props.source}
      countSql={(from, to, cursorUs) => eventCountSql(from, to, cursorUs, props.source)}
      pageSql={(query) => eventPageSql({ ...query, source: props.source })}
      head={
        <>
          <span class="col-time">Time</span>
          <span class="col-source">Source</span>
          <span class="col-data">Data</span>
        </>
      }
      row={(row) => <EventCells row={row} />}
      // The row already carries the payload as JSON text, so the overlay needs
      // no query: what the table shows whole is already the whole event.
      detail={(row) => eventDetail(row.us, row.source, row.data)}
    />
  )
}

function EventCells(props: { row: Accessor<EventRow> }) {
  const time = () => tableTimeParts(props.row().us)

  return (
    <>
      {/* The day is dropped on narrow screens, like the request table's clock. */}
      <span class="table-time col-time">
        <span class="table-day">{time().day} </span>
        {time().clock}
      </span>
      <span class="table-source col-source" title={props.row().source ?? ''}>
        {props.row().source ?? '—'}
      </span>
      {/* The full payload is in the title: the cell itself is clipped to two
          lines, because an eos-stats row is a whole nested object. */}
      <span class="table-json col-data" title={props.row().data ?? ''}>
        {props.row().data ?? '—'}
      </span>
    </>
  )
}
