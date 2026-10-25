import EventTable from '../components/EventTable'
import ActaStats from '../components/ActaStats'
import TimeSeriesTile from '../components/TimeSeriesTile'

/**
 * Everything that enters the system: a strip of scalars about what is stored
 * and how fast it is arriving, one bar per bucket counting the rows of every
 * source, and the rows themselves. The chart answers "is data still arriving,
 * and from how many sources"; the table is the raw record.
 */
export default function Acta() {
  return (
    <div class="dashboard filled acta">
      <ActaStats />
      <TimeSeriesTile
        bars
        wide
        title="Incoming entries"
        series={[{ label: 'Entries', expr: 'count(*)' }]}
        height={180}
      />
      <EventTable title="Entries" />
    </div>
  )
}
