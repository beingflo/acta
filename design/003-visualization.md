# Data visualization

Acta contains a read path, where the system reads data from `data/*.parquet` and visualizes it in a web frontend.
The service is sitting passively waiting for requests to prepare data for the frontend.

## Concepts

The service refers to the Rust application running on the server. It contains both the endpoints to ingest data into
the system as well as the endpoints to fetch data.
The visualization frontend is a SolidJS application rendering time-series charts with uPlot (brush and zoom
interaction is a requirement).

The frontend owns the queries: every tile knows the SQL it runs. The service only executes SQL and returns the result,
it has no notion of dashboards, tiles or metrics.

The read path reads `data/*.parquet`. The file is sorted by source and then time, so a `source = ...` filter prunes
every other source's row groups and each row group's Variant payload stays homogeneous enough to shred.

The UI is light-mode only and deliberately minimal: white cards with hairline borders, text-only controls, centered
tile titles, and one thin black line per series.

## API

The API consists of a single endpoint that accepts an SQL query in DuckDB dialect and returns the JSON document the
query produces:

```
POST /api/data
{ "sql": "SELECT ..." }
```

The query serializes its own result, e.g. `SELECT to_json(...)`. Producing JSON inside DuckDB keeps VARIANT values on
the database side — DuckDB 1.5 cannot export VARIANT to Arrow — and lets each tile shape the response exactly as its
chart needs it.

Queries run against a small pool of read-only, in-memory DuckDB connections, each exposing an `events` view over the
data directory. External file access is limited to that directory and the configuration is locked after setup; every
query runs under a timeout and a maximum response size.

## Queries

Queries are written by the frontend and are self-contained: they embed concrete `from`/`to` timestamps instead of
relying on `now()`, so a given query string always returns the same rows.

The frontend knows the pixel width of each time-axis tile and the selected range, so it also picks the resolution: it
chooses a bucket width (for example `time_bucket(INTERVAL '5 minutes', timestamp)`) targeting roughly one point per
pixel and bakes it into the query. Narrow ranges return raw points, wide ranges are aggregated aggressively, keeping
responses small.

Buckets are UTC-aligned and the browser renders timestamps in the viewer's local timezone. The service's DuckDB build
has no ICU extension, so timestamps are cast to a naive UTC timestamp before any time function is used.

Variant fields must be cast to their concrete type before aggregating. DuckDB aggregates over a raw floating-point
Variant field are silently wrong: `avg(data.temperature)` returns 21.0 where `avg(data.temperature::DOUBLE)` returns
21.23. Integer-typed fields happen to be correct either way, but cast them too for consistency.

## Authentication

TODO

## Dashboards

Dashboards make up the primary interface of the visualization frontend. The active dashboard is named in the header
picker. Each dashboard is a grid of tiles; a tile has a centered title above its chart.
Dashboards are hardcoded in the application, no dynamic configuration needed and no user modifiability.

Dashboards can be switched by hitting cmd+k: This pops up a command-palette like selector where all available dashboards are listed.

The following dashboards are implemented:

### Home

The CO2 tile spans the full width. The other tiles are half width, two per row.

- CO2 (`co2-sensor-living-room`) time x co2 ppm
- Temperature (`co2-sensor-living-room`) time x temperature °C
- Brightness (`brightness-barometer-living-room`) time x lux
- Humidity (`co2-sensor-living-room`) time x humidity %
- Pressure (`brightness-barometer-living-room`) time x pressure hPa
- Humidity laundry room (`humidity-laundry-room`) time x humidity %
- Temperature laundry room (`humidity-laundry-room`) time x temperature °C

The tiles are fed by three sensors: `co2-sensor-living-room` (co2, temperature, humidity),
`brightness-barometer-living-room` (lux, pressure, temperature) and `humidity-laundry-room` (humidity, temperature).

### Heuried

A single full-width tile containing a visitor chart fed by the `heuried-visitors` data source. The chart has time on the X axis and visitors on the Y axis.

### TODO add more later

## Date range picker

A fixed date range picker is always visible on the top right as a list of buttons: `1y 6m 30d 7d 1d 6h C`
As an example, the 30d button sets the selected time range to `[now - 30d, now]`. The C button opens from / to datetime inputs underneath for custom ranges.

All chart tiles that have a time axis update to reflect the selected timerange. By default the 1d option is selected.
The frontend resolves the selection to concrete timestamps and embeds them into every tile query.

The selected dashboard and range are reflected in the URL: the dashboard as a path (`/home`, `/heuried`) and the
range as a query parameter, using a shorthand for presets (`?range=30d`) or ISO from/to for a custom range
(`?from=2026-10-10T00:00:00.000Z&to=2026-10-11T00:00:00.000Z`). The URL is read on load and on back/forward;
dashboard switches push a history entry while range changes replace the current one.

Relative ranges end at the wall clock, unless the data has not received a point recently, in which case they end at the
newest available point. A stalled dataset then shows its latest window instead of an empty chart.

## Refresh

All visible charts are auto-refreshed every 30s, with random jitter to spread the requests.

## Architecture

For simplicty of deployment, the service serves the frontend bundle as well as the API.

## Testing

Crude API scenarios live in `api/*.hurl` and run with `mise run test` against a running service (`ACTA_URL` overrides
the target). They cover the sources list, a bucketed series, an empty range, and the error contract.
