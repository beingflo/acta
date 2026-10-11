"""Migration: location_florian -> migration/out/location_florian.parquet

A `gps-location` span carries a GeoJSON Feature in SpanAttributes['location'].
We store the whole Feature as the VARIANT payload, so the position fixes and the
handful of `"type": "trip"` summaries coexist in one source; the reading path can
branch on data.properties.type. Nested objects/arrays stay structured (the cast
goes through JSON, which VARIANT converts recursively) -- they are not strings.

Unlike the sensor sources (which backfilled into `events-dev-test`), GPS backfilled
into `events-dev`: it replayed readings from 2024-08-29 to 2025-07-20 in a single
burst on 2025-07-30, so it is included and only the reading time matters. The
reading time is the payload's own properties.timestamp, not the span ingest time.

Usage: python migration/location_florian.py
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

src = "location_florian"
where = f"""
    ServiceName IN ('events', 'events-dev')
    AND SpanName = 'gps-location'
"""

source_rows = con.sql(f"SELECT count(*) FROM '{TRACES}' WHERE {where}").fetchone()[0]

out_file = OUT / f"{src}.parquet"

con.execute(f"""
    COPY (
        SELECT
            CAST(json_extract_string(SpanAttributes['location'], '$.properties.timestamp')
                 AS TIMESTAMPTZ) AS timestamp,
            '{src}' AS source,
            CAST(CAST(SpanAttributes['location'] AS JSON) AS VARIANT) AS data
        FROM '{TRACES}'
        WHERE {where}
    ) TO '{out_file}' (FORMAT PARQUET, COMPRESSION ZSTD)
""")

rows, first, last, non_null_data, non_null_ts = con.sql(
    f"SELECT count(*), min(timestamp), max(timestamp), count(data), count(timestamp) FROM '{out_file}'"
).fetchone()
assert rows == source_rows, f"wrote {rows} rows, expected {source_rows}"
assert non_null_data == source_rows, f"{rows - non_null_data} null data values"
assert non_null_ts == source_rows, f"{rows - non_null_ts} null timestamps"

# the nested structure really is structured, not a string
bad = con.sql(f"""
    SELECT count(*) FROM '{out_file}'
    WHERE variant_typeof(data) NOT LIKE 'OBJECT%'
       OR variant_typeof(data.geometry) NOT LIKE 'OBJECT%'
       OR variant_typeof(data.geometry.coordinates) NOT LIKE 'ARRAY%'
""").fetchone()[0]
assert bad == 0, f"{bad} rows have mis-typed nested variant data"

print(f"{src}: {rows} rows, {first} .. {last}")
print(f"  -> {out_file}")
