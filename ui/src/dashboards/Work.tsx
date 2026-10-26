import OfficeLane from '../components/OfficeLane'
import TimeSeriesTile from '../components/TimeSeriesTile'
import WorkStats from '../components/WorkStats'
import { officeFixesSql } from '../lib/query'

/**
 * The office day: when it started and when it resumed after lunch, presence over
 * the selected range, and the same days as a calendar.
 *
 * The geofence is the box in `lib/query.ts`; the source is the phone's own
 * position fixes, which carry `lon`/`lat` inside a GeoJSON point. The presence
 * chart is a step drawn through every fix, not a percentage and not a bucket
 * average: the tracker reports only when the phone moves, so the state between
 * two fixes is the last one seen, held until the next.
 */
export default function Work() {
  return (
    <div class="dashboard">
      <WorkStats />
      <TimeSeriesTile
        wide
        step
        title="At the office"
        series={[{ label: 'At office', expr: '' }]}
        query={officeFixesSql}
        // The line sits at 0 or 1; padding the scale keeps it off the axes.
        yRange={[-0.2, 1.2]}
        yTickEnds
        yTicks={(value) => (value > 0.5 ? 'in' : 'out')}
        height={200}
      />
      <OfficeLane />
    </div>
  )
}
