import RequestTable from '../components/RequestTable'
import TimeSeriesTile from '../components/TimeSeriesTile'

/** Caddy's access log for marending.dev, migrated as the `marending` source. */
const SOURCE = 'marending'

/** Request volume above, the requests themselves below. */
export default function Marending() {
  return (
    <div class="dashboard marending">
      <TimeSeriesTile
        bars
        wide
        title="Request volume"
        source={SOURCE}
        series={[{ label: 'Requests', expr: 'count(*)' }]}
        height={180}
      />
      <RequestTable source={SOURCE} title="Requests" />
    </div>
  )
}
