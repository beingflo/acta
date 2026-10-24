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

Files are bucketed by *arrival* time, not by the `timestamp` they carry. A batch lands in the current 10 s window, and
compaction folds windows into five-minute, hourly, daily and monthly files. A closed arrival bucket therefore never
receives another row, which is what keeps compaction append-only. The `timestamp` column stays the event time
(supplied or server time); a late point lands in a newer arrival bucket and is still returned by any query whose
range matches it.

Every tier covers a disjoint span of arrival time, so each row lives in exactly one file. Within a file rows are
sorted by source and then time; keeping a source's rows contiguous keeps each row group's Variant payload homogeneous
enough to shred and lets row-group statistics skip other sources. All data is retained.

### Operation

Acta is a single binary consisting of the Rust backend that serves the API as well as the bundled frontend.
The install artifact is a container that runs on the server using Podman and Quadlet.

The Parquet tree lives in a named podman volume mounted at `/data`; the PMTiles archives are a read-only bind mount.
Caddy terminates TLS and proxies `acta.marending.dev` to the container's loopback port. The service backs the data up
hourly itself — the closed hour file is uploaded to S3 as it closes, and day and month files as they fold, always
append-only — so no external cron or backup tool is involved. See `design/004-service.md` for the deployment and
backup details.

## Further reading

Migration: `design/002-migration.md`
Visualization: `design/003-visualization.md`
Service: `design/004-service.md`

Development plan: `PLAN.md`
