import RequestTable from '../components/RequestTable'
import TimeSeriesTile from '../components/TimeSeriesTile'

/** Caddy's access log for marending.dev, migrated as the `marending` source. */
const WEBSITE = 'marending'

/** Request volume above, the requests themselves below. */
export default function Website() {
  return (
    <div class="dashboard website">
      <TimeSeriesTile
        bars
        wide
        title="Request volume"
        source={WEBSITE}
        series={[{ label: 'Requests', expr: 'count(*)' }]}
        height={96}
      />
      <RequestTable source={WEBSITE} title="Requests" />
    </div>
  )
}
