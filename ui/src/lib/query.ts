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

/** Scalars for the eos stats strip. Gauges come both as the window's average
 *  and as its peak; the rest are the newest sample's reading, for the figures
 *  that are state rather than traffic (disk, battery, containers). */
export type EosOverview = {
  /** Samples in the window: the collector runs every ten seconds. */
  samples: number
  /** Newest sample anywhere, in epoch seconds; null on an empty dataset. */
  newest: number | null
  uptime_s: number | null
  cores: number | null
  cpu_avg: number | null
  cpu_peak: number | null
  load1: number | null
  mem_avg_mb: number | null
  mem_total_mb: number | null
  mem_peak_pct: number | null
  temp_avg_c: number | null
  temp_peak_c: number | null
  disk_used_pct: number | null
  disk_used_gb: number | null
  boot_used_pct: number | null
  charge_pct: number | null
  battery_status: string | null
  battery_power_w: number | null
  containers: number | null
  containers_cpu_pct: number | null
  containers_mem_mb: number | null
}

/**
 * Totals for the eos stats strip: the window's CPU, memory, board temperature
 * and the newest sample's disk, battery and container figures, plus the age of
 * the newest sample.
 *
 * The gauges are averaged *and* peaked: an average says what the box did over
 * the window, the peak says how far it went — which is the question a server
 * gets asked after the fact. Containers only ride along on every sixth sample
 * (`stats/collect.py`), so their fields are read with `arg_max` rather than
 * restricted to the last row. `newest` ignores the window, like the other
 * strips, so freshness still tells the truth when the window is stepped back.
 */
