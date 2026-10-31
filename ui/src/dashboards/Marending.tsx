import MarendingStats from '../components/MarendingStats'
import RequestFilters, { createRequestFilter } from '../components/RequestFilters'
import RequestTable from '../components/RequestTable'
import TimeSeriesTile from '../components/TimeSeriesTile'
import { BAR_ERROR_FILL, BAR_OK_FILL } from '../lib/palette'
import { requestFilterSql } from '../lib/query'

/** Caddy's access log for marending.dev, migrated as the `marending` source. */
const SOURCE = 'marending'

/** A response the site served, as opposed to one it answered with an error. */
const SERVED = `coalesce(TRY_CAST(data.status AS INT), 0) < 400`
const REJECTED = `coalesce(TRY_CAST(data.status AS INT), 0) >= 400`

/** Request volume and latency above, the requests themselves below.
 *
 * The filter row belongs to the dashboard rather than to either of them: the
 * chart is the same log counted per bucket, so narrowing the table and leaving
 * the chart whole would let the two disagree about what "the requests" are. The
 * stats strip above stays the window's own totals — "all requests", "last hour"
 * have no filter to apply. */
export default function Marending() {
  const filters = createRequestFilter(SOURCE)

  return (
    <div class="dashboard filled marending">
      <MarendingStats source={SOURCE} />
      <RequestFilters
        facets={filters.facets()}
        filter={filters.filter()}
        onChange={filters.change}
        typed={filters.typed()}
        onType={filters.type}
        onClear={filters.clear}
        active={filters.active()}
      />
      <TimeSeriesTile
        bars
        stacked
        wide
        title="Request volume"
        source={SOURCE}
        series={[
          { label: 'Served', expr: `count(*) FILTER (WHERE ${SERVED})` },
          { label: 'Errors', expr: `count(*) FILTER (WHERE ${REJECTED})` },
        ]}
        // The chart counts the rows the table is filtered to, so a bar is a
        // bucket of exactly the requests listed below it.
        where={requestFilterSql(filters.filter())}
        fills={[BAR_OK_FILL, BAR_ERROR_FILL]}
        height={180}
      />
      <RequestTable source={SOURCE} title="Requests" filter={filters.filter()} />
    </div>
  )
}
