# Service

The service is the Rust binary. It serves the read API, ingests data and serves the frontend bundle.

## Read path

`POST /api/data` runs a DuckDB query against `data/*.parquet` through a small pool of read-only, in-memory
connections, each exposing an `events` view. External file access is limited to the data directory, the configuration
is frozen after setup, and every query runs under a timeout and a response size cap. See `design/003-visualization.md`
for the query model.

The view is bound afresh on every query, so files written by the ingestion path are picked up without recreating the
pool, and files removed by compaction disappear. It reads with `union_by_name=true` so a future added column cannot
silently vanish depending on file order. A zero-row `_seed.parquet` is written when the directory is empty, because
`read_parquet` cannot bind an empty glob.

The built frontend (`ui/dist`) is served by the same process; unknown paths fall back to `index.html` for the
single-page app.

The service also serves PMTiles map archives from `tiles/` (`ACTA_TILES_DIR`) at `/tiles/*`, with HTTP range support, a
strong ETag and a short cache window — currently a world archive plus two extracts derived from the location fixes.
See
`design/003-visualization.md` for how the map uses them.

## Auth

## Data ingestion

`POST /api/ingest` takes a JSON array of `{ source, timestamp?, data }`. `source` names the data source, `data` is
arbitrary JSON stored as-is in the `Variant` column, and `timestamp` is the event time, as an RFC 3339 string or an
epoch number. A missing or `null` timestamp defaults to the server's receive time, so every row carries an event time.

Rows are buffered in memory and flushed to one `hot-` file every 10 s, or earlier if the buffer would exceed its row
or byte limit, and once more on shutdown. A flush is atomic: the file is written to `.staging/`, synced, and renamed
into `data/`, so it becomes visible complete and is immediately queryable — hot data does not wait for compaction.
The handler validates the batch and enqueues it; body size, batch length and backlog are all bounded, so a stalled
writer applies backpressure instead of growing memory.

### Layout

All files live flat in `data/` and share the schema `timestamp TIMESTAMPTZ, source VARCHAR, data VARIANT`. The
filename encodes the arrival bucket:

- `hot-<flush_ms>.parquet` — one per flush (10 s by default)
- `hour-<hour_start_s>.parquet`
- `day-<YYYY-MM-DD>.parquet`
- `month-<YYYY-MM>.parquet`
- `_seed.parquet` — zero-row schema anchor, written when the directory would otherwise be empty and then left in place

Buckets are cut from arrival time, never from the `timestamp` column, so a closed bucket can never receive another
row. A point whose event time falls in an already-compacted bucket simply lands in the current one; queries union all
files and filter on `timestamp`, so it is returned correctly and the next tier compaction folds it in.

`data/.staging/` holds files mid-swap and `data/.trash/` holds superseded files. The read glob `data/*.parquet`
matches neither, so only complete, current files are visible.

### Compaction

A background pass runs every minute and folds closed arrival buckets into the next tier: the `hot-` files of a
finished hour into one `hour-` file, an hour's worth of `hour-` files of a finished day into one `day-` file, and
likewise days into `month-` files. Each output is rewritten `ORDER BY source, timestamp`. Only fully closed buckets
are touched, so a bucket is written once and never reopened.

Compaction replaces files rather than adding them. The merged file is built in `.staging/`, renamed into `data/`, and
only then are its inputs moved to `.trash/`. Queries hold a shared lock and the swap an exclusive one, so no query
observes a bucket twice or not at all. If the process stops between the rename and the move, the next pass finds both
the tier file and its inputs and discards the inputs.

`.trash/` is swept on its own slower cadence (ten minutes by default) rather than every compaction pass, since files
are only removed once they age past the retention window.

## Data Lifecycle / retention

Nothing is expired. The tiers exist to bound the number of files a query opens, not to delete data. `.trash/` only
ever holds superseded files; it is swept periodically and anything younger than the retention window is left alone.

## Backup

TODO. A backup must snapshot the whole `data/` tree including `.staging/` and `.trash/`, or take the same lock the
compaction swap takes, so a snapshot coincides with neither half of a swap.

## Testing

`mise run test` runs the hurl scenarios against a running service's read API (see `design/003-visualization.md`).
`mise run test:ingest` (`tools/simulate_ingest.py`) keeps posting realistic data for every source until interrupted,
which exercises the whole write path including tier compaction. It targets `ACTA_URL` (default the dev server on
`127.0.0.1:8080`); `--fast` compresses the cadence and `--duration` bounds the run. To watch a clean dataset, point
a service at a scratch `ACTA_DATA_DIR` or move `data/data.parquet` aside — the migration regenerates it from
`traces.parquet`.
