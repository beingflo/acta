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
  millisecond: 1,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
}

const NICE: [number, keyof typeof UNITS][] = [
  // Sub-second buckets, so a window shorter than a second still has more than
  // one bucket to draw.
  [10, 'millisecond'],
  [20, 'millisecond'],
  [50, 'millisecond'],
  [100, 'millisecond'],
  [200, 'millisecond'],
  [500, 'millisecond'],
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

export type Bucket = {
  /** SQL interval literal. */
  sql: string
  /** The same interval in milliseconds, for rebuilding the bucket grid. */
  ms: number
}

/**
 * Pick a bucket width for at most one point per `pxPerBucket` pixels, snapped to
 * a nice interval. Rounded up, not down: a finer bucket would return more points
 * than the chart has pixels, which are drawn on top of each other and cost rows
 * for nothing. Keeps the response small no matter how wide the range is, and
 * lets bars be spaced more coarsely than a line's points.
 */
export function bucketFor(from: Date, to: Date, widthPx: number, pxPerBucket = 1): Bucket {
  const points = Math.max(widthPx / pxPerBucket, 1)
  const target = Math.max((to.getTime() - from.getTime()) / points, 1)
  let best = NICE[NICE.length - 1]
  for (const candidate of NICE) {
    if (candidate[0] * UNITS[candidate[1]] >= target) {
      best = candidate
      break
    }
  }
  return { sql: `${best[0]} ${best[1]}s`, ms: best[0] * UNITS[best[1]] }
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

export type BucketGrid = {
  from: Date
  to: Date
  bucketMs: number
  /** Value for a bucket the reply has no row for. */
  fill: number | null
}

/** Convert `{ t, s0, ... }` rows into uPlot's column-oriented format. */
export function toAligned(
  rows: Array<Record<string, number | string>>,
  seriesCount: number,
  grid?: BucketGrid,
): uPlot.AlignedData {
  if (grid) return onGrid(rows, seriesCount, grid)
  // `t` is epoch seconds; uPlot expects that for a time axis.
  const timestamps = rows.map((row) => Number(row.t))
  const columns = Array.from({ length: seriesCount }, (_, i) =>
    rows.map((row) => {
      const value = row[`s${i}`]
      return typeof value === 'number' ? value : null
    }),
  )
  return [timestamps, ...columns] as uPlot.AlignedData
}

/**
 * Lay the reply out on every bucket of the range. A bucket with no events is
 * absent from a `GROUP BY`, and a bar chart needs those holes filled: uPlot
 * draws each bar up to the next point, so a missing bucket would become one
 * absurdly wide bar instead of a gap.
 *
 * The grid is stepped out from a bucket the reply actually returned rather than
 * computed from the epoch: DuckDB aligns multi-day buckets to its own origin
 * (2000-01-01), not to midnight UTC, so guessing the alignment drops every row.
 */
function onGrid(
  rows: Array<Record<string, number | string>>,
  seriesCount: number,
  grid: BucketGrid,
): uPlot.AlignedData {
  const byBucket = new Map<number, Record<string, number | string>>()
  let first: number | null = null
  for (const row of rows) {
    const at = Math.round(Number(row.t) * 1000)
    byBucket.set(at, row)
    if (first === null || at < first) first = at
  }
  // No rows at all: no anchor to align to, and nothing to plot.
  const emptyColumns = () =>
    Array.from({ length: seriesCount }, () => [] as (number | null)[])
  if (first === null) return [[], ...emptyColumns()] as uPlot.AlignedData

  // Empty buckets on either side are real zeros, so the bars span the window
  // the user asked for, not just the span that happened to see traffic.
  let start = first
  while (start - grid.bucketMs >= grid.from.getTime()) start -= grid.bucketMs

  const timestamps: number[] = []
  const values = emptyColumns()
  for (let at = start; at < grid.to.getTime(); at += grid.bucketMs) {
    const row = byBucket.get(at)
    timestamps.push(at / 1000)
    for (let i = 0; i < seriesCount; i++) {
      const value = row?.[`s${i}`]
      values[i].push(typeof value === 'number' ? value : grid.fill)
    }
  }
  return [timestamps, ...values] as uPlot.AlignedData
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

/** One access-log request, as the request table renders it. */
export type RequestRow = {
  /** Event time in microseconds since the epoch, and the table's page cursor. */
  us: number
  method: string | null
  uri: string | null
  status: number | null
  /** Response latency in milliseconds. */
  latency: number | null
  referrer: string | null
  /** `user_agent`, mostly to tell people from crawlers. */
  agent: string | null
  /** Only set on requests whose handler logged an error. */
  error: string | null
}

/** The window every access-log query shares. */
function requestWindow(source: string, from: Date, to: Date): string {
  return `source = '${escape(source)}'
    AND timestamp >= TIMESTAMPTZ '${from.toISOString()}'
    AND timestamp <  TIMESTAMPTZ '${to.toISOString()}'`
}

/** `timestamp <= cursor`, built from the same microseconds the page query
 *  reports back, so rows are addressed by time rather than by a scanned
 *  offset. */
function upTo(cursorUs: number): string {
  return `timestamp <= CAST(make_timestamp(${Math.round(cursorUs)}) AS TIMESTAMPTZ)`
}

/** Number of requests in the window, or in `[from, cursor]` when a cursor is
 *  given. Sizes the table's scroll spacer, and drives the bisection that finds
 *  an anchor at a given row. */
export function requestCountSql(
  source: string,
  from: Date,
  to: Date,
  cursorUs?: number,
): string {
  const bound = cursorUs === undefined ? '' : `\n    AND ${upTo(cursorUs)}`
  return `SELECT to_json(struct_pack(n := count(*)))::VARCHAR
FROM events
WHERE ${requestWindow(source, from, to)}${bound}`
}

/** One page of the request table, newest first, continuing at `cursorUs` when
 *  the caller already knows where the page starts. Paging by timestamp keeps
 *  deep pages as cheap as the first one; `offset` is only used for the few
 *  hundred rows between a bisection result and the requested page. */
export function requestPageSql(options: {
  source: string
  from: Date
  to: Date
  limit: number
  offset?: number
  cursorUs?: number
}): string {
  const { source, from, to } = options
  const limit = Math.max(1, Math.floor(options.limit))
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const cursor = options.cursorUs === undefined ? '' : `\n    AND ${upTo(options.cursorUs)}`
  // `data.errors` is a Variant array of `{ event, error }`; its text form is the
  // only useful rendering for a table cell, and null on requests without one.
  return `SELECT to_json(array_agg(struct_pack(
           us := us, method := method, uri := uri, status := status,
           latency := latency, referrer := referrer, agent := agent, error := error
         ) ORDER BY us DESC))::VARCHAR
FROM (
  SELECT epoch_us(CAST(timestamp AS TIMESTAMP)) AS us,
         data.method::VARCHAR                   AS method,
         data.uri::VARCHAR                      AS uri,
         TRY_CAST(data.status AS INT)           AS status,
         TRY_CAST(data.latency_ns AS BIGINT) / 1e6 AS latency,
         data.referrer::VARCHAR                 AS referrer,
         data.user_agent::VARCHAR               AS agent,
         data.errors::VARCHAR                   AS error
  FROM events
  WHERE ${requestWindow(source, from, to)}${cursor}
  ORDER BY timestamp DESC
  LIMIT ${limit} OFFSET ${offset}
)`
}
