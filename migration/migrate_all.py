"""Run every per-source migration, then combine the results into one Parquet file.

Each <source>.py writes migration/out/<source>.parquet. This script runs them all
and then writes migration/data.parquet containing every row, sorted by timestamp.

Sorting matters: the per-source files are written unordered, so their Parquet row
groups span the whole date range and can't be pruned. The combined file is written
sorted and with preserve_insertion_order on, so each row group covers a contiguous
slice of time and range scans on `timestamp` can skip row groups.

Usage: python migration/migrate_all.py
"""

import pathlib
import subprocess
import sys
import duckdb

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "out"
FINAL = HERE / "data.parquet"
ROW_GROUP_SIZE = 250_000

SOURCES = [
    "co2-sensor-living-room.py",
    "humidity-laundry-room.py",
    "brightness-barometer-living-room.py",
    "heuried-visitors.py",
    "location_florian.py",
    "marending.py",
]

for name in SOURCES:
    print(f"=== {name} ===", flush=True)
    subprocess.run([sys.executable, str(HERE / name)], check=True)

con = duckdb.connect()
con.execute("SET threads=8")
con.execute("SET memory_limit='8GB'")
# must stay on (it is the default) so the ORDER BY below survives into the file
con.execute("SET preserve_insertion_order=true")

con.execute(f"""
    COPY (
        SELECT timestamp, source, data
        FROM read_parquet('{OUT}/*.parquet')
        ORDER BY timestamp
    ) TO '{FINAL}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE {ROW_GROUP_SIZE})
""")

# --- verification -----------------------------------------------------------
expected = con.sql(f"SELECT count(*) FROM read_parquet('{OUT}/*.parquet')").fetchone()[0]
rows, first, last = con.sql(
    f"SELECT count(*), min(timestamp), max(timestamp) FROM '{FINAL}'"
).fetchone()
assert rows == expected, f"wrote {rows} rows, expected {expected}"

out_of_order = con.sql(f"""
    SELECT count(*) FROM (
        SELECT timestamp, lag(timestamp) OVER (ORDER BY file_row_number) AS prev
        FROM read_parquet('{FINAL}', file_row_number=true)
    ) WHERE prev IS NOT NULL AND timestamp < prev
""").fetchone()[0]
assert out_of_order == 0, f"{out_of_order} rows are out of order"

rgs = con.sql(f"""
    SELECT row_group_id, row_group_num_rows,
           CAST(stats_min AS TIMESTAMPTZ) AS lo, CAST(stats_max AS TIMESTAMPTZ) AS hi
    FROM parquet_metadata('{FINAL}')
    WHERE path_in_schema = 'timestamp'
    ORDER BY row_group_id
""").fetchall()
assert rgs, "no row groups found"
for i in range(1, len(rgs)):
    assert rgs[i][2] >= rgs[i - 1][3], f"row group {i} overlaps row group {i-1}"

print(f"\n{FINAL.name}: {rows:,} rows, {first:%Y-%m-%d} .. {last:%Y-%m-%d}, "
      f"{len(rgs)} row groups, {FINAL.stat().st_size / 1e6:.0f} MB")
print("rows per source in the combined file:")
for r in con.sql(f"SELECT source, count(*) n FROM '{FINAL}' GROUP BY 1 ORDER BY 1").fetchall():
    print(f"   {r[0]:34} {r[1]:>10,}")
print("row groups (contiguous time slices):")
for r in rgs:
    print(f"   rg {r[0]:>3}  {r[1]:>7,} rows  {r[2]:%Y-%m-%d} .. {r[3]:%Y-%m-%d}")
