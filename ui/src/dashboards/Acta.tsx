import EventTable from '../components/EventTable'
import ActaStats from '../components/ActaStats'
import SourceFilter, { createSourceFilter } from '../components/SourceFilter'
import TimeSeriesTile from '../components/TimeSeriesTile'
import { sourceFills } from '../lib/palette'
import { sourceCountExpr, type Series } from '../lib/query'

/**
 * Everything that enters the system: a strip of scalars about what is stored
 * and how fast it is arriving, one bar per bucket counting the rows of every
 * source, and the rows themselves. The chart answers "is data still arriving,
 * and from which sources"; the table is the raw record.
 *
 * The bars are stacked by source rather than drawn as one mass, so a collector
 * that has stopped is the slice that is missing, and each source keeps a colour
 * of its own. The source filter sits above both views and narrows them, drawing
 * the chosen source alone; the strip above stays the whole system's totals, like
 * Marending's.
 */
export default function Acta() {
  const filters = createSourceFilter()

  // One series per source, alphabetically. The facets arrive busiest-first,
  // which is right for the dropdown and wrong for the stack: a source that has a
  // busy hour would climb over the others and back down again, and a reader
  // comparing two ranges could not follow a band from one to the other. Name
  // order depends on nothing but the set of sources, so a band keeps its place —
  // and its place in the roster's ramp, darkest at the bottom. A window whose
  // sources have not been read yet counts everything together: the chart then
  // draws what the strip says, and is rebuilt into slices as soon as the list
  // lands.
  const series = (): Series[] => {
    const chosen = filters.source()
    if (chosen) return [{ label: chosen, expr: sourceCountExpr(chosen) }]
    const sources = filters.facets()
    if (!sources || sources.length === 0) return [{ label: 'Entries', expr: 'count(*)' }]
    return sources
      .map((facet) => facet.v)
      .sort()
      .map((source) => ({ label: source, expr: sourceCountExpr(source) }))
  }

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
        stacked
        wide
        title="Incoming entries"
        series={series()}
        fills={sourceFills(
          series().map((entry) => entry.label),
          filters.roster(),
        )}
        height={180}
      />
      <EventTable title="Entries" source={filters.source() || undefined} />
    </div>
  )
}
