"""One-time migration: old ClickHouse otel_traces -> acta per-source Parquet files.

Reads  traces.parquet (repo root). Never modified.
Writes migration/out/<source>.parquet with the acta schema:
    timestamp TIMESTAMPTZ, source VARCHAR, data VARIANT

Requires duckdb >= 1.5 (VARIANT type).

Usage: python migration/migrate.py
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
# bucket. timestamp is the sensor's own time (SpanAttributes['timestamp']),
# which is what the device recorded, not when the server received the span.

src = "co2-sensor-living-room"
where = f"""
    ServiceName = 'events'
    AND SpanName = 'data'
    AND SpanAttributes['bucket'] = '{src}'
"""

source_rows = con.sql(f"SELECT count(*) FROM '{TRACES}' WHERE {where}").fetchone()[0]
assert source_rows == 1_129_470, f"unexpected input rows: {source_rows}"

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
