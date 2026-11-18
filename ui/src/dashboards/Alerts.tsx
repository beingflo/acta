import AlertChecks from '../components/AlertChecks'
import EventTable from '../components/EventTable'
import TimeSeriesTile from '../components/TimeSeriesTile'
import { TEMPERATURE } from '../lib/scale'

/** The source the board temperature check reads: `stats/collect.py` on eos. */
const SOURCE = 'eos-stats'

/** The source the alert loop files its own firings and recoveries under. */
const REPORT_SOURCE = 'acta-alert'

/**
 * The threshold alerts (`service/src/alerts.rs`), as one page: the check's own
 * numbers right now, the reading it watches over the selected range, and what it
 * has mailed.
 *
 * The strip above does not follow the range picker — its windows are the check's,
 * and a check always looks at the last hour — while the chart and the table do.
 * That is the split worth having: the strip answers "would it mail now", the
 * chart answers "how did it get here", and the table is the record of what
 * actually went out, including the mail the relay refused.
 *
 * One check and one tile per check: a second alert gets another strip and another
 * chart here, and nothing else about the dashboard changes.
 */
export default function Alerts() {
  return (
    <div class="dashboard filled alerts">
      <AlertChecks source={SOURCE} />
      <TimeSeriesTile
        wide
        title="Board temperature"
        source={SOURCE}
        yLabel="Board [°C]"
        yFit={TEMPERATURE}
        series={[{ label: 'Board', expr: 'avg(data.temp.board_c::DOUBLE)' }]}
      />
      <EventTable title="Firings and recoveries" source={REPORT_SOURCE} />
    </div>
  )
}
