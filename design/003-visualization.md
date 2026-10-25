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
`v`, `Escape` or the tile's × restores it. Chart tiles get the whole plot, the event tables the whole list, which
simply pages in as many extra rows as the taller viewport shows.

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
picker. Each dashboard is a grid of tiles; a tile has a centered title above its chart. The header keeps its height and
the dashboard area below it scrolls, so a dashboard can fill the viewport (Marending, Acta, Location) or grow past it
(Home) without relying on viewport-height arithmetic. Tiles reflow to a single column on narrow screens.
Dashboards are hardcoded in the application, no dynamic configuration needed and no user modifiability.

Dashboards can be switched by hitting cmd+k: This pops up a command-palette like selector where all available dashboards are listed. Within
it, the arrow keys (or ctrl+j / ctrl+k) move the selection and enter opens it.

The following dashboards are implemented:

### home

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

### acta

The whole firehose: every row that enters the system, whatever its source. Above the chart a strip of scalars: data
on disk, rows stored in all files, rows in the selected range with their per-minute rate, the last hour's rate, the
age of the newest entry, and how many sources fed the range. The age is taken over the whole dataset, so it still
reads correctly when the window is stepped back in time. File sizes come from the Parquet footers via
`parquet_file_metadata`; the frontend finds the data directory as the one DuckDB is allowed to read. A full-width bar
chart of incoming entries per bucket — all sources counted together — follows, so a stalled collector or a spurt
shows up as a quiet or busy stretch. Below it a table fills the rest of the viewport with the individual rows in the
same range, newest first: time, source, and the payload as one compact JSON column. The payload is not flattened into
a column per key, because sources share no schema and a wide event (the server stats) would need dozens of columns for
every other source to leave empty. The JSON wraps to two lines, with the full text on hover.

It is the same paged, virtualized table as Marending's, so a wide range is browsable at the same cost as the first
screen.

### eos

The server itself, sampled every 10 s by `stats/collect.py` — a systemd timer on the host, see
`design/004-service.md` — into the `eos-stats` source: CPU usage and load, memory, disk space, network rates, battery
charge and temperature, CPU temperature, and `podman stats` per container (once a minute, since that costs a process
spawn rather than a file read).

The charts show the gauges worth a line over time: CPU, CPU temperature, memory, load, the filesystem behind `/`,
container CPU and memory, network in and out, battery charge and temperature. Percentages are pinned to a 0-100 y axis, so a busy hour
and a quiet one are drawn to the same scale. Everything the collector sends beyond those charts (per container, per
mount) is in the "Latest sample" tile, which prints the newest row of the source flattened to `path · value` rows: a
field a collector starts sending is readable without adding a tile for it.

### marending

Access logs from the Caddy proxy in front of `marending.dev`, migrated as the `marending` source
(`{ method, uri, user_agent, referrer, status, latency_ns, errors? }`). Above the chart a strip of scalars tuned to the
log: all requests stored, requests in the selected range with their per-minute rate, the last hour's rate, the error
rate, p95 and median latency, and the age of the newest request. A full-width bar chart of requests per bucket
follows, each bar split between what the site served and what it answered with an error (status 4xx/5xx), so a
bucket that is half errors reads as half a red bar. Below it a table fills the rest of the viewport with the individual
requests in the same range: time, method, URI, status, latency, referrer, user agent and, where the handler logged one,
the error message. Rows newest first. A bucket that saw no requests is drawn as zero, so every bar is one bucket wide
and the gaps in the chart are real quiet periods.

The table is virtualized and paged by timestamp, because a window can hold hundreds of thousands of requests: a
`count(*)` sizes a spacer so the scrollbar covers the whole range, and pages are fetched as "the 500 rows at or below
this instant" rather than by `OFFSET`, so a deep page costs the same as the first one. Scrolling continues from the last
row's timestamp; jumping somewhere new bisects on the same count function (a handful of cheap count queries) to land
within a bounded offset of the target row. Only the visible rows, plus a screenful of overscan on each side and the
neighbouring pages, are fetched ahead of the scroll. A refresh stages the visible pages and swaps them in together, so
the table never blanks on the 30s tick.

The table sheds columns as the window narrows: the error message first, then the referrer, latency and the method,
leaving time, URI, status and user agent at phone width.

### location

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
and a zero-based y axis, since a bar reads its height from the axis. A bar tile names its bucket width in the title
(`· per 15 min`): the width is chosen from the range and the tile's width, and a bar's height only means something per
that span. A bar tile can also stack its series: a bucket is
then one bar, and each series paints the slice between its own cumulative value and the layer below it.

Every tile aggregates into buckets sized from the selected window and the tile's width, down to 10 ms. The x axis is
the selected window rather than the extent of the data, so a selection too short to contain a sample still shows its
time axis, and a window holding a single point draws that point as a marker (sparse series get markers in general)
instead of nothing at all.

Chart areas and summary cards are sized before the first query returns, and a tile whose query is in flight shows a
small spinner, so nothing shifts when the data lands. The periodic refresh is silent — only a range change or a first
load shows the spinner.

## Date range picker

A fixed date range picker is always visible on the top right as a list of buttons: `all 1y 30d 7d 1d 6h 30m C`
As an example, the 30d button sets the selected time range to `[now - 30d, now]`, while `all` spans the full data range
(earliest to newest point). The C button opens from / to datetime inputs underneath for custom ranges.

`Ctrl+H` or `←` step the window back by its own length and `Ctrl+L` or `→` step it forward: with 30d selected,
`Ctrl+H` gives `[now - 60d, now - 30d]`. A stepped window is no longer a preset, so it becomes a custom range.

All chart tiles that have a time axis update to reflect the selected timerange. By default the 1d option is selected.
The frontend resolves the selection to concrete timestamps and embeds them into every tile query.

The selected dashboard and range are reflected in the URL: the dashboard as a path (`/home`, `/acta`, `/eos`,
`/marending`, `/location`) and the range as a query parameter, using a shorthand for presets (`?range=30d`) or ISO
from/to for a custom range (`?from=2026-10-10T00:00:00.000Z&to=2026-10-11T00:00:00.000Z`). The URL is read on load
and on back/forward; dashboard switches push a history entry while range changes replace the current one.

Relative ranges end at the wall clock, unless the data has not received a point recently, in which case they end at the
newest available point. A stalled dataset then shows its latest window instead of an empty chart.

## Refresh

All visible charts are auto-refreshed every 30s, with random jitter to spread the requests.

## Architecture

For simplicty of deployment, the service serves the frontend bundle as well as the API.

## Testing

Crude API scenarios live in `api/*.hurl` and run with `mise run test` against a running service (`ACTA_URL` overrides
the target). They cover the sources list, a bucketed series, an empty range, and the error contract.
