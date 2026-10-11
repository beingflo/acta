"""One-time migration: old ClickHouse otel_traces -> acta per-source Parquet files.

Reads  traces.parquet (repo root). Never modified.
Writes migration/out/<source>.parquet with the acta schema:
    timestamp TIMESTAMPTZ, source VARCHAR, data VARIANT

Requires duckdb >= 1.5 (VARIANT type).

Usage: python migration/co2-sensor-living-room.py
"""

import pathlib
import duckdb

HERE = pathlib.Path(__file__).resolve().parent
TRACES = HERE.parent / "traces.parquet"
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)

con = duckdb.connect()
con.execute("SET threads=8")
con.execute("SET memory_limit='8GB'")
con.execute("SET preserve_insertion_order=false")


# --- co2-sensor-living-room -------------------------------------------------
# A `data` span carries one reading in SpanAttributes['payload'], keyed by
# bucket. The span Timestamp is when the server received the span; the reading
# is timed by SpanAttributes['timestamp'], so that is what we store.
#
# `events` is the live service. `events-dev-test` is a backfill: on 2025-07-30
# it replayed readings from 2024-11-09 to 2025-07-20 in one burst, so its ingest
# time is meaningless and only the reading time is useful. It is included on
# purpose. `events-dev` (a 60 ms burst of GPS spans) and `reflective` are not.

src = "co2-sensor-living-room"
where = f"""
    ServiceName IN ('events', 'events-dev-test')
    AND SpanName = 'data'
    AND SpanAttributes['bucket'] = '{src}'
"""

source_rows = con.sql(f"SELECT count(*) FROM '{TRACES}' WHERE {where}").fetchone()[0]

out_file = OUT / f"{src}.parquet"

con.execute(f"""
    COPY (
        SELECT
            CAST(SpanAttributes['timestamp'] AS TIMESTAMPTZ) AS timestamp,
            '{src}' AS source,
            CAST(CAST(SpanAttributes['payload'] AS JSON) AS VARIANT) AS data
        FROM '{TRACES}'
        WHERE {where}
    ) TO '{out_file}' (FORMAT PARQUET, COMPRESSION ZSTD)
""")

rows, first, last, non_null_data = con.sql(
    f"SELECT count(*), min(timestamp), max(timestamp), count(data) FROM '{out_file}'"
).fetchone()
assert rows == source_rows, f"wrote {rows} rows, expected {source_rows}"
assert non_null_data == source_rows, f"{rows - non_null_data} null data values"

print(f"{src}: {rows} rows, {first} .. {last}")
print(f"  -> {out_file}")
