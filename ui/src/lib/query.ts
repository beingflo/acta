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
  /** Omit to count every source, as the acta dashboard's overview does. */
  source?: string
  series: Series[]
  bucket: string
  from: Date
  to: Date
}): string {
  const aggregates = options.series.map((s, i) => `${s.expr} AS s${i}`).join(',\n         ')
  const fields = options.series.map((_, i) => `s${i} := s${i}`).join(', ')
  const source =
    options.source === undefined ? '' : `\n    AND source = '${escape(options.source)}'`
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
  WHERE timestamp >= TIMESTAMPTZ '${options.from.toISOString()}'
    AND timestamp <  TIMESTAMPTZ '${options.to.toISOString()}'${source}
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

/** The window every events query shares, across all sources. */
function eventWindow(from: Date, to: Date): string {
  return `timestamp >= TIMESTAMPTZ '${from.toISOString()}'
    AND timestamp <  TIMESTAMPTZ '${to.toISOString()}'`
}

/** One row of any source, as the acta table renders it. */
export type EventRow = {
  /** Event time in microseconds since the epoch, and the table's page cursor. */
  us: number
  source: string | null
  /** The payload as compact JSON text: the table shows it whole rather than
   *  flattening it into a column per key, which no two sources share. */
  data: string | null
}

/** Scalars for the acta stats strip. */
export type Overview = {
  /** Rows in the selected window. */
  rows: number
  /** Distinct sources in the window. */
  sources: number
  /** Their names, in no particular order. */
  source_names: string[]
  /** Rows in the window's final hour. */
  last_hour: number
  /** Newest event anywhere, in epoch seconds; null on an empty dataset. */
  newest: number | null
}

/**
 * Totals over the selected window. `newest` is taken over the whole dataset
 * rather than the window, so the age of the last event still tells the truth
 * when the window has been stepped back in time.
 */
export function overviewSql(from: Date, to: Date): string {
  const lastHour = new Date(to.getTime() - 3_600_000).toISOString()
  return `SELECT to_json(struct_pack(
           rows := count(*),
           sources := count(DISTINCT source),
           source_names := list(DISTINCT source),
           last_hour := count(*) FILTER (WHERE timestamp >= TIMESTAMPTZ '${lastHour}'),
           newest := (SELECT epoch(CAST(max(timestamp) AS TIMESTAMP)) FROM events)
         ))::VARCHAR
FROM events
WHERE timestamp >= TIMESTAMPTZ '${from.toISOString()}'
  AND timestamp <  TIMESTAMPTZ '${to.toISOString()}'`
}

/** What the Parquet files on disk add up to. */
export type FileStats = {
  bytes: number
  rows: number
  files: number
}

/**
 * The Parquet files on disk, summed from their footers. `parquet_file_metadata`
 * needs a path and the frontend does not know the data directory, so it is read
 * off the list of directories the service allows DuckDB to read: exactly one
 * entry besides DuckDB's own temp directory. The temp directory is filtered out
 * by name rather than skipped by index — its position in the list varies, it can
 * be registered before or after the service sets its directory. The glob is the
 * one behind the `events` view; `[!.]*` skips macOS sidecar files.
 */
export function filesSql(): string {
  return `SELECT to_json(struct_pack(
           bytes := sum(file_size_bytes),
           rows := sum(num_rows),
           files := count(*)
         ))::VARCHAR
FROM parquet_file_metadata(
  list_filter(
    current_setting('allowed_directories'),
    lambda d: NOT ends_with(
      rtrim(d, '/'),
      '/' || regexp_extract(rtrim(current_setting('temp_directory'), '/'), '[^/]+$')
    )
  )[1] || '[!.]*.parquet'
)`
}

/** Scalars for the marending stats strip. */
export type RequestOverview = {
  /** Requests in the selected window. */
  rows: number
  /** Those answered with 4xx/5xx. */
  errors: number
  /** Requests in the window's final hour. */
  last_hour: number
  /** Median and 95th percentile response time, in nanoseconds. */
  p50_ns: number | null
  p95_ns: number | null
  /** Every request ever logged for the source. */
  all_rows: number
  /** Newest request for the source, in epoch seconds. */
  newest: number | null
}

/**
 * Totals for the marending stats strip: the window's requests, errors and
 * response times, plus the all-time count and the newest request. The latter
 * two ignore the window so the strip still reads correctly when it is stepped
 * back in time.
 */
export function requestOverviewSql(source: string, from: Date, to: Date): string {
  const lastHour = new Date(to.getTime() - 3_600_000).toISOString()
  return `SELECT to_json(struct_pack(
           rows := count(*),
           errors := count(*) FILTER (WHERE coalesce(TRY_CAST(data.status AS INT), 0) >= 400),
           last_hour := count(*) FILTER (WHERE timestamp >= TIMESTAMPTZ '${lastHour}'),
           p50_ns := quantile_cont(TRY_CAST(data.latency_ns AS BIGINT), 0.5),
           p95_ns := quantile_cont(TRY_CAST(data.latency_ns AS BIGINT), 0.95),
           all_rows := (SELECT count(*) FROM events WHERE source = '${escape(source)}'),
           newest := (SELECT epoch(CAST(max(timestamp) AS TIMESTAMP)) FROM events
                      WHERE source = '${escape(source)}')
         ))::VARCHAR
FROM events
WHERE ${requestWindow(source, from, to)}`
}

/** Number of rows in the window, or in `[from, cursor]` when a cursor is given,
 *  across every source. */
export function eventCountSql(from: Date, to: Date, cursorUs?: number): string {
  const bound = cursorUs === undefined ? '' : `\n    AND ${upTo(cursorUs)}`
  return `SELECT to_json(struct_pack(n := count(*)))::VARCHAR
FROM events
WHERE ${eventWindow(from, to)}${bound}`
}

/** One page of the acta table: every row in the window, newest first, with its
 *  source and its payload as JSON. */
export function eventPageSql(options: {
  from: Date
  to: Date
  limit: number
  offset?: number
  cursorUs?: number
  /** Rows strictly newer than this, oldest first — the direction the overlay's
   *  upward walk asks for. Mutually exclusive with `cursorUs`. */
  newerThanUs?: number
}): string {
  const { from, to } = options
  const limit = Math.max(1, Math.floor(options.limit))
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  // Newest first for paging; oldest first for the one row above a detail's row.
  const descending = options.newerThanUs === undefined
  const bound = descending
    ? options.cursorUs === undefined
      ? ''
      : `\n    AND ${upTo(options.cursorUs)}`
    : `\n    AND ${newerThan(options.newerThanUs!)}`
  const order = descending ? 'DESC' : 'ASC'
  // `coalesce` for the empty page: casting a null `array_agg` to VARCHAR is an
  // error in this DuckDB, not a null, so a page past either end used to answer
  // 400 instead of `[]`.
  return `SELECT coalesce(to_json(array_agg(
           struct_pack(us := us, source := source, data := data) ORDER BY us ${order}
         )), '[]'::JSON)::VARCHAR
FROM (
  SELECT epoch_us(CAST(timestamp AS TIMESTAMP)) AS us,
         source,
         to_json(data)::VARCHAR                AS data
  FROM events
  WHERE ${eventWindow(from, to)}${bound}
  ORDER BY timestamp ${order}
  LIMIT ${limit} OFFSET ${offset}
)`
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

/** What `eventDetailSql` returns: the stored event without the timestamp the
 *  caller already holds, or `null` when the row is no longer there. */
export type StoredEvent = {
  source: string | null
  /** The payload as JSON text, the form every page query carries it in. */
  data: string | null
}

/**
 * One whole stored event, for the row-detail overlay.
 *
 * The request table keeps only the columns it displays, and a source's payload
 * carries more than that — the fields differ per source, and a wide event has
 * dozens. The row is addressed by source and timestamp, the same pair paging
 * already relies on (including its assumption that one instant holds one row per
 * source), and coalesced to `null` so a row that slid out of the window answers
 * instead of failing the query.
 */
export function eventDetailSql(source: string, us: number): string {
  return `SELECT coalesce(
           (SELECT to_json(struct_pack(
                     source := source, data := to_json(data)::VARCHAR
                   ))::VARCHAR
            FROM events
            WHERE source = '${escape(source)}'
              AND timestamp = CAST(make_timestamp(${Math.round(us)}) AS TIMESTAMPTZ)
            LIMIT 1),
           'null'
         )`
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

/** `timestamp > cursor`: the direction the table's paging never needs, but the
 *  row-detail overlay's upward walk does. */
function newerThan(cursorUs: number): string {
  return `timestamp > CAST(make_timestamp(${Math.round(cursorUs)}) AS TIMESTAMPTZ)`
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
  /** See `eventPageSql`: rows strictly newer than this, oldest first. */
  newerThanUs?: number
}): string {
  const { source, from, to } = options
  const limit = Math.max(1, Math.floor(options.limit))
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const descending = options.newerThanUs === undefined
  const bound = descending
    ? options.cursorUs === undefined
      ? ''
      : `\n    AND ${upTo(options.cursorUs)}`
    : `\n    AND ${newerThan(options.newerThanUs!)}`
  const order = descending ? 'DESC' : 'ASC'
  // `data.errors` is a Variant array of `{ event, error }`; its text form is the
  // only useful rendering for a table cell, and null on requests without one.
  return `SELECT coalesce(to_json(array_agg(struct_pack(
           us := us, method := method, uri := uri, status := status,
           latency := latency, referrer := referrer, agent := agent, error := error
         ) ORDER BY us ${order})), '[]'::JSON)::VARCHAR
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
  WHERE ${requestWindow(source, from, to)}${bound}
  ORDER BY timestamp ${order}
  LIMIT ${limit} OFFSET ${offset}
)`
}
