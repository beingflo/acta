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
tile titles, and one thin line per series with a faint wash of the same hue under the curve. Lines are dark — a light
tint vanishes against the white card at one pixel — and the palette is short and fixed: green for the data, and a
darker green for a second series, so a tile with two sensors (the room temperature from each of them) can tell its
lines apart without a second hue making the pair read as two different quantities. Each series carries its own faint
wash.
Hovering a tile and pressing `v` expands it to fill the viewport;
`v`, `Escape` or the tile's × restores it. Chart tiles get the whole plot, the event tables the whole list, which
simply pages in as many extra rows as the taller viewport shows.

Each chart fits its own y axis to the data rather than taking the data's extent (`ui/src/lib/scale.ts`): a floor and a
ceiling the quantity cannot leave, headroom of a fifth of the data's own extent, and a minimum span per quantity. A
server idling at 0.5 % CPU therefore zooms in instead of lying flat at the bottom of a 0-100 scale, a nearly constant
reading draws as a flat line across the middle rather than as amplified rounding noise, and the axis never leaves the
bounds the quantity actually has. Bars start at zero with a little headroom above the tallest bucket.

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
responses small. A metric tile cannot go as fine as the charts would like — `/api/series` refuses a sub-second bucket —
so its width is floored at one second rather than asking for a bucket the service will reject.

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
- Temperature (`co2-sensor-living-room` and `brightness-barometer-living-room`) time x temperature °C, one line per
  sensor: the two sit in the same room, so their offset is what makes the pair worth drawing
- Brightness (`brightness-barometer-living-room`) time x lux
- Humidity (`co2-sensor-living-room`) time x humidity %
- Pressure (`brightness-barometer-living-room`) time x pressure hPa
- Humidity laundry room (`humidity-laundry-room`) time x humidity %
- Temperature laundry room (`humidity-laundry-room`) time x temperature °C

The tiles are fed by three sensors: `co2-sensor-living-room` (co2, temperature, humidity),
`brightness-barometer-living-room` (lux, pressure, temperature) and `humidity-laundry-room` (humidity, temperature).

Unlike the other dashboards, this one writes no SQL: each tile names a metric the service defines
(`service/src/metrics.rs`), so the same dashboard renders for the owner and for a credential restricted to it — see the
restricted viewer in `design/004-service.md`.

The same readings are drawn onto the epaper panel in the living room by the service itself, at `/api/dashboard` — see
`design/004-service.md`.

### acta

The whole firehose: every row that enters the system, whatever its source. Above the chart a strip of scalars: data
on disk, rows stored in all files, rows in the selected range with their per-minute rate, the last hour's rate, the
age of the newest entry, and how many sources fed the range. The age is taken over the whole dataset, so it still
reads correctly when the window is stepped back in time. File sizes come from the Parquet footers via
`parquet_file_metadata`; the frontend finds the data directory as the one DuckDB is allowed to read.

A source filter sits between the strip and the chart: one dropdown listing the sources the window holds with their row
counts, and both views below it are narrowed to the chosen one. It belongs to the dashboard rather than to the table, so
a collector that has gone quiet can be watched on its own instead of being fished out of the firehose — and `source` is
a plain column, so this read costs nothing even on a year, unlike Marending's facet reads, which decode the payload.

A full-width bar chart of incoming entries per bucket follows — every source counted together, or the chosen one — so a
stalled collector or a spurt shows up as a quiet or busy stretch. Below it a table fills the rest of the viewport with
the rows the filter leaves, newest first: time, source, and the payload as one compact JSON column. The payload is not flattened into
a column per key, because sources share no schema and a wide event (the server stats) would need dozens of columns for
every other source to leave empty. The JSON wraps to two lines, with the full text on hover.

It is the same paged, virtualized table as Marending's, so a wide range is browsable at the same cost as the first
screen.

### eos

The server itself, sampled every 10 s by `stats/collect.py` — a systemd timer on the host, see
`design/004-service.md` — into the `eos-stats` source: CPU usage and load, memory, disk space and disk throughput,
I/O, memory and CPU pressure (PSI, the share of time a task had to wait rather than the share of time the box was
busy), network rates, battery charge and temperature, and — once a minute, since they cost a process spawn or are
state rather than traffic — `podman stats` per container and the NVMe drive's own temperature. Linux exposes no CPU
temperature on this hardware: the firmware holds the core sensors, but the Devicetree
wires up only the NAND, the battery hotspot, the charge regulator and the WiFi module, so the board temperature chart
is the hottest of those, a board-level proxy, and the battery reading is the one true temperature of a component. The
half-width tiles are laid out in pairs of the same subject, so the two container charts, the two network directions
and the two temperature charts each sit side by side.

