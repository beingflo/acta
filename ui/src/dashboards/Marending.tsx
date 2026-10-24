import RequestTable from '../components/RequestTable'
import TimeSeriesTile from '../components/TimeSeriesTile'
import { BAR_ERROR_FILL, BAR_OK_FILL } from '../lib/palette'

/** Caddy's access log for marending.dev, migrated as the `marending` source. */
const SOURCE = 'marending'

/** A response the site served, as opposed to one it answered with an error. */
const SERVED = `coalesce(TRY_CAST(data.status AS INT), 0) < 400`
const REJECTED = `coalesce(TRY_CAST(data.status AS INT), 0) >= 400`

/** Request volume above, the requests themselves below. */
export default function Marending() {
  return (
    <div class="dashboard marending">
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
        fills={[BAR_OK_FILL, BAR_ERROR_FILL]}
        height={180}
      />
      <RequestTable source={SOURCE} title="Requests" />
    </div>
  )
}
