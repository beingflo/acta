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

### Host statistics

The server's own metrics are collected outside the container, by `stats/collect.py` — installed as a systemd user
timer by `mise run stats:install`. It reads /proc and /sys on the host, adds `podman stats` once a minute, and posts
one row per 10 s sample to `POST /api/ingest` as `eos-stats`. Its sensor credential comes from the podman secret store:
the collector reads it once per boot and caches it in the runtime directory, and a rejected credential makes it
re-read and retry, so the install path never handles the password.

Outside on purpose: inside the container `/proc/stat` is the host's but unscoped, `/proc/net/dev` is the container's
own veth, other containers are invisible and the filesystem it sees is its volume. Sampling from the host gives one
consistent view instead of a mix of scopes, keeps host access out of the service's blast radius, and lets the
collector change without rebuilding the image. The service needs no knowledge of it beyond receiving a new source.

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

Once at startup and then hourly at `ACTA_BACKUP_MINUTE` (three minutes past the hour by default), the service uploads
every closed bucket: the `hour-` file of the hour that just ended, the `day-` and `month-` files, plus any other
Parquet file at the top level. An hour file is only written once its hour has closed, and compaction builds it within
about a minute of the close, so it is the newest object each pass and the whole run stays at most one hour behind the
live data. Hot and recent files are skipped: they are superseded within the hour and would only add short-lived
objects. Nothing is ever deleted, and a name is uploaded once, so no bug can destroy the backup. A missed pass is
caught up by the next one (the scan uploads whatever eligible files are present), so a restart costs at most the
current hour. Hour files retire into day files at the end of their day, so the hourly objects accumulate as the finer
granularity of the backup; day files of a month that has already folded into a `month-` file may never have been
uploaded if the service was down for the whole month, in which case the month file covers those rows.

The bucket holds the file names verbatim under an optional `ACTA_S3_PREFIX`. Restore (`acta restore`, run as a
one-shot container with the data volume mounted, see `mise run deploy:restore`) downloads every object; it merges, so
existing files are kept and files the bucket does not carry are never removed. `mise run restore [dir]` runs the same
restore locally with the release build and the credentials from `.deploy.secrets.enc`, which is how a dev dataset is
rebuilt from the bucket; it defaults to the checkout's `data/`. A restore can contain both a finer tier and the
coarser file that superseded it; the first compaction pass after startup reconciles them with the existing "target
exists, so trash the inputs" rule, so duplicates are harmless.

Credentials come from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (podman secrets); bucket, region, endpoint and
prefix from the environment. The upload speaks the S3 protocol but is not tied to AWS: it runs against Backblaze B2,
whose endpoint names its own region (`https://s3.<region>.backblazeb2.com`), so on B2 the bucket and the endpoint are
all it takes. The scheme is required — the endpoint must be a full URL, and a bare host is a startup error rather
than something guessed at — and the region is read off the host. `ACTA_S3_REGION` is only needed for a provider that
does not encode it. The `AWS_*` variable names are simply what the S3 library reads. The resolved target is logged once at startup.
Uploads run in their own task and never block ingestion or compaction; a failed pass
only logs a warning and is retried on the next one.

## Deployment

The service runs from a container on the server (Podman with Quadlet) and is fronted by Caddy at
`acta.marending.dev`. `mise run deploy` builds the image locally, so the expensive bundled-DuckDB compile stays
cached, ships it over ssh and restarts the unit. `mise run deploy:build` does the build alone, without shipping or
restarting. `Containerfile`, `.containerignore` and `acta.container` hold the details. The first bundled-DuckDB
compile wants roughly 8 CPUs and 12 GiB in the podman machine; afterwards the cargo target and npm caches reduce an
ordinary change to a few seconds.

State lives in two places, neither of which a deploy touches:

- `acta-data` (named volume) at `/data` — the Parquet tree, owned by podman and never a bind mount.
- `~/acta/tiles` — the PMTiles archives, mounted read-only. Regenerated on the host and copied with
  `mise run deploy:tiles`; the container never writes there.

Credentials are podman secrets: `acta-auth-ui-user`/`-password`, `acta-auth-sensor-user`/`-password`,
`acta-aws-key-id` and `acta-aws-secret`, installed with `mise run deploy:secrets`. Both halves of each auth pair are
secrets, so a username never appears in the unit either. The values are committed as ciphertext in
`.deploy.secrets.enc`, a sops dotenv file encrypted to the age recipient in `.sops.yaml`; the private key is the
1Password item `SOPS age key - acta`, read into a variable by the two tasks that need it and never written to disk.
`mise run deploy:edit-secrets` opens the ciphertext in `$EDITOR` and re-encrypts on save, so no decrypted copy is
left behind; only the ciphertext is committed, so the committed file is the single source of truth for the deployed
credentials. The plaintext `.deploy.secrets` is gitignored and is not part of the round trip.

`mise run deploy:seed <dir>` imports a fresh dataset and refuses a volume that already holds data, printing the
command to clear it; `mise run deploy:restore` recovers one from S3. Only one container may use the data volume at a
time: the service assumes it owns the tree, including `.staging/` and `.trash/`.

`.deploy.env` (committed) holds the non-secret inputs, led by `ACTA_HOST` and the S3 settings; the file lists every
service setting the deploy can pass through, with its default. All of them are rendered into the quadlet as
`Environment=` lines, so `systemctl --user cat acta` shows the effective configuration. The credentials
`ACTA_AUTH_UI_USER`/`ACTA_AUTH_UI_PASSWORD`, `ACTA_AUTH_SENSOR_USER`/`ACTA_AUTH_SENSOR_PASSWORD`,
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are only decrypted by `mise run deploy:secrets`, which hands them to
podman; `mise run deploy` never sees a secret value, it checks with `podman secret exists` that they were installed.
`mise run deploy:secrets` also restarts `acta` when it is already installed, because a running container keeps the
environment it started with; before the first deploy it only installs the secrets.