export function eosOverviewSql(source: string, from: Date, to: Date): string {
  // The last known value of a field: `arg_max` over the event time, so a field
  // that only some samples carry still resolves to its most recent reading.
  const latest = (expr: string) => `arg_max(${expr}, timestamp)`
  const avg = (path: string) => `avg(TRY_CAST(${path} AS DOUBLE))`
  const peak = (path: string) => `max(TRY_CAST(${path} AS DOUBLE))`
  const current = (path: string) => latest(`TRY_CAST(${path} AS DOUBLE)`)
  return `SELECT to_json(struct_pack(
           samples := count(*),
           newest := (SELECT epoch(CAST(max(timestamp) AS TIMESTAMP)) FROM events
                      WHERE source = '${escape(source)}'),
           uptime_s := ${latest('TRY_CAST(data.uptime_s AS BIGINT)')},
           cores := ${latest('TRY_CAST(data.cores AS BIGINT)')},
           cpu_avg := ${avg('data.cpu.usage_pct')},
           cpu_peak := ${peak('data.cpu.usage_pct')},
           load1 := ${current('data.cpu.load1')},
           mem_avg_mb := ${avg('data.memory.used_mb')},
           mem_total_mb := ${current('data.memory.total_mb')},
           mem_peak_pct := ${peak('data.memory.used_pct')},
           temp_avg_c := ${avg('data.temp.board_c')},
           temp_peak_c := ${peak('data.temp.board_c')},
           disk_used_pct := ${current('data.disk.used_pct')},
           disk_used_gb := ${current('data.disk.used_gb')},
           boot_used_pct := ${current('data.disk.boot_pct')},
           charge_pct := ${current('data.battery.charge_pct')},
           battery_status := ${latest('data.battery.status::VARCHAR')},
           battery_power_w := ${current('data.battery.power_w')},
           containers := ${latest('TRY_CAST(data.containers_total.count AS BIGINT)')},
           containers_cpu_pct := ${current('data.containers_total.cpu_pct')},
           containers_mem_mb := ${current('data.containers_total.mem_mb')}
         ))::VARCHAR
FROM events
WHERE source = '${escape(source)}'
  AND timestamp >= TIMESTAMPTZ '${from.toISOString()}'
  AND timestamp <  TIMESTAMPTZ '${to.toISOString()}'`
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

/** The office, as a box of degrees: `[min, max]` per axis. At 47° N a thousandth
 *  of a degree is ~111 m of latitude but ~76 m of longitude, so a box with equal
 *  spans on both axes is not square on the ground. */
const OFFICE = {
  lon: [8.513608, 8.515311] as [number, number],
  lat: [47.378058, 47.379233] as [number, number],
}

/** One position fix's coordinates. `TRY_CAST` because the same source also
 *  carries `trip` features, whose geometry is not a point: a plain cast would
 *  fail on them in a `FILTER`, where DuckDB is free to evaluate the condition
 *  before the `type` test. DuckDB arrays are 1-based, so longitude is `[1]`. */
const FIX_LON = 'TRY_CAST(data.geometry.coordinates[1] AS DOUBLE)'
const FIX_LAT = 'TRY_CAST(data.geometry.coordinates[2] AS DOUBLE)'
const IS_FIX = `data.geometry.type = 'Point'`

/** A fix inside the office box. */
const AT_OFFICE = `${IS_FIX}
    AND ${FIX_LON} BETWEEN ${OFFICE.lon[0]} AND ${OFFICE.lon[1]}
    AND ${FIX_LAT} BETWEEN ${OFFICE.lat[0]} AND ${OFFICE.lat[1]}`

/**
 * Every fix in the window with its state — `1` inside the office box, `0` out —
 * as epoch seconds, one point per fix and no bucketing.
 *
 * The presence chart draws a step at each of those instants, so quantising them
 * would do two kinds of damage. A bucket moves an arrival or a departure by up to
 * its own width, and — worse — an aggregate has to pick a state for a bucket that
 * holds a whole walk: the fixes of a walk-in start outside and end inside, so
 * whichever end the aggregate takes, half the burst is wrong. Since the tracker
 * reports only while moving, one point per fix is both exact and small: a year is
 * a few thousand rows.
 */
export function officeFixesSql(from: Date, to: Date): string {
  return `SELECT coalesce(to_json(array_agg(struct_pack(t := t, s0 := inside) ORDER BY t)),
           '[]'::JSON)::VARCHAR
FROM (
  SELECT epoch(CAST(timestamp AS TIMESTAMP)) AS t,
         CASE WHEN ${AT_OFFICE} THEN 1 ELSE 0 END AS inside
  FROM events
  WHERE source = 'location_florian' AND ${IS_FIX}
    AND timestamp >= TIMESTAMPTZ '${from.toISOString()}'
    AND timestamp <  TIMESTAMPTZ '${to.toISOString()}'
)`
}

/** When the office was reached, as epoch seconds, `null` if it was not. */
export type OfficeArrivals = {
  morning: number | null
  after_lunch: number | null
}

/**
 * The first fix inside the office box in each arrival window — an *arrival*
 * meaning a fix whose predecessor was outside, not merely the first fix that
 * happens to be inside.
 *
 * The difference is not academic: a wider box covers the walk to the door, so
 * "first fix inside after 11:30" is the moment someone last stood at their desk
 * before lunch rather than the moment they came back. Requiring the crossing
 * makes both cards mean what their labels say, and leaves the morning identical
 * — that one is always a crossing.
 *
 * The windows are given as instants rather than derived from the selected range:
 * these two times are a property of the day, not of what the chart below is
 * showing. The fix list starts a day before the first window so that a fix at
 * the very start of it has a predecessor; it is still only a couple of days of
 * rows, materialised once and read twice.
 */
export function officeArrivalsSql(windows: {
  morning: [Date, Date]
  after_lunch: [Date, Date]
}): string {
  const start = new Date(
    Math.min(windows.morning[0].getTime(), windows.after_lunch[0].getTime()) - 86_400_000,
  )
  const end = new Date(
    Math.max(windows.morning[1].getTime(), windows.after_lunch[1].getTime()),
  )
  const first = ([from, to]: [Date, Date]) => `(SELECT min(epoch(CAST(ts AS TIMESTAMP)))
           FROM crossings
           WHERE ts >= TIMESTAMPTZ '${from.toISOString()}'
             AND ts <  TIMESTAMPTZ '${to.toISOString()}')`
  return `WITH fixes AS (
         SELECT timestamp AS ts,
                CASE WHEN ${AT_OFFICE} THEN 1 ELSE 0 END AS inside,
                lag(CASE WHEN ${AT_OFFICE} THEN 1 ELSE 0 END) OVER (ORDER BY timestamp) AS before
         FROM events
         WHERE source = 'location_florian' AND ${IS_FIX}
           AND timestamp >= TIMESTAMPTZ '${start.toISOString()}'
           AND timestamp <  TIMESTAMPTZ '${end.toISOString()}'
       ), crossings AS (
         -- coalesce(before, 0): the first fix of the lookback counts as arriving
         -- if it is inside, which is the honest reading of "was already there".
         SELECT ts FROM fixes WHERE inside = 1 AND coalesce(before, 0) = 0
       )
       SELECT to_json(struct_pack(
         morning := ${first(windows.morning)},
         after_lunch := ${first(windows.after_lunch)}
       ))::VARCHAR`
}

/**
 * The local day the window ends in.
 *
 * The window is half-open (`[from, to)`), so the last instant inside it decides:
 * a live range ends now and means today, a range stepped back a day means
 * yesterday, and a window ending exactly at midnight belongs to the day before.
 */
export function rangeDay(to: Date): Date {
  const last = new Date(to.getTime() - 1)
  return new Date(last.getFullYear(), last.getMonth(), last.getDate())
}

/**
 * The local days a window is *about*, as the two instants bracketing each one:
 * the day it ends in and as many before it as the window is long, oldest first.
 *
 * Counting back from the end rather than walking forward from the start is what
 * makes a preset match its own name. A `1d` window runs from now to now, so it
 * touches two calendar days — but the earlier one only holds the tail of a day
 * it did not start in, which is empty by construction, and a lane showing an
 * empty row for it looks broken. `7d` therefore means the end day and the six
 * before it.
 *
 * The boundaries are built here rather than in SQL because DuckDB's bundled build
 * has no timezone database: "local midnight" is the browser's business, DST
 * included. The clip keeps a range of years from turning into a wall of rows.
 */
export function localDays(from: Date, to: Date, limit = 60): Array<[Date, Date]> {
  const end = rangeDay(to)
  const span = to.getTime() - from.getTime()
  const count = Math.min(Math.max(1, Math.round(span / 86_400_000)), Math.max(1, limit))

  const days: Array<[Date, Date]> = []
  for (let back = count - 1; back >= 0; back--) {
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - back)
    // `Date(y, m, d + 1)` walks the calendar in local time, so a DST change
    // shifts the clock rather than the day.
    days.push([start, new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)])
  }
  return days
}

