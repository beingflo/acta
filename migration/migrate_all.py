"""Run every per-source migration, then combine the results into `data/data.parquet`.

Each <source>.py writes migration/out/<source>.parquet. This script runs them all
and then writes one combined file, sorted by source and then timestamp. The
`SOURCES` list is the single source of truth: only those outputs are combined, so
dropping a source here also drops its rows from the dataset.

Sorting by source first is what makes the read path fast:

  * Row-group statistics on `source` let a `source = ...` filter skip every other
    source's row groups. A file interleaved by timestamp has no such pruning, so
    every query scans (and Variant-decodes) every source's rows.
  * Keeping a source's rows contiguous keeps the Variant layout homogeneous
    within a row group, which Parquet can shred. Grouping by source also
    compresses better: the combined file is ~65 MB versus ~99 MB sorted by time.

Timestamps stay ordered within each source, so a `timestamp` range still prunes
row groups inside a source's block.

Usage: python migration/migrate_all.py
"""

import pathlib
import subprocess
import sys
import duckdb

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "out"
DATA = HERE.parent / "data"
FINAL = DATA / "data.parquet"
ROW_GROUP_SIZE = 250_000

SOURCES = [
    "co2-sensor-living-room.py",
    "humidity-laundry-room.py",
    "brightness-barometer-living-room.py",
    "location_florian.py",
    "marending.py",
]

# Combine exactly the outputs of those scripts. Globbing `out/*.parquet` would
# also pick up the leftovers of a source that was dropped here, silently keeping
# its rows in the dataset.
OUTPUTS = [OUT / f"{pathlib.Path(name).stem}.parquet" for name in SOURCES]
SOURCES_SQL = "[" + ", ".join(f"'{path}'" for path in OUTPUTS) + "]"

for name in SOURCES:
    print(f"=== {name} ===", flush=True)
    subprocess.run([sys.executable, str(HERE / name)], check=True)

DATA.mkdir(exist_ok=True)

con = duckdb.connect()
con.execute("SET threads=8")
con.execute("SET memory_limit='8GB'")
# must stay on (it is the default) so the ORDER BY below survives into the file
con.execute("SET preserve_insertion_order=true")

con.execute(f"""
    COPY (
        SELECT timestamp, source, data
        FROM read_parquet({SOURCES_SQL})
        ORDER BY source, timestamp
    ) TO '{FINAL}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE {ROW_GROUP_SIZE})
""")

# --- verification -----------------------------------------------------------
expected = con.sql(f"SELECT count(*) FROM read_parquet({SOURCES_SQL})").fetchone()[0]
rows, first, last = con.sql(
    f"SELECT count(*), min(timestamp), max(timestamp) FROM '{FINAL}'"
).fetchone()
assert rows == expected, f"wrote {rows} rows, expected {expected}"

# timestamps are ordered within every source
out_of_order = con.sql(f"""
    SELECT count(*) FROM (
        SELECT timestamp, lag(timestamp) OVER (PARTITION BY source ORDER BY file_row_number) AS prev
        FROM read_parquet('{FINAL}', file_row_number=true)
    ) WHERE prev IS NOT NULL AND timestamp < prev
""").fetchone()[0]
assert out_of_order == 0, f"{out_of_order} rows are out of order within a source"

# row groups hold a single source, so `source = ...` prunes them. A few boundary
# row groups may straddle two sources; that is negligible.
mixed, total_rgs = con.sql(f"""
    SELECT count(*) FILTER (WHERE stats_min <> stats_max), count(*)
    FROM parquet_metadata('{FINAL}')
    WHERE path_in_schema = 'source'
""").fetchone()

print(f"\n{FINAL.name}: {rows:,} rows, {first:%Y-%m-%d} .. {last:%Y-%m-%d}, "
      f"{FINAL.stat().st_size / 1e6:.0f} MB, {total_rgs} row groups ({mixed} mixed-source)")
print("rows per source:")
for r in con.sql(f"SELECT source, count(*) n FROM '{FINAL}' GROUP BY 1 ORDER BY 1").fetchall():
    print(f"   {r[0]:34} {r[1]:>10,}")