## Configuration

Every setting is an environment variable; unset means the default. Sizes are bytes and durations are milliseconds.

### Server and paths

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACTA_ADDR` | `127.0.0.1:8080` | Listen address. The container sets `0.0.0.0:8080`. |
| `ACTA_DATA_DIR` | `data` | Parquet tree; created if missing, must be writable. |
| `ACTA_UI_DIR` | `ui/dist` | Built frontend, served at `/`. |
| `ACTA_TILES_DIR` | `tiles` | PMTiles archives, served at `/tiles/*`. |
| `RUST_LOG` | `info` | `tracing` filter, e.g. `info,acta=debug`. |

### Read path

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACTA_POOL_SIZE` | `4` | DuckDB connections. Each is an independent in-memory database. |
| `ACTA_MEMORY_LIMIT` | `1GB` | DuckDB memory limit **per connection**, in DuckDB size syntax. With pool 4 the worst case is four times this. |
| `ACTA_THREADS` | `1` | DuckDB threads per connection. The biggest read-path knob: a full-range scan or a deep table page is 2-3x faster at 4 threads. Keep `POOL_SIZE × THREADS` near the core count. |
| `ACTA_QUERY_TIMEOUT_MS` | `10000` | Per-query interrupt timeout. |
| `ACTA_MAX_RESPONSE_BYTES` | `8388608` | Maximum JSON response size; a larger result is rejected. |

### Write path and compaction

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACTA_FLUSH_INTERVAL_MS` | `10000` | Longest a row waits in memory before its `hot-` file is written. |
| `ACTA_FLUSH_MAX_ROWS` | `50000` | Flush early at this many buffered rows. |
| `ACTA_FLUSH_MAX_BYTES` | `67108864` | Flush early at 64 MiB of buffered payload. |
| `ACTA_INGEST_BACKLOG` | `256` | Batches queued before ingest applies backpressure. |
| `ACTA_INGEST_MAX_BODY_BYTES` | `16777216` | `POST /api/ingest` body limit; larger gets `413`. |
| `ACTA_INGEST_MAX_BATCH` | `10000` | Rows per ingest request; larger gets `413`. |
| `ACTA_COMPACTION_INTERVAL_MS` | `60000` | Compaction pass cadence. |
| `ACTA_COMPACTION_GRACE_MS` | `30000` | Delay after a bucket closes before folding, so in-flight flushes land first. |
| `ACTA_ROW_GROUP_SIZE` | `250000` | Rows per Parquet row group. |
| `ACTA_TRASH_RETENTION_MS` | `86400000` | How long superseded files stay in `.trash/`. |
| `ACTA_TRASH_GC_INTERVAL_MS` | `600000` | Trash sweep cadence. |

### Auth

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACTA_AUTH_UI_USER` + `ACTA_AUTH_UI_PASSWORD` | unset | Enables authentication. The UI credential may reach every path. |
| `ACTA_AUTH_SENSOR_USER` + `ACTA_AUTH_SENSOR_PASSWORD` | unset | Optional sensor credential; may only `POST /api/ingest`. |

Set each pair together. Setting only the sensor pair is a startup error (it would leave the UI open); with no UI
credential, authentication is off. `mise run deploy:secrets` installs both pairs, usernames included, as podman
secrets, so the deploy always enables authentication.

### Backup

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACTA_BACKUP` | `off` | `on` enables the hourly upload pass. |
| `ACTA_BACKUP_MINUTE` | `3` | Minute past the hour of each pass. |
| `ACTA_S3_BUCKET` | unset | Required when backup is on. |
| `ACTA_S3_REGION` | derived | Read off a `s3.<region>.backblazeb2.com` endpoint; `us-east-1` otherwise. |
| `ACTA_S3_ENDPOINT` | unset | Endpoint of the S3-compatible provider, as a full `https://` URL; required for Backblaze B2. |
| `ACTA_S3_PREFIX` | empty | Optional key prefix. |
| `ACTA_S3_ALLOW_HTTP` | `off` | Allow a plain-HTTP endpoint (for example a local MinIO). |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | unset | Required when backup is on. |

With `ACTA_BACKUP` off, none of the S3 variables are read and no upload is attempted.

DuckDB 2.0 ships time zone, calendar and collation support as the `icu` extension instead of in the core, and the bundled
build does not include it. The service therefore never sets a session time zone — `SET TimeZone` would make DuckDB try
to autoload `icu`, which fails — and all time handling stays in UTC. For the same reason, the writer builds its
timestamp column with `CAST(make_timestamp(ts_us) AS TIMESTAMPTZ)`; `make_timestamptz` is icu-gated and made every flush
fail. Anything that needs a named zone, `current_setting('TimeZone')` or `epoch(<timestamptz>)` is unavailable.

## Testing

`mise run test` runs the hurl scenarios against a running service's read API (see `design/003-visualization.md`).
`mise run test:ingest` (`tools/simulate_ingest.py`) keeps posting realistic data for every source until interrupted,
which exercises the whole write path including tier compaction. It targets `ACTA_URL` (default the dev server on
`127.0.0.1:8080`); set `ACTA_AUTH=user:pass` when the target has authentication enabled. `--fast` compresses the
cadence and `--duration` bounds the run. `--load` switches to load-test
mode: it ramps concurrent connections until throughput plateaus or errors rise, then holds, reporting requests/s,
rows/s and latency percentiles. To test with a clean dataset, point a service at a scratch `ACTA_DATA_DIR` or empty
`data/`; `mise run migrate` followed by `mise run migrate:split` rebuilds the tier files from `traces.parquet`.
