# Acta

Acta is a data collection and visualization system. It consists of a Rust service that accepts arbitrary data and
stores it in Parquet files, and a SolidJS frontend that queries and visualizes that data.

### Use cases

Acta is a personal software project designed for one user, hosted on a home server. It is intended to be
operationally simple and use little to no resources when not in active use.

### Data sources

Current data stored in acta includes

- IoT sensor data (CO2, humidity, temperature etc.)
- GPS location data (Overland iOS GPS Tracker)
- Auxiliary services scraping data from public sites
- Wide events emitted by web services
- Server statistics (Load, memory usage, disk etc.)

### Queries

Queries issued from the frontend include simple histograms to view e.g. page views on services. Also more complex
queries to derive data are supported, like geofence queries on GPS data to determine presense at points of interests.

### Data storage

The Rust HTTP service accepts arbitrary JSON data and buffers it in memory for some seconds. Then, it writes the
data to a small Parquet file where the payload is stored semi-structured using the Variant type.

Periodically, the service aggregates the small files and writes back bigger, e.g., hourly and then daily files.

### Operation

Acta is a single binary consisting of the Rust backend that serves the API as well as the bundled frontend.
The install artifact is a container that runs on the server using Podman and Quadlet.

## Further reading

Service: `design/service.md`
Migration: `design/migration.md`
Visualization: `design/visualization.md`

Development plan: `PLAN.md`
