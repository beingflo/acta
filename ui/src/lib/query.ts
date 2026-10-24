/** Query helpers: resolution selection and the SQL issued to `/api/data`. */

import type uPlot from 'uplot'

export type Series = {
  label: string
  /**
   * Raw DuckDB aggregate expression. Cast Variant fields to their concrete type
   * before aggregating: aggregates over a raw floating-point Variant field are
   * silently wrong (e.g. `avg(data.temperature)` vs `avg(data.temperature::DOUBLE)`).
   */
  expr: string
}

const UNITS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
}

const NICE: [number, keyof typeof UNITS][] = [
  [1, 'second'],
  [2, 'second'],
  [5, 'second'],
  [10, 'second'],
  [15, 'second'],
  [30, 'second'],
  [1, 'minute'],
  [2, 'minute'],
  [5, 'minute'],
  [10, 'minute'],
  [15, 'minute'],
  [30, 'minute'],
  [1, 'hour'],
  [2, 'hour'],
  [3, 'hour'],
  [6, 'hour'],
  [12, 'hour'],
  [1, 'day'],
  [2, 'day'],
  [7, 'day'],
  [14, 'day'],
  [30, 'day'],
  [90, 'day'],
  [365, 'day'],
]

/**
 * Pick a bucket width targeting roughly one point per pixel, snapped to a nice
 * interval. Keeps the response small no matter how wide the range is.
 */
export function bucketFor(from: Date, to: Date, widthPx: number): string {
  const target = Math.max((to.getTime() - from.getTime()) / Math.max(widthPx, 1), 1_000)
  let best = NICE[0]
  for (const candidate of NICE) {
    if (candidate[0] * UNITS[candidate[1]] <= target) best = candidate
    else break
  }
  return `${best[0]} ${best[1]}s`
}

/** One query returning a single JSON array of `{ t, s0, s1, ... }` points. */
export function timeSeriesSql(options: {
  source: string
  series: Series[]
  bucket: string
  from: Date
  to: Date
}): string {
  const aggregates = options.series.map((s, i) => `${s.expr} AS s${i}`).join(',\n         ')
  const fields = options.series.map((_, i) => `s${i} := s${i}`).join(', ')
  // `timestamp` is TIMESTAMPTZ; cast to naive UTC before time functions. The
  // bundled DuckDB has no ICU extension, so tz-aware functions are unavailable.
  return `SELECT coalesce(
           to_json(array_agg(struct_pack(t := epoch(b), ${fields}) ORDER BY b)),
           '[]'::JSON
         )::VARCHAR
FROM (
  SELECT time_bucket(INTERVAL '${options.bucket}', CAST(timestamp AS TIMESTAMP)) AS b,
         ${aggregates}
  FROM events
  WHERE source = '${escape(options.source)}'
    AND timestamp >= TIMESTAMPTZ '${options.from.toISOString()}'
    AND timestamp <  TIMESTAMPTZ '${options.to.toISOString()}'
  GROUP BY 1
)`
}

/** Convert `{ t, s0, ... }` rows into uPlot's column-oriented format. */
export function toAligned(
  rows: Array<Record<string, number | string>>,
  seriesCount: number,
): uPlot.AlignedData {
  const timestamps = rows.map((row) => Number(row.t))
  const columns = Array.from({ length: seriesCount }, (_, i) =>
    rows.map((row) => {
      const value = row[`s${i}`]
      return typeof value === 'number' ? value : null
    }),
  )
  return [timestamps, ...columns] as uPlot.AlignedData
}

/** Location fixes as `{ lon, lat }` pairs, in time order, for the map tile. */
export function locationPointsSql(from: Date, to: Date): string {
  return `SELECT coalesce(
           to_json(array_agg(struct_pack(lon := lon, lat := lat) ORDER BY ts)),
           '[]'::JSON
         )::VARCHAR
FROM (
  SELECT timestamp AS ts,
         data.geometry.coordinates[1]::DOUBLE AS lon,
         data.geometry.coordinates[2]::DOUBLE AS lat
  FROM events
  WHERE source = 'location_florian'
    AND data.geometry.type = 'Point'
    AND timestamp >= TIMESTAMPTZ '${from.toISOString()}'
    AND timestamp <  TIMESTAMPTZ '${to.toISOString()}'
)`
}

function escape(value: string): string {
  return value.replace(/'/g, "''")
}
