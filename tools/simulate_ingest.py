#!/usr/bin/env python3
"""Continuously send simulated readings for every acta data source.

The service is expected to be running. Each source is generated on its own
cadence with plausible values and pushed as a `POST /api/ingest` batch, so a run
exercises the whole write path: validation, buffering, flushes, and tier
compaction. Let it run for an hour or more to watch hot files fold into hourly
files (and a day or more for daily files).

    mise run test:ingest
    ACTA_URL=http://host:8080 mise run test:ingest
    mise run test:ingest --fast              # 10x faster cadence
    mise run test:ingest --duration 120      # stop after two minutes

Run `mise run test:ingest --help` for the flags mise exposes to completion.

Only the standard library is used, so no virtualenv is required.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

# --- shapes modelled on the migrated data -----------------------------------

CO2 = "co2-sensor-living-room"
LAUNDRY = "humidity-laundry-room"
BRIGHTNESS = "brightness-barometer-living-room"
VISITORS = "heuried-visitors"
LOCATION = "location_florian"
MARENDING = "marending"

USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
]

PATHS = [
    "/",
    "/robots.txt",
    "/rss.xml",
    "/favicon.svg",
    "/feedback/",
    "/notes/",
    "/notes/esp-power/",
    "/notes/visual-testing/",
    "/notes/rest-quest",
    "/notes/16-hour-projects",
    "/_astro/global.NnsOTZ7b.css",
    "/_astro/hoisted.B3Rc1K2d.js",
    "/api/healthz",
]

METHODS = ["GET"] * 90 + ["HEAD"] * 5 + ["POST"] * 4 + ["OPTIONS"] * 1


def utc_now(offset_s: float = 0.0) -> datetime:
    return datetime.now(timezone.utc) + timedelta(seconds=offset_s)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


# --- per-source generators ---------------------------------------------------


class Co2Sensor:
    """Living-room CO2/temperature/humidity, roughly one reading per 20 s."""

    def __init__(self, rng: random.Random):
        self.rng = rng
        self.co2 = 700.0
        self.temperature = 21.4
        self.humidity = 55.0

    def tick(self) -> list[dict]:
        r = self.rng
        self.co2 = clamp(self.co2 + r.gauss(6, 12), 400, 1500)
        if r.random() < 0.015:  # a window was opened
            self.co2 = clamp(self.co2 - r.uniform(150, 350), 400, 1500)
        self.temperature = clamp(self.temperature + r.gauss(0, 0.04), 20.4, 22.6)
        self.humidity = clamp(self.humidity + r.gauss(0, 0.25), 38, 72)
        # sensors occasionally report a little late
        offset = r.choice([0.0, 0.0, 0.0, -r.uniform(1, 25)])
        return [
            {
                "source": CO2,
                "timestamp": iso(utc_now(offset)),
                "data": {
                    "co2": int(round(self.co2)),
                    "humidity": round(self.humidity, 2),
                    "temperature": round(self.temperature, 2),
                },
            }
        ]


class LaundrySensor:
    """Laundry-room humidity/temperature, one reading every 30 s or so."""

    def __init__(self, rng: random.Random):
        self.rng = rng
        self.humidity = 58.0
        self.temperature = 20.3

    def tick(self) -> list[dict]:
        r = self.rng
        self.humidity = clamp(self.humidity + r.gauss(0, 0.3), 42, 78)
        self.temperature = clamp(self.temperature + r.gauss(0, 0.05), 18.5, 23.0)
        if r.random() < 0.01:  # laundry day
            self.humidity = clamp(self.humidity + r.uniform(5, 12), 42, 90)
        return [
            {
                "source": LAUNDRY,
                "timestamp": iso(utc_now(r.choice([0.0, 0.0, -r.uniform(1, 20)]))),
                "data": {
                    "humidity": round(self.humidity, 2),
                    "temperature": round(self.temperature, 2),
                },
            }
        ]


class BrightnessBarometer:
    """Lux, pressure and temperature, one reading per minute or so."""

    def __init__(self, rng: random.Random):
        self.rng = rng
        self.temperature = 21.4
        self.pressure = 1013.0
        self.absolute_pressure = 97_750.0
        self.cloud = 0.7

    def tick(self) -> list[dict]:
        r = self.rng
        self.temperature = clamp(self.temperature + r.gauss(0, 0.03), 20.5, 22.6)
        self.pressure = clamp(self.pressure + r.gauss(0, 0.06), 985, 1035)
        self.absolute_pressure = clamp(
            self.absolute_pressure + r.gauss(0, 8), 96_000, 99_500
        )
        self.cloud = clamp(self.cloud + r.gauss(0, 0.03), 0.05, 1.0)

        # daylight roughly 06:30..20:00 local, dimmed by a slowly drifting cloud cover
        hour = utc_now().astimezone().hour + utc_now().astimezone().minute / 60
        day = math.sin(math.pi * clamp((hour - 6.5) / 13.0, 0.0, 1.0))
        lux = max(-1.0, 50_000 * max(0.0, day) * self.cloud + r.gauss(0, 20))
        if day <= 0:
            lux = max(-1.0, r.gauss(0, 0.6))

        return [
            {
                "source": BRIGHTNESS,
                "timestamp": iso(utc_now(r.choice([0.0, 0.0, -r.uniform(1, 30)]))),
                "data": {
                    "absolute_pressure": round(self.absolute_pressure, 2),
                    "lux": round(lux, 2),
                    "pressure": round(self.pressure, 2),
                    "temperature": round(self.temperature, 2),
                },
            }
        ]


class Visitors:
    """Heuried visitor count, a slowly moving number reported every ~10 min."""

    def __init__(self, rng: random.Random):
        self.rng = rng
        self.value = 50.0

    def tick(self) -> list[dict]:
        r = self.rng
        hour = utc_now().astimezone().hour
        day = math.sin(math.pi * clamp((hour - 7) / 13.0, 0.0, 1.0)) if 7 <= hour <= 20 else 0.0
        target = 15 + 120 * day
        self.value += (target - self.value) * 0.15 + r.gauss(0, 4)
        if r.random() < 0.002:  # an event
            self.value += r.uniform(200, 1200)
        self.value = clamp(self.value, 0, 2500)
        return [
            {"source": VISITORS, "timestamp": iso(utc_now()), "data": int(round(self.value))}
        ]


class Location:
    """A GeoJSON Feature per position fix, with occasional trip summaries."""

    SPEEDS = {"stationary": 0.0, "walking": 1.4, "cycling": 5.5}

    def __init__(self, rng: random.Random, interval_s: float):
        self.rng = rng
        self.interval_s = interval_s
        self.lon, self.lat = 8.5094, 47.3676  # Heuried, Zurich
        self.heading = rng.uniform(0, 2 * math.pi)
        self.mode = "stationary"
        self.battery = 0.9
        self.push = 0
        self.trip: list[tuple] = []

    def tick(self) -> list[dict]:
        r = self.rng
        self._maybe_change_mode()

        speed = self.SPEEDS[self.mode] * r.uniform(0.7, 1.3)
        self.heading += r.gauss(0, 0.35 if self.mode != "stationary" else 0.02)
        distance = speed * self.interval_s
        self.lat += (distance * math.cos(self.heading)) / 111_320.0
        self.lon += (distance * math.sin(self.heading)) / (
            111_320.0 * math.cos(math.radians(self.lat))
        )

        if self.mode == "stationary":
            self.battery = clamp(self.battery + 0.0006, 0.05, 1.0)
        else:
            self.battery = clamp(self.battery - 0.0009 * speed, 0.05, 1.0)

        stamp = utc_now()
        fix = self._point(stamp)
        items = [{"source": LOCATION, "timestamp": iso(stamp), "data": fix}]

        if self.mode != "stationary":
            self.trip.append((stamp, self.lon, self.lat))
        elif self.trip:
            items.append(self._trip_item())
            self.trip = []
        return items

    def _maybe_change_mode(self) -> None:
        r = self.rng
        if self.mode == "stationary" and r.random() < 0.02:
            self.mode = "walking" if r.random() < 0.7 else "cycling"
            self.trip = [(utc_now(), self.lon, self.lat)]
        elif self.mode != "stationary" and r.random() < 0.03:
            self.mode = "stationary"

    def _point(self, stamp: datetime) -> dict:
        r = self.rng
        moving = self.mode != "stationary"
        return {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [round(self.lon, 7), round(self.lat, 7)],
            },
            "properties": {
                "altitude": int(round(420 + r.gauss(0, 6))),
                "battery_level": round(self.battery, 2),
                "battery_state": "unplugged" if moving else "charging",
                "course": round(math.degrees(self.heading) % 360, 1) if moving else -1,
                "course_accuracy": r.choice([-1, 20, 45, 90]),
                "horizontal_accuracy": r.choice([5, 10, 18, 35, 65]),
                "motion": [] if moving else ["stationary"],
                "speed": round(self.SPEEDS[self.mode], 2),
                "speed_accuracy": round(r.uniform(0.5, 2.5), 2),
                "timestamp": iso(stamp),
                "vertical_accuracy": r.choice([3, 8, 18, 30]),
                "wifi": "IP a lot" if not moving else "IP a lot_EXT",
            },
        }

    def _trip_item(self) -> dict:
        r = self.rng
        started, lon0, lat0 = self.trip[0]
        ended = utc_now()
        duration = max((ended - started).total_seconds(), 1.0)
        distance = haversine_m(lon0, lat0, self.lon, self.lat) * r.uniform(1.0, 1.4)
        start_location = self._point_at(started, lon0, lat0)
        end_location = self._point_at(ended, self.lon, self.lat)
        return {
            "source": LOCATION,
            "timestamp": iso(ended),
            "data": {
                "type": "Feature",
                "geometry": end_location["geometry"],
                "properties": {
                    "battery_level": round(self.battery, 2),
                    "battery_state": "unplugged",
                    "distance": round(distance, 2),
                    "duration": round(duration, 3),
                    "end": iso(ended),
                    "end_location": end_location,
                    "mode": self.mode,
                    "start": iso(started),
                    "start_location": start_location,
                    "steps": 0,
                    "stopped_automatically": False,
                    "timestamp": iso(ended),
                    "type": "trip",
                    "wifi": "",
                },
            },
        }

    def _point_at(self, stamp: datetime, lon: float, lat: float) -> dict:
        point = self._point(stamp)
        point["geometry"]["coordinates"] = [round(lon, 7), round(lat, 7)]
        return point


class WideEvents:
    """Bursts of HTTP request events, as a web service would batch them."""

    def __init__(self, rng: random.Random):
        self.rng = rng

    def tick(self) -> list[dict]:
        r = self.rng
        size = max(0, int(r.gauss(6, 4)))
        now = utc_now()
        items = []
        for _ in range(size):
            method = r.choice(METHODS)
            path = r.choice(PATHS)
            bot = r.random() < 0.55
            status = self._status(r, method, path, bot)
            latency = int(r.lognormvariate(11.5, 1.1))
            data = {
                "method": method,
                "uri": path,
                "user_agent": r.choice(USER_AGENTS),
                "referrer": r.choice(["", "", "", "https://www.google.com/", "https://marending.dev/"]),
                "status": status,
                "latency_ns": latency,
            }
            if status >= 500:
                data["errors"] = [
                    {"event": "error", "error": r.choice(["connection reset", "timeout", "upstream 502"])}
                ]
            items.append(
                {
                    "source": MARENDING,
                    "timestamp": iso(now - timedelta(seconds=r.uniform(0, 3))),
                    "data": data,
                }
            )
        return items

    @staticmethod
    def _status(r: random.Random, method: str, path: str, bot: bool) -> int:
        if bot and path in ("/", "/robots.txt"):
            return r.choice([200, 200, 404, 404, 405, 429])
        if r.random() < 0.02:
            return 500
        return r.choices(
            [200, 304, 307, 404, 405, 206, 416],
            weights=[70, 8, 12, 5, 3, 1, 1],
        )[0]


# --- transport ---------------------------------------------------------------


class Stats:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.sent = 0
        self.errors = 0
        self.per_source: dict[str, int] = {}
        self.started = time.monotonic()

    def ok(self, source: str, count: int) -> None:
        with self.lock:
            self.sent += count
            self.per_source[source] = self.per_source.get(source, 0) + count

    def failed(self) -> None:
        with self.lock:
            self.errors += 1

    def snapshot(self) -> tuple[int, int, dict[str, int]]:
        with self.lock:
            return self.sent, self.errors, dict(self.per_source)


def send(endpoint: str, items: list[dict], stats: Stats, source: str) -> None:
    global _last_warning
    if not items:
        return
    body = json.dumps(items).encode()
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            response.read()
        stats.ok(source, len(items))
    except Exception as error:  # noqa: BLE001 - keep simulating through any failure
        stats.failed()
        now = time.monotonic()
        if now - _last_warning > 5:
            _last_warning = now
            print(f"[ingest] {source}: {error}", file=sys.stderr, flush=True)


_last_warning = 0.0


def run_source(
    name: str,
    interval: float,
    producer,
    endpoint: str,
    stats: Stats,
    stop: threading.Event,
) -> None:
    # Stagger sources so their bursts do not line up.
    stop.wait(random.uniform(0, min(interval, 5.0)))
    while not stop.is_set():
        send(endpoint, producer.tick(), stats, name)
        stop.wait(interval * random.uniform(0.9, 1.1))


def report(stats: Stats, stop: threading.Event) -> None:
    last_sent = 0
    last_time = time.monotonic()
    while not stop.wait(30):
        sent, errors, per_source = stats.snapshot()
        now = time.monotonic()
        rate = (sent - last_sent) / max(now - last_time, 1e-9) * 60
        last_sent, last_time = sent, now
        detail = " ".join(f"{key}={value}" for key, value in sorted(per_source.items()))
        print(f"[ingest] {rate:6.1f} rows/min  sent={sent} errors={errors} {detail}", flush=True)


# --- entry point -------------------------------------------------------------


def build_sources(rng: random.Random, scale: float) -> list[tuple[str, float, object]]:
    location_interval = 30.0 * scale
    return [
        (CO2, 20.0 * scale, Co2Sensor(rng)),
        (LAUNDRY, 30.0 * scale, LaundrySensor(rng)),
        (BRIGHTNESS, 60.0 * scale, BrightnessBarometer(rng)),
        (VISITORS, 600.0 * scale, Visitors(rng)),
        (LOCATION, location_interval, Location(rng, location_interval)),
        (MARENDING, 20.0 * scale, WideEvents(rng)),
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--url",
        default=os.environ.get("ACTA_URL", "http://127.0.0.1:8080"),
        help="base URL of a running service (default: ACTA_URL or http://127.0.0.1:8080)",
    )
    parser.add_argument("--fast", action="store_true", help="run with a 10x faster cadence")
    parser.add_argument("--scale", type=float, default=None, help="cadence multiplier (0.1 = 10x faster)")
    parser.add_argument("--duration", type=float, default=0.0, help="stop after this many seconds (0 = forever)")
    parser.add_argument("--seed", type=int, default=None, help="seed the RNG for repeatable output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    scale = args.scale if args.scale is not None else (0.1 if args.fast else 1.0)
    endpoint = args.url.rstrip("/") + "/api/ingest"

    rng = random.Random(args.seed)
    stats = Stats()
    stop = threading.Event()

    signal.signal(signal.SIGTERM, lambda *_: stop.set())

    threads = [
        threading.Thread(
            target=run_source,
            args=(name, interval, producer, endpoint, stats, stop),
            name=name,
            daemon=True,
        )
        for name, interval, producer in build_sources(rng, scale)
    ]
    for thread in threads:
        thread.start()
    reporter = threading.Thread(target=report, args=(stats, stop), daemon=True)
    reporter.start()

    print(f"[ingest] sending to {endpoint} (scale={scale:g}); Ctrl-C to stop", flush=True)
    deadline = time.monotonic() + args.duration if args.duration else None
    try:
        while not stop.wait(0.5):
            if deadline and time.monotonic() >= deadline:
                break
    except KeyboardInterrupt:
        pass

    stop.set()
    for thread in threads:
        thread.join(timeout=2)
    reporter.join(timeout=1)

    sent, errors, per_source = stats.snapshot()
    minutes = (time.monotonic() - stats.started) / 60
    detail = " ".join(f"{key}={value}" for key, value in sorted(per_source.items()))
    print(
        f"[ingest] stopped after {minutes:.1f} min: sent={sent} "
        f"({sent / max(minutes, 1e-9):.1f} rows/min) errors={errors} {detail}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
