# Service

The service is the Rust binary. It serves the read API and the frontend bundle today, and will ingest data in Phase 3.

## Read path

`POST /api/data` runs a DuckDB query against `data/*.parquet` through a small pool of read-only, in-memory
connections, each exposing an `events` view. External file access is limited to the data directory, the configuration
is frozen after setup, and every query runs under a timeout and a response size cap. See `design/003-visualization.md`
for the query model.

The built frontend (`ui/dist`) is served by the same process; unknown paths fall back to `index.html` for the
single-page app.

## Auth

## Data ingestion

## Data Lifecycle / retention

## Backup
