# Data migration

Described here is a one time migration needed to bring data from an old Clickhouse-based system into acta.
The goal is to have SQL / python scripts that take a `traces.parquet` file and produce the `data/` Parquet files
with a new schema.
This functionality will not be needed in the final acta application.

## Old schema

The old system is based on ClickHouse with an OpenTelemetry collector automatically creating the schema
as follows:

```
CREATE TABLE default.otel_traces
(
        `Timestamp` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
        `TraceId` String CODEC(ZSTD(1)),
        `SpanId` String CODEC(ZSTD(1)),
        `ParentSpanId` String CODEC(ZSTD(1)),
        `TraceState` String CODEC(ZSTD(1)),
        `SpanName` LowCardinality(String) CODEC(ZSTD(1)),
        `SpanKind` LowCardinality(String) CODEC(ZSTD(1)),
        `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
        `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
        `ScopeName` String CODEC(ZSTD(1)),
        `ScopeVersion` String CODEC(ZSTD(1)),
        `SpanAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
        `Duration` Int64 CODEC(ZSTD(1)),
        `StatusCode` LowCardinality(String) CODEC(ZSTD(1)),
        `StatusMessage` String CODEC(ZSTD(1)),
        `Events.Timestamp` Array(DateTime64(9)) CODEC(ZSTD(1)),
        `Events.Name` Array(LowCardinality(String)) CODEC(ZSTD(1)),
        `Events.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
        `Links.TraceId` Array(String) CODEC(ZSTD(1)),
        `Links.SpanId` Array(String) CODEC(ZSTD(1)),
        `Links.TraceState` Array(String) CODEC(ZSTD(1)),
        `Links.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
        INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
        INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_span_attr_value mapValues(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_duration Duration TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (ServiceName, SpanName, toUnixTimestamp(Timestamp), TraceId)
TTL toDateTime(Timestamp) + toIntervalDay(3)
SETTINGS ttl_only_drop_parts = 1
```

The data in Clickhouse was extracted into the `traces.parquet file like so:

```
SELECT * FROM events.otel_traces
   INTO OUTFILE 'traces.parquet'
   FORMAT Parquet;
```

## New schema

// Time when data was recorded, either set by source or defaulting to time of receipt when not set
timestamp: timestamp

// Name of data source, may be a device, service etc.
source: string

// Payload of arbitrary data
data: Variant

## Data sources

The following data sources are represented in the dataset and need to be migrated:

- co2-sensor-living-room
- humidity-laundry-room
- brightness-barometer-living-room
- location_florian
- marending

Their payload shapes:

- `co2-sensor-living-room`: `{ co2, humidity, temperature }`
- `humidity-laundry-room`: `{ humidity, temperature }`
- `brightness-barometer-living-room`: `{ absolute_pressure, lux, pressure, temperature }`
- `location_florian`: a GeoJSON Feature; position fixes plus a few `"type": "trip"` summaries
- `marending`: `{ method, uri, user_agent, referrer, status, latency_ns, errors? }`

## Output layout

Partial results are written to `migration/out/<source>.parquet` and combined into `data/data.parquet`. They are
then re-split into the same tier files the live write path produces, using the event time as the arrival time:
`month-YYYY-MM` for closed months, `day-YYYY-MM-DD` for closed days in the open month, `hour-<epoch_s>` for closed
hours in the open day, and `recent-`/`hot-` for the tail. Bucket boundaries are UTC, and the sort and compression
match the live writer; the read path simply unions everything in `data/`. The split used the row-group size of the
writer at migration time, which only affects how much of a file's Variant payload is shredded (see
`design/001-overview.md`).

The output must obey the live invariants exactly:

- every tier covers a disjoint span, so each row lives in exactly one file;
- never emit a coarser file for a span that is not fully closed. Compaction treats an existing coarser target as
  authoritative and trashes the finer files in that span, so a partial `month-` or `day-` from the migration would
  make the next pass discard newly ingested rows for the same period.

`migration/split_tiers.py` (`mise run migrate:split`) performs the split. Its reference instant defaults to the newest row
in the archive, so the output does not depend on when the migration runs; `--now` moves the open end. Because the
archive would otherwise be returned twice by the `data/*.parquet` glob, the split removes it once the tiers are
verified. The split is an offline step: run it before the service starts.

Sorting by source first is what makes reads fast. Row-group statistics on `source` let a `source = ...` filter skip
every other source's row groups, and a file interleaved by timestamp decodes roughly 10x slower per row, because every
query scans (and Variant-decodes) every source. Grouping by source also compresses better: ~65 MB versus ~99 MB.
Shredding follows a separate rule: Parquet fixes a file's Variant schema from its first row group, so a source-ordered
file needs that group to hold every source for the whole payload to become typed columns.
See `design/003-visualization.md`.
