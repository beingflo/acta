"""Migration: humidity-laundry-room -> migration/out/humidity-laundry-room.parquet

Same shape as the co2 source in co2-sensor-living-room.py: a `data` span carries one reading in
SpanAttributes['payload'], and timestamp is the reading time, not the ingest time.
`events-dev-test` is the 2024-11..2025-07 backfill.

Usage: python migration/humidity-laundry-room.py
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

src = "humidity-laundry-room"
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
