import EventTable from '../components/EventTable'
import ActaStats from '../components/ActaStats'
import SourceFilter, { createSourceFilter } from '../components/SourceFilter'
import TimeSeriesTile from '../components/TimeSeriesTile'

/**
 * Everything that enters the system: a strip of scalars about what is stored
 * and how fast it is arriving, one bar per bucket counting the rows of every
 * source, and the rows themselves. The chart answers "is data still arriving,
 * and from how many sources"; the table is the raw record.
 *
 * The source filter sits above the chart and narrows both, so a quiet collector
 * can be watched on its own without fishing its rows out of the firehose. The
 * strip above stays the whole system's totals, like Marending's.
 */
export default function Acta() {
  const filters = createSourceFilter()

  return (
    <div class="dashboard filled acta">
      <ActaStats />
      <SourceFilter
        facets={filters.facets()}
        source={filters.source()}
        onChange={filters.setSource}
      />
      <TimeSeriesTile
        bars
        wide
        title="Incoming entries"
        source={filters.source() || undefined}
        series={[{ label: 'Entries', expr: 'count(*)' }]}
        height={180}
      />
      <EventTable title="Entries" source={filters.source() || undefined} />
    </div>
  )
}
