import AlertCards from '../components/AlertCards'
import EventTable from '../components/EventTable'

/** The source the alert loop files its own firings and recoveries under. */
const REPORT_SOURCE = 'acta-alert'

/**
 * The threshold alerts (`service/src/alerts.rs`) and what they have mailed.
 *
 * Scalars only, grouped by alert: one card per check holding every number that
 * check reads — its level, the reading now, the mean over each of its windows
 * with the threshold beside it, the window it clears on, and how far the lookback
 * went. A check is a handful of scalars and nothing else, so a card is the shape
 * of the thing; the chart a dashboard would normally carry is on `eos` already,
 * where the reading is explored rather than watched.
 *
 * The cards do not follow the range picker — their windows are the checks' own —
 * while the table does: it is the record of what actually went out, one row per
 * firing and one per recovery, including a mail the relay refused.
 */
export default function Alerts() {
  return (
    <div class="dashboard filled alerts">
      <AlertCards />
      <EventTable title="Firings and recoveries" source={REPORT_SOURCE} />
    </div>
  )
}
