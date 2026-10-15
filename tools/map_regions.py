#!/usr/bin/env python3
"""Derive PMTiles extract regions from the location data.

High-zoom basemap tiles are expensive, so we only want them where the fixes
actually are. This reads every fix from the service, scores a grid by how many
*distinct days* each cell is visited (fix counts over-weight movement, and the
`speed` property is mostly -1), groups qualifying cells into clusters, and
writes one padded rectangle per cluster as a GeoJSON MultiPolygon.

Each tier is a `min_days` threshold with a suggested `--maxzoom`, so regular
places get deep detail while occasional ones stay coarse:

    tier1: visited on >= 150 days  -> street level   (z13-15)
    tier2: visited on >=  20 days  -> neighbourhood  (z11-12)
    tier3: visited on >=   3 days  -> town           (z9-10)

The zoom bands are disjoint and the regions nested, so each band is served by the
most specific tier: a place visited daily gets street detail, one passed through
twice a year stays coarse. The regions are meant for
`pmtiles extract --region=<file>`, which, unlike `--bbox`, only pulls tiles near
where you actually go.

Examples:

    # write regions to tiles/regions/ and print the extract commands
    python3 tools/map_regions.py

    # size each extract (tile counts) without downloading
    python3 tools/map_regions.py --dry-run

    # actually produce the archives (needs network + the pmtiles CLI)
    python3 tools/map_regions.py --run
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

DEFAULT_TIERS = "tier1:150:13:15,tier2:20:11:12,tier3:3:9:10"
WORLD_MAXZOOM = 8

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


def fetch_points(api: str) -> list[dict]:
    body = json.dumps({"sql": POINTS_SQL}).encode()
    request = urllib.request.Request(
        f"{api}/api/data", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        sys.exit(f"query failed ({error.code}): {error.read().decode(errors='replace')}")
    except urllib.error.URLError as error:
        sys.exit(f"could not reach {api}: {error.reason}. Is the service running?")


def build_cells(points: list[dict], size: float) -> dict[tuple[int, int], dict]:
    cells: dict[tuple[int, int], dict] = {}
    for point in points:
        key = (math.floor(point["lon"] / size), math.floor(point["lat"] / size))
        cell = cells.setdefault(key, {"days": set(), "points": []})
        cell["days"].add(point["d"])
        cell["points"].append((point["lon"], point["lat"]))
    return cells


def components(cells: set[tuple[int, int]]) -> list[set[tuple[int, int]]]:
    """8-connected groups of cells."""
    remaining = set(cells)
    groups = []
    while remaining:
        seed = remaining.pop()
        group = {seed}
        stack = [seed]
        while stack:
            x, y = stack.pop()
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    neighbour = (x + dx, y + dy)
                    if neighbour in remaining:
                        remaining.discard(neighbour)
                        group.add(neighbour)
                        stack.append(neighbour)
        groups.append(group)
    return groups


def pad(bbox: BBox, km: float) -> BBox:
    x0, y0, x1, y1 = bbox
    mid_lat = (y0 + y1) / 2
    d_lat = km / 111.32
    d_lon = km / (111.32 * math.cos(math.radians(mid_lat)))
    return (x0 - d_lon, y0 - d_lat, x1 + d_lon, y1 + d_lat)


def rectangle(x0: float, y0: float, x1: float, y1: float) -> list:
    return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]


def tier_regions(cells: dict[tuple[int, int], dict], min_days: int, buffer_km: float) -> list[BBox]:
    """One padded rectangle per cluster of cells visited on at least `min_days`."""
    selected = {key for key, cell in cells.items() if len(cell["days"]) >= min_days}
    rectangles = []
    for group in components(selected):
        points = [p for key in group for p in cells[key]["points"]]
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        rectangles.append(pad((min(xs), min(ys), max(xs), max(ys)), buffer_km))
    return rectangles


def parse_tiers(spec: str) -> list[tuple[str, int, int, int]]:
    """Parse `name:min_days:minzoom:maxzoom` (minzoom may be omitted)."""
    tiers = []
    for item in spec.split(","):
        fields = item.split(":")
        if len(fields) == 4:
            name, min_days, minzoom, maxzoom = fields
        else:
            name, min_days, maxzoom = fields
            minzoom = str(WORLD_MAXZOOM + 1)
        tiers.append((name.strip(), int(min_days), int(minzoom), int(maxzoom)))
    return tiers


def covered(points: list[dict], rectangles: list[BBox]) -> tuple[int, int]:
    fixes = 0
    days: set[str] = set()
    for point in points:
        if any(x0 <= point["lon"] <= x1 and y0 <= point["lat"] <= y1 for x0, y0, x1, y1 in rectangles):
            fixes += 1
            days.add(point["d"])
    return fixes, len(days)


def area_km2(rectangles: list[BBox]) -> float:
    total = 0.0
    for x0, y0, x1, y1 in rectangles:
        mid_lat = (y0 + y1) / 2
        total += (x1 - x0) * 111.32 * math.cos(math.radians(mid_lat)) * (y1 - y0) * 111.32
    return total


def run_extract(
    pmtiles: str, source: str, target: Path, region: Path | None, minzoom: int, maxzoom: int, dry: bool
):
    command = [pmtiles, "extract", source, str(target)]
    if region is not None:
        command.append(f"--region={region}")
        command.append(f"--minzoom={minzoom}")
    command.append(f"--maxzoom={maxzoom}")
    if dry:
        command.append("--dry-run")
    print(f"\n$ {' '.join(command)}", flush=True)
    subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--api", default="http://127.0.0.1:8080", help="service base URL")
    parser.add_argument("--out", default="tiles/regions", help="where to write GeoJSON regions")
    parser.add_argument("--cell", type=float, default=0.02, help="grid cell size in degrees (~2.2 km)")
    parser.add_argument("--buffer-km", type=float, default=2.0, help="padding around each cluster")
    parser.add_argument("--tiers", default=DEFAULT_TIERS, help="name:min_days:minzoom:maxzoom,...")
    parser.add_argument(
        "--build-url",
        default=f"https://build.protomaps.com/{date.today():%Y%m%d}.pmtiles",
        help="input archive for the extracts",
    )
    parser.add_argument("--pmtiles", default="pmtiles", help="pmtiles CLI binary")
    parser.add_argument("--dry-run", action="store_true", help="size the extracts without downloading")
    parser.add_argument("--run", action="store_true", help="produce the archives")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    print(f"fetching fixes from {args.api} ...", flush=True)
    points = fetch_points(args.api)
    if not points:
        sys.exit("no fixes returned")
    total = len(points)
    total_days = len({p["d"] for p in points})
    cells = build_cells(points, args.cell)
    print(f"{total:,} fixes on {total_days} distinct days, {len(cells):,} cells\n")

    tiers = parse_tiers(args.tiers)
    print(f"{'tier':<8}{'min_days':>9}{'clusters':>10}{'area km2':>10}{'fixes':>8}{'days':>7}{'zoom':>9}")
    written: list[tuple[str, Path, int, int]] = []
    for name, min_days, minzoom, maxzoom in tiers:
        rectangles = tier_regions(cells, min_days, args.buffer_km)
        region = out / f"{name}.geojson"
        region.write_text(json.dumps({
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "properties": {"tier": name, "min_days": min_days},
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [rectangle(*r) for r in rectangles],
                },
            }],
        }, indent=2) + "\n")

        fixes, days = covered(points, rectangles)
        print(f"{name:<8}{min_days:>9}{len(rectangles):>10}{area_km2(rectangles):>10.0f}"
              f"{100*fixes/total:>7.0f}%{100*days/total_days:>6.0f}%{f'{minzoom}-{maxzoom}':>9}")
        written.append((name, region, minzoom, maxzoom))

    print(f"\nregions written to {out}/")
    print("\nextract commands:")
    print(f"  $ {args.pmtiles} extract {args.build_url} tiles/world.pmtiles --maxzoom={WORLD_MAXZOOM}")
    for name, region, minzoom, maxzoom in written:
        print(f"  $ {args.pmtiles} extract {args.build_url} tiles/{name}.pmtiles "
              f"--region={region} --minzoom={minzoom} --maxzoom={maxzoom}")

    if args.dry_run or args.run:
        print("\nrunning:")
        for name, region, minzoom, maxzoom in written:
            run_extract(args.pmtiles, args.build_url, Path("tiles") / f"{name}.pmtiles",
                        region, minzoom, maxzoom, args.dry_run)
        print("\ndone" if args.run else "\ndry run only; pass --run to download")


if __name__ == "__main__":
    main()
