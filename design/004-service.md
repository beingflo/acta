# Service

The service is the Rust binary. It serves the read API, ingests data and serves the frontend bundle.

## Read path

`POST /api/data` runs a DuckDB query against `data/*.parquet` through a small pool of read-only, in-memory
connections, each exposing an `events` view. External file access is limited to the data directory, the configuration
is frozen after setup, and every query runs under a timeout and a response size cap. See `design/003-visualization.md`
for the query model.

The view is bound afresh on every query, so files written by the ingestion path are picked up without recreating the
pool, and files removed by compaction disappear. The schema is fixed (`timestamp, source, data`), so the read does not
union by name: that costs roughly twice as much per file and buys nothing here. A zero-row `_seed.parquet` is written
when the directory is empty, because `read_parquet` cannot bind an empty glob.

The built frontend (`ui/dist`) is served by the same process; unknown paths fall back to `index.html` for the
single-page app.

The service also serves PMTiles map archives from `tiles/` (`ACTA_TILES_DIR`) at `/tiles/*`, with HTTP range support, a
strong ETag and a short cache window — currently a world archive plus two extracts derived from the location fixes.
See
`design/003-visualization.md` for how the map uses them.

## Auth

Two HTTP basic credentials are configured through podman secrets. The UI credential guards the dashboard, the read
API and the tile archives; the sensor credential may only `POST /api/ingest`, so a sensor password can be rotated
without touching the dashboard. `/health` stays public for the deploy script and any external probe. An
unauthenticated request gets `401` with `WWW-Authenticate`, so a browser prompts once and then attaches the header to
the same-origin `/api/data` and `/tiles/*` requests. With no UI credential configured, authentication is off, which is
what the local dev server relies on. Passwords are compared in constant time and never logged.

## Health

`GET /health` returns `200` only when the newest `co2-sensor-living-room` row is at most ten minutes old, and `503`
otherwise (no reading in the window, or the query failed). The co2 sensor reports every ~20 s, so ten minutes is
generous; a service that is running but has stopped receiving data reports unhealthy. The check queries the read
path with an explicit ten-minute window, so file and row-group statistics prune the archive and only the live end
is touched.

## Data ingestion

`POST /api/ingest` takes a JSON array of `{ source, timestamp?, data }`. `source` names the data source, `data` is
arbitrary JSON stored as-is in the `Variant` column, and `timestamp` is the event time, as an RFC 3339 string or an
epoch number. A missing or `null` timestamp defaults to the server's receive time, so every row carries an event time.

Rows are buffered in memory and flushed to one `hot-` file every 10 s, or earlier if the buffer would exceed its row
or byte limit, and once more on shutdown. Buffering and writing are separate tasks joined by a small queue, so a flush
in progress never holds up accepting the next batch; only a writer that cannot keep up applies backpressure. A flush
is atomic: the file is written to `.staging/`, synced, and renamed into `data/`, so it becomes visible complete and is
immediately queryable — hot data does not wait for compaction. The handler validates the batch and enqueues it; body
size, batch length and backlog are all bounded, so a stalled writer applies backpressure instead of growing memory.

### Layout

All files live flat in `data/` and share the schema `timestamp TIMESTAMPTZ, source VARCHAR, data VARIANT`. The
filename encodes the arrival bucket:

- `hot-<flush_ms>.parquet` — one per flush (10 s by default)
- `recent-<recent_start_s>.parquet` — one per five-minute bucket
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
finished five-minute bucket into one `recent-` file, a finished hour's `recent-` files into one `hour-` file, an
hour's worth of `hour-` files of a finished day into one `day-` file, and likewise days into `month-` files. Each
output is rewritten `ORDER BY source, timestamp`. Only fully closed buckets are touched, so a bucket is written once
and never reopened. The five-minute tier is what keeps the hot tail bounded: without it a whole hour of 10 s files
would be live at once, and every query pays a footer read for each one.

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

Once at startup and daily at `ACTA_BACKUP_HOUR_UTC` (03:00 UTC by default), the service uploads every completed tier
file (the `day-` and `month-` files) plus any archive file at the top level, such as the migration's `data.parquet`.
Hot, recent and hour files are skipped: they are superseded within the day and would only add short-lived objects.
Nothing is ever deleted, and a name is uploaded once, so no bug can destroy the backup. Only completed tiers are
uploaded, so at most the current day is at risk, and a missed pass is caught up by the next one (the scan uploads
whatever eligible files are present). Day files of a month that has already folded into a `month-` file may never
have been uploaded if the service was down for the whole month; the month file covers those rows.

The bucket holds the file names verbatim under an optional `ACTA_S3_PREFIX`. Restore (`acta restore`, run as a
one-shot container with the data volume mounted, see `mise run deploy:restore`) downloads every object. A restore
can contain both a finer tier and the coarser file that superseded it; the first compaction pass after startup
reconciles them with the existing "target exists, so trash the inputs" rule, so duplicates are harmless.

Credentials come from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (podman secrets); bucket, region, endpoint and
prefix from the environment. Uploads run in their own task and never block ingestion or compaction; a failed pass
only logs a warning and is retried on the next one.

## Deployment

The service runs from a container on the server (Podman with Quadlet) and is fronted by Caddy at
`acta.marending.dev`. `mise run deploy` builds the image locally, so the expensive bundled-DuckDB compile stays
cached, ships it over ssh and restarts the unit. `mise run deploy:build` does the build alone, without shipping or
restarting. `Containerfile`, `.containerignore` and `acta.container` hold the details. The first bundled-DuckDB
compile wants roughly 8 CPUs and 12 GiB in the podman machine; afterwards the cargo target and npm caches reduce an
ordinary change to a few seconds.

State lives in three places, none of which a deploy touches:

- `acta-data` (named volume) at `/data` — the Parquet tree, owned by podman and never a bind mount.
- `~/acta/tiles` — the PMTiles archives, mounted read-only. Regenerated on the host and copied with
  `mise run deploy:tiles`; the container never writes there.
- `~/.config/acta/acta.env` — non-secret configuration (memory limit, backup schedule, S3 endpoint, usernames), plus
  the podman secrets `acta-auth-ui-password`, `acta-auth-sensor-password`, `acta-aws-key-id` and `acta-aws-secret`,
  installed with `mise run deploy:secrets`.

`mise run deploy:seed <dir>` imports a fresh dataset into an empty volume and `mise run deploy:restore` recovers one
from S3. Only one container may use the data volume at a time: the service assumes it owns the tree, including
`.staging/` and `.trash/`.

## Testing

`mise run test` runs the hurl scenarios against a running service's read API (see `design/003-visualization.md`).
`mise run test:ingest` (`tools/simulate_ingest.py`) keeps posting realistic data for every source until interrupted,
which exercises the whole write path including tier compaction. It targets `ACTA_URL` (default the dev server on
`127.0.0.1:8080`); set `ACTA_AUTH=user:pass` when the target has authentication enabled. `--fast` compresses the
cadence and `--duration` bounds the run. `--load` switches to load-test
mode: it ramps concurrent connections until throughput plateaus or errors rise, then holds, reporting requests/s,
rows/s and latency percentiles. To test with a clean dataset, point a service at a scratch `ACTA_DATA_DIR` or move
`data/data.parquet` aside — the migration regenerates it from `traces.parquet`.