The charts show the gauges worth a line over time: CPU, board temperature, memory, load, the filesystem behind `/`,
container CPU and memory, network in and out, battery charge and temperature. Above them a strip of scalars: how long
the box has been up, the age of its newest sample, and the window's CPU, memory and board temperature — each as the
average with its peak beside it, since an average says what the box did and the peak says how far it went — then the
disk, battery and container figures of the newest sample, which are state rather than traffic. A gauge that only some
samples carry (containers, every sixth) reads its last known value instead of dropping out of the window, and the age
of the newest sample is taken over the whole dataset, so a stopped collector stays visible when the window is stepped
back. Every chart fits its axis inside the quantity's own bounds, so an idle hour shows its own shape while the
percentages still never leave 0-100.
Everything the collector sends beyond those charts (per container, per mount) is in the "Latest sample" tile, which
prints the newest row of the source flattened to `path · value` rows: a field a collector starts sending is readable
without adding a tile for it.

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

A filter row sits between the stats strip and the chart, and both views below it are narrowed by it: dropdowns for
method, status and path area, whose values — and counts — are the ones the selected window actually contains (read with
the window and with each filter change, not on every poll), and a search box matching a substring of the URI, the user
agent or the referrer. Path area is derived from the URI rather than read from the log: `route_class` only appears in
events from 2026-10-30 on, so most of the history carries none, while bucketing the path works on all of it. The
buckets are `content` (the pages, with or without a trailing slash), `asset` (`/_astro`, by extension), `feed` (`rss`,
`sitemap`, `robots`), `api`, `probe` (the WordPress and dot-file dictionary crawlers walk — those names only at the root,
so a note called `/notes/config-driven-design` stays a page, but a dot-segment is a probe at any depth) and `missing`
(everything else, which is what pairs with `4xx` to mean "pages that do not exist"). A field's counts are taken under the *other* filters and not its own, so each number says what picking that
value would leave, and picking one never strands the dropdown. All three come from one grouped pass over the window:
reading a payload field is the expensive part of these queries, and one pass reads them all. It belongs to the dashboard
rather than to either view, because the chart is the same log counted per bucket — narrowing the table alone would let
the two disagree about what "the requests" are. Empty fields narrow nothing; the row shows what is narrowing once
something is, and clears itself in one click. The stats strip above stays the window's totals: "all time", "last hour"
and "newest request" are not statements a request filter can narrow.

The table is virtualized and paged by timestamp, because a window can hold hundreds of thousands of requests: a
`count(*)` sizes a spacer so the scrollbar covers the whole range, and pages are fetched as "the 500 rows at or below
this instant" rather than by `OFFSET`, so a deep page costs the same as the first one. Scrolling continues from the last
row's timestamp; jumping somewhere new bisects on the same count function (a handful of cheap count queries) to land
within a bounded offset of the target row. Only the visible rows, plus a screenful of overscan on each side and the
neighbouring pages, are fetched ahead of the scroll. A refresh stages the visible pages and swaps them in together, so
the table never blanks on the 30s tick.

The table sheds columns as the window narrows: the error message first, then the referrer, latency and the method,
leaving time, URI, status and user agent at phone width.

A refresh marks the oldest row it brought in with a faint tint that fades over three seconds, so it is visible how
many entries just arrived: everything above that row is new. The row is found by comparing the fetched
newest-first page against the newest timestamp the table had seen, so it needs no extra query and no server-side
state. When the whole fetched window is new the mark is omitted rather than drawn somewhere in the middle — a batch
too big for the screen shows itself by having no boundary.

