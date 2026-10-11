"""Migration: marending -> migration/out/marending.parquet

`marending` emits only `http-request` spans. Each span carries a `request` event
and (usually) a `response_status` event, and a few carry `Failed to read file` /
`error` events; we merge them into one data object:

    { method, uri, user_agent, referrer, status, latency_ns, errors? }

`errors` is only present on spans that had an error event. There is no reading
timestamp for HTTP, so `timestamp` is the span's ingest Timestamp. Traces here
are single-span, but 725 spans were exported more than once, so we dedup on
SpanId. See co2-sensor-living-room.py for the other sources.

Usage: python migration/marending.py
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

src = "marending"
where = "ServiceName = 'marending' AND SpanName = 'http-request'"

source_rows = con.sql(
    f"SELECT count(DISTINCT SpanId) FROM '{TRACES}' WHERE {where}"
).fetchone()[0]
source_error_spans = con.sql(f"""
    SELECT count(DISTINCT SpanId) FROM '{TRACES}'
    WHERE {where}
      AND (list_contains("Events.Name", 'error')
           OR list_contains("Events.Name", 'Failed to read file'))
""").fetchone()[0]

out_file = OUT / f"{src}.parquet"

con.execute(f"""
    COPY (
        WITH spans AS (
            SELECT
                Timestamp,
                SpanId,
                "Events.Name"       AS ev_names,
                "Events.Attributes" AS ev_attrs,
                list_position("Events.Name", 'request')         AS i_req,
                list_position("Events.Name", 'response_status') AS i_res,
                list_filter(range(1, len("Events.Name") + 1),
                            i -> "Events.Name"[i] IN ('error', 'Failed to read file')) AS i_err
            FROM '{TRACES}'
            WHERE {where}
        ),
        one AS (
            SELECT DISTINCT ON (SpanId) * FROM spans ORDER BY SpanId
        )
        SELECT
            Timestamp AS timestamp,
            '{src}'   AS source,
            CAST(
                CASE WHEN len(i_err) = 0
                    THEN json_object(
                            'method',     ev_attrs[i_req]['request'],
                            'uri',        ev_attrs[i_req]['uri'],
                            'user_agent', ev_attrs[i_req]['user_agent'],
                            'referrer',   ev_attrs[i_req]['referrer'],
                            'status',     TRY_CAST(ev_attrs[i_res]['status'] AS INT),
                            'latency_ns', TRY_CAST(ev_attrs[i_res]['latency'] AS BIGINT))
                    ELSE json_object(
                            'method',     ev_attrs[i_req]['request'],
                            'uri',        ev_attrs[i_req]['uri'],
                            'user_agent', ev_attrs[i_req]['user_agent'],
                            'referrer',   ev_attrs[i_req]['referrer'],
                            'status',     TRY_CAST(ev_attrs[i_res]['status'] AS INT),
                            'latency_ns', TRY_CAST(ev_attrs[i_res]['latency'] AS BIGINT),
                            'errors',     to_json(list_transform(i_err,
                                              i -> struct_pack(event := ev_names[i],
                                                               error := ev_attrs[i]['error']))))
                END AS VARIANT) AS data
        FROM one
    ) TO '{out_file}' (FORMAT PARQUET, COMPRESSION ZSTD)
""")

rows, first, last, non_null_data, non_null_ts = con.sql(
    f"SELECT count(*), min(timestamp), max(timestamp), count(data), count(timestamp) FROM '{out_file}'"
).fetchone()
assert rows == source_rows, f"wrote {rows} rows, expected {source_rows} distinct spans"
assert non_null_data == source_rows, f"{rows - non_null_data} null data values"
assert non_null_ts == source_rows, f"{rows - non_null_ts} null timestamps"

# method/uri always present as scalars, and nested errors stay structured
bad = con.sql(f"""
    SELECT count(*) FROM '{out_file}'
    WHERE variant_typeof(data) NOT LIKE 'OBJECT%'
       OR variant_typeof(data.uri) <> 'VARCHAR'
       OR variant_typeof(data.method) <> 'VARCHAR'
""").fetchone()[0]
assert bad == 0, f"{bad} rows have an unexpected data shape"

with_errors = con.sql(
    f"SELECT count(*) FROM '{out_file}' WHERE variant_typeof(data.errors) LIKE 'ARRAY%'"
).fetchone()[0]
assert with_errors == source_error_spans, f"{with_errors} rows with errors, expected {source_error_spans}"

print(f"{src}: {rows} rows, {first} .. {last}  ({with_errors} with errors)")
print(f"  -> {out_file}")