/** One hour of the day lane: a day's start in epoch seconds and the state of the
 *  office at that hour, `1` inside and `0` outside. */
export type OfficeHour = { t: number; s0: number }

/**
 * The office as a state per quarter hour, for the day lane — one query over the
 * whole clipped window rather than one per column.
 *
 * The state is the one at the bucket's *last* fix, not its first. A burst of
 * fixes is a walk: it starts outside and ends where the walk ended, so the first
 * fix of a slot spent arriving says "out" while the last one says "in". Taking
 * the last also makes the carry right, since a quiet slot inherits the state the
 * one before it ended in.
 *
 * Reply rows are *sparse*: only slots with a fix in them appear, so the lane
 * carries the last known state forward across the quiet ones. Buckets are
 * UTC-aligned quarter hours, which map onto local quarter hours wherever the
 * offset is a whole number of quarters.
 */
export function officeHoursSql(days: Array<[Date, Date]>): string {
  return `SELECT coalesce(to_json(array_agg(struct_pack(t := b, s0 := st) ORDER BY b)),
           '[]'::JSON)::VARCHAR
FROM (
  SELECT epoch(time_bucket(INTERVAL '15 MINUTE', CAST(timestamp AS TIMESTAMP))) AS b,
         arg_max(CASE WHEN ${AT_OFFICE} THEN 1 ELSE 0 END,
                 CAST(timestamp AS TIMESTAMP)) AS st
  FROM events
  WHERE source = 'location_florian' AND ${IS_FIX}
    AND timestamp >= TIMESTAMPTZ '${days[0]?.[0].toISOString() ?? '1970-01-01T00:00:00.000Z'}'
    AND timestamp <  TIMESTAMPTZ '${days[days.length - 1]?.[1].toISOString() ?? '1970-01-01T00:00:00.000Z'}'
  GROUP BY 1
)`
}