Clicking a row opens the whole event in an overlay, pretty-printed: a cell shows the columns the table has, and a
source's payload is not shaped like any other's — an `eos-stats` sample nests whole subsystems, a Marending request
carries fields the table never shows. The document is coloured by token — keys, string values, numbers, literals — off
the text `JSON.stringify` produced, which is enough to read a wide payload without shipping a highlighter. The Acta
table already holds the payload, so the overlay needs no query; the request table keeps only its displayed columns and
asks the service for the stored event by source and timestamp on click. The arrow keys walk that table without closing
the overlay; the walk asks for the row immediately older or newer than the timestamp being read, so it never depends on
which pages happen to be cached — row numbers shift whenever a refresh brings new entries in above, and pages beyond the
refreshed window keep answering with their old contents until they are re-fetched. The end of the table is a no-op
rather than a close, so overshooting does not lose the event being read. `Escape` or the hush closes it, and it sits
above the tiles rather than inside one: a tile is its own stacking context, which would paint a fixed backdrop under its
neighbours.

### location

A single full-width and full-height tile showing a map fed by the `location_florian` data source: the position fixes
in the selected range are plotted. They are drawn as a line joining them in time order by default; hovering the map and
pressing `p` switches to points and back. The track is black rather than the chart green: over the basemap's parks and
water it reads as ink instead of one more data line.

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

A map that cannot start reports why on the tile: MapLibre raises the reason — no WebGL2 context, a tile answered
`401`, a style resource that never arrives — as an exception or an error event, and a phone shows no console. The
caption also appears when the style has not finished loading after ten seconds, which is the one failure MapLibre
itself never reports. Neither the API nor the tile archives pass through the service worker, so a ranged read of a
PMTiles archive always reaches the service directly.

### work

The office day, from a geofence around the office: two scalars saying when the office was reached, then presence over the
selected range. The fence is a box of degrees in `ui/src/lib/query.ts` — the bundled DuckDB has no `spatial`
extension, so being inside is two `BETWEEN`s on the coordinates the location query already extracts. It is a constant
in the frontend rather than a secret: the app shell is public, so a coordinate in the bundle is published either way,
and the place is not a credential.

The scalars are the first *crossing* into the box in two windows of the day — morning `06:00–11:00` and after lunch
`11:30–15:00`, local time — and they answer for the calendar day the *selected range ends in*. A crossing means the fix
follows one that was outside: a box wide enough to cover the walk to the front door otherwise reports the last minute at
the desk before lunch as the return from it, which on nine of ten days was minutes to an hour early. The morning is
unaffected — that arrival is always a crossing — and the query materialises a day's fixes plus a day of lookback, so
asking for the predecessor costs nothing measurable. Stepping the range back a
day therefore shows that day's times, and a window ending at midnight belongs to the day before, because ranges are
half-open. A rolling 24 hours is deliberately not used: it would show yesterday's afternoon under today's heading. The
day's windows are given to the query as instants, so the date arithmetic stays in the browser, where local time and its
DST rules live.

Below it, the same question at another scale. A **day lane**: one row per day — the day the range ends in, and as
many before it as the range is long, so `1d` is one row and `7d` is seven — one column per quarter hour between 06:00 and
21:00 — the hours anyone is at the office — filled where the last known
position was inside the box — a grid rather than a chart, since the
point is to read a month at a glance. A day is only filled between its own first and last fix: the state holds forward
between fixes, but before the first and after the last one the phone was merely silent, and claiming a night at the
office from that silence is how the first version filled whole days. The day boundaries are built in the browser
because DuckDB's bundled build has no timezone database, so local midnight and DST are the platform's business. The
location dashboard's map is where the box gets checked against the ground truth; this one does not need a second one.

The presence chart is a step, not a percentage, and it is drawn through the fixes themselves rather than through
buckets. The tracker reports only when the phone moves — standing at a desk produces nothing at all — so the state
between two fixes is the last one seen, held until the next, and a share of samples would call a whole morning at the
office "mostly absent". Bucketing would do a second kind of damage: the fixes of a walk-in start outside and end
inside, so a bucket that holds a whole walk has to pick one of the two and gets half of it wrong, and any bucket width
moves an arrival or a departure by up to that width. One point per fix is exact, and small enough to send whole: a year
is a few thousand rows. `trip` summaries carry no position and are filtered out, so they can never read as "away".

### TODO add more later

## Summary strip

Above the charts, one small card per series repeats its newest value in the selected range, with the unit and a swatch
in the series' shade. A tile with more than one line names the line in the card's title, since two cards under one tile
title would not say which sensor each belongs to. The tiles publish those values as they load, so the strip costs no
extra queries and can never disagree with the right-hand end of the chart.

