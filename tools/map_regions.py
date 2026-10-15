#!/usr/bin/env python3
"""Derive PMTiles extract regions from the location data, and build the archives.

High-zoom basemap tiles are expensive, so we only want them where the fixes
actually are. This reads every fix from the service, scores a grid by how many
*distinct days* each cell is visited (fix counts over-weight movement, and the
`speed` property is mostly -1), and writes the covered cells as run-length
rectangles in a GeoJSON MultiPolygon — so the region follows the track rather
than wrapping it in a bounding box.

Everything is configured by the constants below; there is nothing to pass in.

    mise run map:regions                 write the regions, print the commands
    mise run map:download                the above, then build the archives
    mise run map:download -- --dry-run   size the extracts, download nothing

The two tiers keep the zoom bands disjoint, so each band is served by the most
specific region:

    tier1: visited on >= 150 days  -> street level   (z13-15)
    all:   visited on >=   1 day   -> everywhere     (z9-12)

`pmtiles extract --region=<file>`, unlike `--bbox`, only pulls tiles near where
you actually go. The Protomaps build server resets long streams now and then, so
each extract is retried; `--download-threads` is raised well above the CLI's
default of 4, which throttles a ~190 MB extract down to a crawl.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

# --- configuration ---------------------------------------------------------

API = "http://127.0.0.1:8080"
PMTILES = "/Users/flo/Projects/pmtiles-demo/pmtiles"  # falls back to $PATH
TILES = Path("tiles")  # archives live here
REGIONS = TILES / "regions"  # generated GeoJSON lives here
CELL = 0.005  # grid cell size in degrees (~550 m)
BUFFER_KM = 0.5  # ribbon padding around the track
TIERS = "tier1:150:13:15,all:1:9:12"  # name:min_days:minzoom:maxzoom
DOWNLOAD_THREADS = 8
ATTEMPTS = 3
WORLD_MAXZOOM = 8
# Today's build. Pin a date here (or via ACTA_BUILD_URL) if it is throttled.
BUILD_URL = (
    os.environ.get("ACTA_BUILD_URL")
    or f"https://build.protomaps.com/{date.today():%Y%m%d}.pmtiles"
)

# --- end configuration -----------------------------------------------------

POINTS_SQL = """
SELECT coalesce(to_json(array_agg(struct_pack(lon := lon, lat := lat, d := d) ORDER BY ts)), '[]'::JSON)::VARCHAR
FROM (
  SELECT data.geometry.coordinates[1]::DOUBLE AS lon,
         data.geometry.coordinates[2]::DOUBLE AS lat,
         timestamp AS ts,
         CAST(CAST(timestamp AS TIMESTAMP) AS DATE)::VARCHAR AS d
  FROM events
  WHERE source = 'location_florian' AND data.geometry.type = 'Point'
)
"""

BBox = tuple[float, float, float, float]
Cell = tuple[int, int]


def pmtiles_binary() -> str:
    if Path(PMTILES).exists():
        return PMTILES
    return shutil.which("pmtiles") or "pmtiles"


def fetch_points() -> list[dict]:
    body = json.dumps({"sql": POINTS_SQL}).encode()
    request = urllib.request.Request(
        f"{API}/api/data", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        sys.exit(f"query failed ({error.code}): {error.read().decode(errors='replace')}")
    except urllib.error.URLError as error:
        sys.exit(f"could not reach {API}: {error.reason}. Is the service running?")


def build_cells(points: list[dict], size: float) -> dict[Cell, set[str]]:
    cells: dict[Cell, set[str]] = {}
    for point in points:
        key = (math.floor(point["lon"] / size), math.floor(point["lat"] / size))
        cells.setdefault(key, set()).add(point["d"])
    return cells


def parse_tiers(spec: str) -> list[tuple[str, int, int, int]]:
    """Parse `name:min_days:minzoom:maxzoom`."""
    tiers = []
    for item in spec.split(","):
        name, min_days, minzoom, maxzoom = item.split(":")
        tiers.append((name.strip(), int(min_days), int(minzoom), int(maxzoom)))
    return tiers


def pad_cells(buffer_km: float, cell_deg: float) -> int:
    """Buffer, rounded to whole grid cells. Padding is applied on the grid so
    the rectangles stay aligned and never overlap."""
    return max(0, round(buffer_km / (cell_deg * 111.32)))


def select_cells(cells: dict[Cell, set[str]], min_days: int, pad: int) -> set[Cell]:
    """Cells visited on at least `min_days`, dilated by `pad` cells."""
    selected = {key for key, days in cells.items() if len(days) >= min_days}
    if pad > 0:
        selected = {
            (x + dx, y + dy)
            for (x, y) in selected
            for dx in range(-pad, pad + 1)
            for dy in range(-pad, pad + 1)
        }
    return selected


def rectangles(selected: set[Cell], cell: float) -> list[BBox]:
    """Run-length encode the selected cells per row, so the region follows the
    track instead of wrapping it in one bounding box. That matters as soon as
    `min_days` is low enough that everything connects: a track is one giant
    cluster, and its bbox would cover half the continent."""
    rows: dict[int, list[int]] = {}
    for x, y in selected:
        rows.setdefault(y, []).append(x)

    out: list[BBox] = []
    for y, xs in rows.items():
        xs.sort()
        start = previous = xs[0]
        for x in xs[1:]:
            if x == previous + 1:
                previous = x
                continue
            out.append((start * cell, y * cell, (previous + 1) * cell, (y + 1) * cell))
            start = previous = x
        out.append((start * cell, y * cell, (previous + 1) * cell, (y + 1) * cell))
    return out


def covered(points: list[dict], size: float, selected: set[Cell]) -> tuple[int, int]:
    """Fixes inside the region, and the number of distinct days they span."""
    fixes = 0
    days: set[str] = set()
    for point in points:
        key = (math.floor(point["lon"] / size), math.floor(point["lat"] / size))
        if key in selected:
            fixes += 1
            days.add(point["d"])
    return fixes, len(days)


def area_km2(rects: list[BBox]) -> float:
    total = 0.0
    for x0, y0, x1, y1 in rects:
        mid_lat = (y0 + y1) / 2
        total += (x1 - x0) * 111.32 * math.cos(math.radians(mid_lat)) * (y1 - y0) * 111.32
    return total


def run_extract(
    binary: str, region: Path, name: str, minzoom: int, maxzoom: int, dry: bool
) -> bool:
    command = [
        binary, "extract", BUILD_URL, str(TILES / f"{name}.pmtiles"),
        f"--region={region}", f"--minzoom={minzoom}", f"--maxzoom={maxzoom}",
        f"--download-threads={DOWNLOAD_THREADS}",
    ]
    if dry:
        command.append("--dry-run")
    print(f"\n$ {' '.join(command)}", flush=True)
    try:
        subprocess.run(command, check=True)
        return True
    except subprocess.CalledProcessError as error:
        print(f"  failed (exit {error.returncode})", flush=True)
        return False


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("regions", help="write the regions and print the extract commands")
    download = commands.add_parser("download", help="write the regions, then build the archives")
    download.add_argument("--dry-run", action="store_true", help="size the extracts, download nothing")
    args = parser.parse_args()

    print(f"fetching fixes from {API} ...", flush=True)
    points = fetch_points()
    if not points:
        sys.exit("no fixes returned")
    total = len(points)
    total_days = len({p["d"] for p in points})
    cells = build_cells(points, CELL)
    pad = pad_cells(BUFFER_KM, CELL)
    print(f"{total:,} fixes on {total_days} distinct days, {len(cells):,} cells")
    print(f"grid {CELL} deg (~{CELL * 111.32:.2f} km), padding {pad} cell(s)\n")

    REGIONS.mkdir(parents=True, exist_ok=True)
    print(f"{'tier':<8}{'min_days':>9}{'rects':>8}{'area km2':>10}{'fixes':>8}{'days':>7}{'zoom':>9}")
    written: list[tuple[str, Path, int, int]] = []
    for name, min_days, minzoom, maxzoom in parse_tiers(TIERS):
        selected = select_cells(cells, min_days, pad)
        rects = rectangles(selected, CELL)
        region = REGIONS / f"{name}.geojson"
        region.write_text(
            json.dumps({
                "type": "FeatureCollection",
                "features": [{
                    "type": "Feature",
                    "properties": {"tier": name, "min_days": min_days},
                    "geometry": {
                        "type": "MultiPolygon",
                        "coordinates": [
                            [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]
                            for x0, y0, x1, y1 in rects
                        ],
                    },
                }],
            }, indent=2) + "\n"
        )
        fixes, days = covered(points, CELL, selected)
        print(f"{name:<8}{min_days:>9}{len(rects):>8}{area_km2(rects):>10.0f}"
              f"{100 * fixes / total:>7.0f}%{100 * days / total_days:>6.0f}%{f'{minzoom}-{maxzoom}':>9}")
        written.append((name, region, minzoom, maxzoom))

    binary = pmtiles_binary()
    print(f"\nregions written to {REGIONS}/")
    print("\nextract commands:")
    for name, region, minzoom, maxzoom in written:
        print(f"  {binary} extract {BUILD_URL} {TILES}/{name}.pmtiles --region={region} "
              f"--minzoom={minzoom} --maxzoom={maxzoom} --download-threads={DOWNLOAD_THREADS}")
    print(f"  {binary} extract {BUILD_URL} {TILES}/world.pmtiles --maxzoom={WORLD_MAXZOOM} "
          f"--download-threads={DOWNLOAD_THREADS}   # once, not part of download")

    if args.command != "download":
        return

    attempts = 1 if args.dry_run else ATTEMPTS
    print("\nrunning:")
    for name, region, minzoom, maxzoom in written:
        for attempt in range(1, attempts + 1):
            if attempt > 1:
                print(f"\nretrying {name}: the build server resets long streams now and then",
                      flush=True)
            if run_extract(binary, region, name, minzoom, maxzoom, args.dry_run):
                break
        else:
            sys.exit(f"\n{name}: giving up after {attempts} attempt(s)")
    print("\ndry run only; remove --dry-run to download" if args.dry_run else "\ndone")


if __name__ == "__main__":
    main()
