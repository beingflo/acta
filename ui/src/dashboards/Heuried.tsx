import LatestStrip from '../components/LatestStrip'
import TimeSeriesTile from '../components/TimeSeriesTile'

export default function Heuried() {
  return (
    <div class="dashboard">
      <LatestStrip />
      <TimeSeriesTile
        wide
        title="Heuried visitors"
        source="heuried-visitors"
        series={[{ label: 'Visitors', expr: 'avg(data::BIGINT)', metric: 'visitors' }]}
        yLabel="Visitors"
      />
    </div>
  )
}