## Charts

Time series are drawn with uPlot. A crosshair follows the pointer and a small tooltip next to it shows the bucket's
timestamp and each series' value with its unit, and — where the plotted value is a percentage — the absolute it stands
for as a second line (memory and disk in GB). The absolute is fetched in the same bucket as the plotted column and
never drawn: on the tile's axis it would be a second quantity in another unit. That cursor is shared by every tile,
so hovering one shows the same instant on all of them. Only x is shared — each tile has its own y scale — so the tiles
that merely follow show the
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

A fixed date range picker is always visible on the top right as a list of buttons: `all 1y 30d 7d 1d 6h 1h C`
As an example, the 30d button sets the selected time range to `[now - 30d, now]`, while `all` spans the full data range
(earliest to newest point). The C button opens from / to datetime inputs underneath for custom ranges, with a short
approximate length of the window in front of them (`~2h`, `~4d`, `~3mo`) — brushing a chart picks a window by eye, and
the span is the one thing the two fields do not say at a glance. A range renamed
in the URL (`?range=30m`) still resolves to its replacement (`1h`), so an older link keeps working.

A custom range whose end was within two minutes of the wall clock when it was chosen — a brush up to the right edge
of a live chart, or the current minute in the inputs — keeps a live end: the start stays fixed and the end is resolved
to `now` on every query, so it still ends at the present after the tab has sat in the background. The end field shows
that resolved value, so it advances with the clock while the panel is open. Any other custom range is fixed.

`Ctrl+H` or `←` step the window back by its own length and `Ctrl+L` or `→` step it forward: with 30d selected,
`Ctrl+H` gives `[now - 60d, now - 30d]`. A stepped window is no longer a preset, so it becomes a custom range.

All chart tiles that have a time axis update to reflect the selected timerange. By default the 1d option is selected.
The frontend resolves the selection to concrete timestamps and embeds them into every tile query.

The selected dashboard and range are reflected in the URL: the dashboard as a path (`/home`, `/acta`, `/eos`,
`/marending`, `/location`) and the range as a query parameter, using a shorthand for presets (`?range=30d`) or ISO
from/to for a custom range (`?from=2026-10-10T00:00:00.000Z&to=2026-10-11T00:00:00.000Z`). A custom range with a live
end writes `from` alone: the missing `to` means "resolve it to now when read", so reopening the URL keeps following
the clock. The URL is read on load and on back/forward. Dashboard switches and range changes each push a history entry,
so Back steps through the ranges visited before leaving the dashboard; landing on an entry never pushes another one,
because the URL already matches.

Relative ranges and live-ended custom ranges always end at the wall clock. A feed that stops therefore leaves a recent
window empty rather than silently showing the last window it had: the gap is what the dashboard should report. `all` is
the exception in the other direction — it spans the recorded extents, which are read when the page loads and again
whenever `all` is chosen.

## Refresh

Only a live window is polled: a selection that ends at the wall clock and spans at most six hours — the 1h and 6h
presets, or a custom range ending now. It refreshes every 10 s, with a little jitter, so the dashboard follows a live
feed; a small mark next to the range buttons says when this is on. Any other window is a historical snapshot, fetched
when it is selected and then left alone, so 1d, 30d and `all` do not poll. Charts, tables and the scalar strips share the
policy. `r` reloads the data of the current view immediately, live or not, without touching the range — the live mark
flashes to acknowledge it.

A hidden tab polls nothing: its refresh timers are cleared when the tab goes away and restarted when it comes back.
Returning reloads at once for any window up to 30 days — live or a snapshot, since re-reading a month is cheap and the
rows may have changed meanwhile — and leaves a year or `all` to an explicit `r`.

No bounds polling is involved. The extents are needed only for `all`, so they are read when the page loads, whenever
`all` is chosen, when the tab becomes visible while `all` is open, and on a manual refresh.

## Architecture

For simplicty of deployment, the service serves the frontend bundle as well as the API.

## Testing

Crude API scenarios live in `api/*.hurl` and run with `mise run test` against a running service (`ACTA_URL` overrides
the target). They cover the sources list, a bucketed series, an empty range, and the error contract.
