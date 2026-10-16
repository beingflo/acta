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
- heuried-visitors
- location_florian
- marending

Their payload shapes:

- `co2-sensor-living-room`: `{ co2, humidity, temperature }`
- `humidity-laundry-room`: `{ humidity, temperature }`
- `brightness-barometer-living-room`: `{ absolute_pressure, lux, pressure, temperature }`
- `heuried-visitors`: a bare integer (visitor count)
- `location_florian`: a GeoJSON Feature; position fixes plus a few `"type": "trip"` summaries
- `marending`: `{ method, uri, user_agent, referrer, status, latency_ns, errors? }`

## Output layout

Partial results are written to `migration/out/<source>.parquet` and combined into a single `data/data.parquet`, sorted
by source and then timestamp, with 250k-row row groups. This file is the starting point of the dataset; the ingestion
path (`design/004-service.md`) adds further files to the same directory, and the read path unions all of them. The
source-major ordering below is a property of each file, not of the directory as a whole.

Sorting by source first is what makes reads fast. Row-group statistics on `source` let a `source = ...` filter skip
every other source's row groups, and keeping a source's rows contiguous keeps the Variant layout homogeneous within a
row group so Parquet can shred it. A file interleaved by timestamp decodes roughly 10x slower per row, because every
query scans (and Variant-decodes) every source. Grouping by source also compresses better: ~65 MB versus ~99 MB.
See `design/003-visualization.md`.
