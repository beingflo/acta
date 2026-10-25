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

Two HTTP basic credentials are configured through podman secrets. The UI credential guards the read API and the tile
archives; the sensor credential may only write data (`POST /api/ingest`, `POST /api/gps/{source}`), so a sensor
password can be rotated without touching the dashboard. With no UI credential configured, authentication is off, which
is what the local dev server relies on. Passwords are compared in constant time and never logged.

**The app shell is public** — `index.html`, the hashed assets, the manifest and the service worker. It carries no data,
and an installed home-screen app on iOS cannot show its own sign-in form if a credential is needed to fetch the HTML.
Everything that holds data (`/api/*`, `/tiles/*`) stays behind the middleware, and `/health` stays public for the deploy
script and any probe.

**The dashboard signs in with a cookie, not with the browser's dialog.** iOS never offers to save basic credentials, and
an installed web app gets its own storage container, so anything relying on the browser's prompt asks for the password
on every cold launch. Instead the app posts the credential once to `/api/session` (setting `Authorization` itself, so no
modal appears) and the service answers with `acta_session`: `HttpOnly`, `SameSite=Lax`, `Secure` when the request
arrived over TLS, valid for **two months**. `DELETE /api/session` clears it.

The cookie holds a signed claim rather than an identifier: `expiry ‖ nonce`, with an HMAC-SHA256 tag over it. Nothing is
stored server-side, so a restart costs nobody a login, and no lookup happens per request — one `ring::hmac` verify
(~0.1 µs) sits in the middleware, before the basic-credential check. The signing key is derived from both dashboard passwords, so **rotating
either one invalidates every outstanding cookie** — including the restricted viewer's when their password is withdrawn;
that is the revocation story, and the reason a sign-out only clears the browser's copy. Refusals carry no `WWW-Authenticate`: the app owns the sign-in, and a challenge
on a `fetch` makes browsers raise their own dialog instead — which strands clients that cannot answer a modal.

**Basic credentials are read in two places only**: `/api/session`, where the dashboard trades them for the cookie, and
the sensor's write routes (`/api/ingest`, `/api/gps/{source}`), which a machine presents on every request. Every other
route wants the cookie — a basic header on `/api/data`, `/api/series`, `/api/me` or `/tiles/*` is simply ignored and
answered `401`. That narrows the surface a password can be guessed against to a single endpoint, which is what makes the
throttle below worth having. Locally, with authentication off, nothing changes: there is nothing to present.

**Failed sign-ins are paced, without any per-address state.** Ten failures inside a minute and the eleventh answers `429`
with `Retry-After`; a success clears the budget, and a correct credential is verified *before* the budget is consulted, so
a flood of wrong guesses can never lock the owner out of signing in — it only exhausts its own kind. One counter serves
everybody, which is the right size for a household, and it means no client addresses are read, stored, or trusted. Each
failure logs one line with the forwarded address (never the credential), so `fail2ban` or a Caddy rule has something to
match if the host ever grows one; the sensor credential is not throttled, since it is machine-issued and throttling it
would let an outsider stall the collectors.

Scripts that used to send `curl -u … /api/data` sign in first and keep the cookie:

```sh
curl -s -o /dev/null -c jar -u "$user:$password" https://host/api/session
curl -s -b jar -X POST -H 'Content-Type: application/json' -d '{"sql":"select 1"}' https://host/api/data
```

### The restricted viewer

A second pair, `ACTA_AUTH_HOME_USER`/`ACTA_AUTH_HOME_PASSWORD`, signs in with `Scope::Home`: the app shell,
`/api/session`, `/api/me` and `/api/series` — and nothing else. `/api/data`, the tile archives and every other route
answer `403`, and the scope is a byte inside the signed cookie, so it cannot be edited client-side.

`/api/series` is the point of that split. `/api/data` takes SQL, and no inspection of arbitrary SQL makes it safe to
expose to someone who may only see part of the data — so restricted readers never send SQL. They name a **metric**
(`service/src/metrics.rs`), which is a hand-written definition of one reading: its single source, its aggregate, and
whether a restricted viewer may ask for it (opt-in per metric, so a new one is closed by default). The service builds the
SQL, and the whole request surface is a metric id, a window and a bucket width — validated, then re-rendered, so nothing
the caller typed reaches the query. A metric a viewer may not read answers exactly like one that does not exist.

The home dashboard is written entirely in metrics, so both credentials render it through the same endpoint; the other
dashboards still use `/api/data` and are the owner's alone. `/api/me` returns the scope so the picker offers a restricted
viewer one dashboard, but that is presentation: enforcement is the scope check and the metric registry, and typing
`/eos` by hand lands on the home dashboard with nothing to read.

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

### GPS

`POST /api/gps/{source}` accepts the Overland iOS app's push body, `{"locations": [<GeoJSON Feature>, …]}`, and stores
**one row per fix** under the source named in the path (`location_florian`). The reading time is the fix's own
`properties.timestamp`, not the arrival time — a push carries the fixes accumulated since the previous one, so arrival
time would collapse ten minutes of movement onto one instant. The feature is stored whole, so position fixes and the
app's occasional `properties.type == "trip"` summaries share a source and the read path branches on that field.
`current` is ignored. The array is unwrapped server-side because the app offers no way to reshape its body; `events`
did the same, one span per fix, which is why the migrated rows are one per fix as well. The same handler accepts the
sensor credential as basic auth or as `Authorization: Bearer <sensor password>`, the only scheme the app supports.

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

Credentials are podman secrets: `acta-auth-ui-user`/`-password`, `acta-auth-home-user`/`-password` (optional — omit both
to run without the restricted viewer), `acta-auth-sensor-user`/`-password`,
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
| `ACTA_ROW_GROUP_SIZE` | `250000` | Rows per Parquet row group. The deployed unit sets `2000000` so a closed month is one group; see `design/001-overview.md`. |
| `ACTA_TRASH_RETENTION_MS` | `86400000` | How long superseded files stay in `.trash/`. |
| `ACTA_TRASH_GC_INTERVAL_MS` | `600000` | Trash sweep cadence. |

### Auth

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACTA_AUTH_UI_USER` + `ACTA_AUTH_UI_PASSWORD` | unset | Enables authentication. The UI credential may reach every path. |
| `ACTA_AUTH_HOME_USER` + `ACTA_AUTH_HOME_PASSWORD` | unset | Optional second dashboard credential, restricted to the home readings: `/api/series`, `/api/me`, `/api/session` only. |
| `ACTA_AUTH_SENSOR_USER` + `ACTA_AUTH_SENSOR_PASSWORD` | unset | Optional sensor credential; may only `POST /api/ingest` and `POST /api/gps/{source}`. |

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
including the `eos-stats` host gauges that `stats/collect.py` posts from the server, which exercises the whole write
path including tier compaction. It targets `ACTA_URL` (default the dev server on
`127.0.0.1:8080`); set `ACTA_AUTH=user:pass` when the target has authentication enabled. `--fast` compresses the
cadence and `--duration` bounds the run. `--load` switches to load-test
mode: it ramps concurrent connections until throughput plateaus or errors rise, then holds, reporting requests/s,
rows/s and latency percentiles. To test with a clean dataset, point a service at a scratch `ACTA_DATA_DIR` or empty
`data/`; `mise run migrate` followed by `mise run migrate:split` rebuilds the tier files from `traces.parquet`.
