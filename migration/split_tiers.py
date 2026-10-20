"""Split the migrated archive into the tier files the live write path produces.

`migrate_all.py` combines the per-source migrations into one `data/data.parquet`.
This script re-splits that archive as if the service had ingested the data as it
arrived, using the event time as the arrival time:

    month-YYYY-MM      every fully closed month
    day-YYYY-MM-DD     closed days of the open month
    hour-<epoch_s>     closed hours of the open day
    recent-<epoch_s>   closed five-minute buckets of the open hour
    hot-<flush_ms>     what is left in the open five-minute bucket

Which buckets are "open" is decided by a reference instant (`--now`), defaulting
to the newest row in the archive so the output is deterministic. Bucket
boundaries are UTC.

Only fully closed buckets may become a coarser file. Compaction treats an
existing coarser target as authoritative and trashes the finer files in that
span, so a partial `month-` or `day-` would make the next pass discard rows
ingested later for the same period. Rows in the open month therefore stay in
day files, the open day in hour files, and so on.

The files match `service/src/parquet.rs` exactly: the acta schema, ZSTD
compression, 250k-row row groups, and rows sorted by source then timestamp.
Sorting by source first is what makes reads fast: row-group statistics on
`source` let a `source = ...` filter skip every other source's row groups, and
keeping a source's rows contiguous keeps the Variant layout homogeneous within
a row group so Parquet can shred it. See `design/002-migration.md`.

The archive is removed when it lives in the data directory, because the read
glob `data/*.parquet` would otherwise return every row twice. Outside the data
directory it is left alone.

Usage: python migration/split_tiers.py [--input data/data.parquet] [--now <RFC3339>] [--force]
       mise run migrate:split -- [--input data/data.parquet] [--now <RFC3339>] [--force]
"""

import argparse
import datetime as dt
import os
import pathlib
import re

import duckdb

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parent / "data"
STAGING = DATA / ".staging"
ROW_GROUP_SIZE = 250_000

SECOND_US = 1_000_000
RECENT_US = 300 * SECOND_US
HOUR_US = 3_600 * SECOND_US
DAY_US = 86_400 * SECOND_US

SCHEMA = [
    ("timestamp", "TIMESTAMP WITH TIME ZONE"),
    ("source", "VARCHAR"),
    ("data", "VARIANT"),
]

# The names compaction understands. Anything else at the top level (`_seed.parquet`,
# a hand-placed archive) is never touched.
TIER_FILE = re.compile(
    r"^(?:month-\d{4}-\d{2}|day-\d{4}-\d{2}-\d{2}|hour-\d+|recent-\d+|hot-\d+(?:-\d+)?)\.parquet$"
)


# --- bucket helpers ---------------------------------------------------------


def epoch_us(ts: dt.datetime) -> int:
    delta = ts - dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
    return (delta.days * 86_400 + delta.seconds) * SECOND_US + delta.microseconds


def from_epoch_us(us: int) -> dt.datetime:
    return dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(microseconds=us)


def month_start(ts: dt.datetime) -> dt.datetime:
    return ts.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def next_month(ts: dt.datetime) -> dt.datetime:
    if ts.month == 12:
        return ts.replace(year=ts.year + 1, month=1)
    return ts.replace(month=ts.month + 1)


def file_name(tier: str, bucket_us: int, last_us: int) -> str:
    if tier == "month":
        return f"month-{from_epoch_us(bucket_us):%Y-%m}.parquet"
    if tier == "day":
        return f"day-{from_epoch_us(bucket_us):%Y-%m-%d}.parquet"
    if tier == "hour":
        return f"hour-{bucket_us // SECOND_US}.parquet"
    if tier == "recent":
        return f"recent-{bucket_us // SECOND_US}.parquet"
    assert tier == "hot"
    # The flush time names the file; any instant inside the still-open bucket works.
    return f"hot-{last_us // 1000}.parquet"


def bucket_span(tier: str, bucket_us: int) -> tuple[int, int] | None:
    """[start, end) of a closed bucket, or None for the still-open `hot` tail."""
    if tier == "month":
        start = month_start(from_epoch_us(bucket_us))
        return epoch_us(start), epoch_us(next_month(start))
    if tier == "day":
        return bucket_us, bucket_us + DAY_US
    if tier == "hour":
        return bucket_us, bucket_us + HOUR_US
    if tier == "recent":
        return bucket_us, bucket_us + RECENT_US
    return None


