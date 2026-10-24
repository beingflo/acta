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
tile titles, and one thin line per series with a faint wash of the same hue under the curve. Every series is drawn in
one green so the dashboards read as a family rather than a per-quantity color code.
Hovering a tile and pressing `v` expands it to fill the viewport;
`v`, `Escape` or the tile's × restores it.

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

Dashboards can be switched by hitting cmd+k: This pops up a command-palette like selector where all available dashboards are listed. Within
it, the arrow keys (or ctrl+j / ctrl+k) move the selection and enter opens it.

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

### Website

Access logs from the Caddy proxy in front of `marending.dev`, migrated as the `marending` source
(`{ method, uri, user_agent, referrer, status, latency_ns, errors? }`). A thin full-width bar chart of requests per
bucket spans the top; below it a table fills the rest of the viewport with the individual requests in the same range:
time, method, URI, status, latency, referrer, user agent and, where the handler logged one, the error message. Rows
newest first.

The table is virtualized and paged, because a window can hold hundreds of thousands of requests: a `count(*)` sizes a
spacer so the scrollbar covers the whole range, and only the pages the visible window touches are fetched (200 rows per
query, cached, `LIMIT`/`OFFSET`) and only the visible rows are in the DOM.

### Location

A single full-width and full-height tile showing a map fed by the `location_florian` data source: the position fixes
in the selected range are plotted. They are drawn as a line joining them in time order by default; hovering the map and
pressing `p` switches to points and back.

The basemap is self-hosted. The service serves PMTiles archives from `tiles/` and the frontend renders them with
MapLibre GL and the PMTiles protocol as several stacked sources, coarsest first: a world basemap, a mid-zoom set
covering everywhere the fixes are, and a street-level set over the places they are most frequent. Each archive's zoom
range comes from its own header, so it is not restated in the frontend.

Those regions are derived from the fixes themselves with `tools/map_regions.py`, which is driven entirely by
constants inside it: `mise run map:regions` writes the regions and prints the commands, `mise run map:download` builds
the archives (`--dry-run` to only size them). It scores a ~500 m grid by how many distinct days each cell is
visited, pads and run-length encodes the qualifying cells into a GeoJSON MultiPolygon that follows the track rather
than a bounding box, and prints the matching `pmtiles extract --region=<file>` command per tier. High zoom is thus
spent where the data actually is.

### TODO add more later

## Summary strip

Above the charts, one small card per chart repeats its newest value in the selected range, with the unit and a swatch
in the chart's colour. The tiles publish those values as they load, so the strip costs no extra queries and can never
disagree with the right-hand end of the chart.

## Charts

Time series are drawn with uPlot. A crosshair follows the pointer and a small tooltip next to it shows the bucket's
timestamp and each series' value with its unit. That cursor is shared by every tile, so hovering one shows the same
instant on all of them. Only x is shared — each tile has its own y scale — so the tiles that merely follow show the
vertical line with their tooltip pinned to the top of the plot, and a horizontal line only on the tile being hovered.
A maximized tile is the only chart on screen, so it is the only one that takes part in that sharing.
Dragging horizontally selects a custom range; a short drag is ignored, so it still reads as a click.

Charts are lines by default; a tile can ask for bars instead, which is what counts per bucket want. Bars get a flat fill
and a zero-based y axis, since a bar reads its height from the axis.

Chart areas and summary cards are sized before the first query returns, and a tile whose query is in flight shows a
small spinner, so nothing shifts when the data lands. The periodic refresh is silent — only a range change or a first
load shows the spinner.

## Date range picker

A fixed date range picker is always visible on the top right as a list of buttons: `all 2y 1y 6m 30d 7d 1d 6h C`
As an example, the 30d button sets the selected time range to `[now - 30d, now]`, while `all` spans the full data range
(earliest to newest point). The C button opens from / to datetime inputs underneath for custom ranges.

`Ctrl+H` or `←` step the window back by its own length and `Ctrl+L` or `→` step it forward: with 30d selected,
`Ctrl+H` gives `[now - 60d, now - 30d]`. A stepped window is no longer a preset, so it becomes a custom range.

All chart tiles that have a time axis update to reflect the selected timerange. By default the 1d option is selected.
The frontend resolves the selection to concrete timestamps and embeds them into every tile query.

The selected dashboard and range are reflected in the URL: the dashboard as a path (`/home`, `/location`) and the
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
