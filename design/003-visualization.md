# Data visualization

Acta contains a read path, where the system reads data from `data/*.parquet` and visualizes it in a web frontend.
The service is sitting passively waiting for requests to prepare data for the frontend.

## Concepts

The service refers to the Rust application running on the server. It contains both the endpoints to ingest data into
the system as well as the endpoints to fetch data.
The visualization frontend is a SolidJS application using TODO charting library.

## API

The API consists of a single endpoint that accepts an SQL query in DuckDB dialect and returns arbitrary JSON as returned
by that query:

```
GET /api/data
```

In this way, the frontend drives which queries are issued against the parquet file.

## Authentication

TODO

## Dashboards

Dashboards make up the primary interface of the visualization frontend. Each dashboard has a bold title with a multitude of
tiles containing charts or scalar values.
Dashboards are hardcoded in the application, no dynamic configuration needed and no user modifiability.

Dashboards can be switched by hitting cmd+k: This pops up a command-palette like selector where all available dashboards are listed.

The following dashboards are implemented:

### Home

A single full-width tile containing the CO2 chart fed by the `co2-sensor-living-room` data source. The chart has time on the X axis and CO2 ppm on the Y axis.

### TODO add more later

## Date range picker

A fixed date range picker is always visible on the top right as a list of buttons: `1y 6m 30d 7d 1d 6h C`
As an example, the 30d button sets the selected time range to `[now - 30d, now]`. The C button opens from / to datetime inputs underneath for custom ranges.

All chart tiles that have a time axis update to reflect the selected timerange. By default the 1d option is selected.

## Refresh

All visible charts are auto-refreshed every 30s in a staggered manner.

## Architecture

For simplicty of deployment, the service serves the frontend bundle as well as the API.