def sql_path(path: pathlib.Path) -> str:
    return "'" + str(path).replace("'", "''") + "'"


# --- main -------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Split the migrated archive into the live tier files in data/."
    )
    parser.add_argument(
        "--input",
        type=pathlib.Path,
        default=DATA / "data.parquet",
        help="combined archive written by migrate_all.py (default: data/data.parquet)",
    )
    parser.add_argument(
        "--now",
        metavar="RFC3339",
        help="reference instant that decides which buckets are closed "
        "(default: the newest row in the archive)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace tier files left in data/ by an earlier split",
    )
    args = parser.parse_args()

    source = args.input.resolve()
    if not source.is_file():
        parser.error(f"no such archive: {source}")
    if source.parent == DATA.resolve() and TIER_FILE.match(source.name):
        parser.error(f"{source.name} is a tier file, not an archive; nothing to split")

    con = duckdb.connect()
    con.execute("SET threads=8")
    con.execute("SET memory_limit='8GB'")
    # Buckets are UTC, like the service's.
    con.execute("SET TimeZone='UTC'")
    # must stay on (it is the default) so the ORDER BY below survives into the file
    con.execute("SET preserve_insertion_order=true")

    schema = [(row[0], row[1]) for row in con.sql(f"DESCRIBE SELECT * FROM {sql_path(source)}").fetchall()]
    assert schema == SCHEMA, f"unexpected schema in {source}: {schema}"

    total, newest_us, null_ts = con.sql(
        f"SELECT count(*), max(epoch_us(timestamp)), count(*) FILTER (WHERE timestamp IS NULL) "
        f"FROM {sql_path(source)}"
    ).fetchone()
    assert total > 0, f"no rows in {source}"
    assert null_ts == 0, f"{null_ts} rows have a NULL timestamp"

    if args.now:
        try:
            now = dt.datetime.fromisoformat(args.now)
        except ValueError:
            parser.error(f"not an RFC 3339 instant: {args.now}")
        if now.tzinfo is None:
            parser.error("--now must carry a UTC offset, e.g. 2026-10-11T16:20:00Z")
        now = now.astimezone(dt.timezone.utc)
    else:
        # One microsecond after the last reading: the instant the archive stops
        # being the open end. A wall-clock default would make the output depend
        # on when the migration runs.
        now = from_epoch_us(newest_us + 1)
    print(f"reference instant: {now:%Y-%m-%d %H:%M:%S} UTC")

    DATA.mkdir(exist_ok=True)
    STAGING.mkdir(exist_ok=True)

    previous = sorted(
        path.name for path in DATA.iterdir() if path.is_file() and TIER_FILE.match(path.name)
    )
    if previous and not args.force:
        parser.error(
            f"{DATA} already holds {len(previous)} tier file(s); rerun with --force to replace them"
        )
    for name in previous:
        (DATA / name).unlink()
    if previous:
        print(f"removed {len(previous)} tier file(s) from {DATA}")
    for tmp in STAGING.glob("*.tmp"):
        tmp.unlink()

    now_us = epoch_us(now)
    open_month_us = epoch_us(month_start(now))
    open_day_us = now_us - now_us % DAY_US
    open_hour_us = now_us - now_us % HOUR_US
    open_recent_us = now_us - now_us % RECENT_US

    # Classify every row once: the tier follows from how far the row lies before
    # the open bucket, and the bucket key is what the file will be named after.
    con.execute(f"""
        CREATE TABLE events AS
        WITH classified AS (
            SELECT
                timestamp, source, data,
                epoch_us(timestamp) AS ts_us,
                CASE
                    WHEN epoch_us(timestamp) < {open_month_us}  THEN 'month'
                    WHEN epoch_us(timestamp) < {open_day_us}    THEN 'day'
                    WHEN epoch_us(timestamp) < {open_hour_us}   THEN 'hour'
                    WHEN epoch_us(timestamp) < {open_recent_us} THEN 'recent'
                    ELSE 'hot'
                END AS tier
            FROM {sql_path(source)}
        )
        SELECT
            timestamp, source, data, ts_us, tier,
            CASE tier
                WHEN 'month' THEN epoch_us(date_trunc('month', timestamp))
                WHEN 'day'   THEN epoch_us(date_trunc('day', timestamp))
                WHEN 'hour'  THEN ts_us - ts_us % {HOUR_US}
                ELSE              ts_us - ts_us % {RECENT_US}
            END AS bucket_us
        FROM classified
    """)

    buckets = con.sql("""
        SELECT tier, bucket_us, count(*) AS n, min(ts_us), max(ts_us)
        FROM events GROUP BY 1, 2 ORDER BY min(ts_us)
    """).fetchall()

    expected_rows: dict[str, int] = {}
    sizes: dict[str, int] = {}
    tier_files: dict[str, int] = {}
    tier_rows: dict[str, int] = {}
    min_us = buckets[0][3]
    max_us = buckets[0][4]
    for tier, bucket_us, count, first_us, last_us in buckets:
        name = file_name(tier, bucket_us, last_us)
        min_us = min(min_us, first_us)
        max_us = max(max_us, last_us)
        span = bucket_span(tier, bucket_us)
        if span is None:
            # The hot bucket is still open; its rows must at least sit inside it.
            assert bucket_us <= first_us <= last_us < bucket_us + RECENT_US, (
                f"{name}: rows outside bucket"
            )
        else:
            start, end = span
            assert start <= first_us <= last_us < end, f"{name}: rows outside bucket span"

        tmp = STAGING / f"{name}.tmp"
        con.execute(f"""
            COPY (
                SELECT timestamp, source, data FROM events
                WHERE tier = '{tier}' AND bucket_us = {bucket_us}
                ORDER BY source, timestamp
            ) TO {sql_path(tmp)}
            (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE {ROW_GROUP_SIZE})
        """)
        # sync, then rename, so data/ only ever holds complete files
        with open(tmp, "rb") as f:
            os.fsync(f.fileno())
        os.replace(tmp, DATA / name)

        expected_rows[name] = count
        sizes[name] = (DATA / name).stat().st_size
        tier_files[tier] = tier_files.get(tier, 0) + 1
        tier_rows[tier] = tier_rows.get(tier, 0) + count
        print(f"  {name:24} {count:>9,} rows")

    assert sum(expected_rows.values()) == total
    assert len(expected_rows) == len(buckets), "duplicate bucket names"

    # --- verification -------------------------------------------------------
    files = ", ".join(sql_path(DATA / name) for name in expected_rows)

    for name, count in con.sql(
        f"SELECT filename, count(*) FROM read_parquet([{files}], filename=true) GROUP BY 1"
    ).fetchall():
        name = pathlib.Path(name).name
        assert count == expected_rows[name], f"{name}: wrote {count} rows, expected {expected_rows[name]}"

    # timestamps are ordered within every source of every file
    out_of_order = con.sql(f"""
        SELECT count(*) FROM (
            SELECT timestamp,
                   lag(timestamp) OVER (PARTITION BY filename, source ORDER BY file_row_number) AS prev
            FROM read_parquet([{files}], file_row_number=true, filename=true)
        ) WHERE prev IS NOT NULL AND timestamp < prev
    """).fetchone()[0]
    assert out_of_order == 0, f"{out_of_order} rows are out of order within a source"

    # row groups hold a single source, so `source = ...` prunes them. A few
    # boundary row groups may straddle two sources; that is negligible.
    mixed, total_rgs = con.sql(f"""
        SELECT count(*) FILTER (WHERE stats_min <> stats_max), count(*)
        FROM parquet_metadata([{files}])
        WHERE path_in_schema = 'source'
    """).fetchone()

    print(
        f"\n{len(expected_rows)} files, {total:,} rows, "
        f"{from_epoch_us(min_us):%Y-%m-%d} .. {from_epoch_us(max_us):%Y-%m-%d}, "
        f"{sum(sizes.values()) / 1e6:.0f} MB, {total_rgs} row groups ({mixed} mixed-source)"
    )
    for tier in ("month", "day", "hour", "recent", "hot"):
        if tier in tier_files:
            print(f"   {tier:8} {tier_files[tier]:>3} files {tier_rows[tier]:>10,} rows")

    if source.parent == DATA.resolve():
        source.unlink()
        print(f"\nremoved {source.name}: the tiers replace it, and data/*.parquet would count it twice")
    else:
        print(f"\nleft {source.name} in place: it is outside the data directory")


if __name__ == "__main__":
    main()
