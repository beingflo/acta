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

Load-test mode ramps concurrency until throughput plateaus, then holds there,
reporting requests/s, rows/s and latency percentiles:

    mise run test:ingest --load --duration 60
    mise run test:ingest --load --load-batch 500 --load-max 64

Run `mise run test:ingest --help` for the flags mise exposes to completion.

Only the standard library is used, so no virtualenv is required.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import signal
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
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


# --- load-test mode ----------------------------------------------------------


def build_load_bodies(rng: random.Random, batch: int, count: int) -> list[tuple[bytes, int]]:
    """Pre-generate request bodies so request generation is not the bottleneck.

    Timestamps are omitted, so the service stamps arrival time and the bodies can
    be reused freely.
    """
    generators = [
        Co2Sensor(rng),
        LaundrySensor(rng),
        BrightnessBarometer(rng),
        Visitors(rng),
        Location(rng, 30.0),
        WideEvents(rng),
    ]
    bodies = []
    for _ in range(count):
        rows: list[dict] = []
        index = 0
        while len(rows) < batch:
            items = generators[index % len(generators)].tick()
            index += 1
            for item in items:
                rows.append({"source": item["source"], "data": item["data"]})
                if len(rows) >= batch:
                    break
        bodies.append((json.dumps(rows).encode(), len(rows)))
    return bodies


class AsyncGate:
    """Lets the controller change the number of active workers without restarting them."""

    def __init__(self) -> None:
        self._cond = asyncio.Condition()
        self._target = 1
        self._stopped = False

    async def set_target(self, target: int) -> None:
        async with self._cond:
            self._target = max(0, target)
            self._cond.notify_all()

    async def wait_turn(self, index: int) -> bool:
        async with self._cond:
            while not self._stopped and index >= self._target:
                await self._cond.wait()
            return not self._stopped

    async def stop(self) -> None:
        async with self._cond:
            self._stopped = True
            self._cond.notify_all()


class LoadMetrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._reset_interval()
        self.total_requests = 0
        self.total_rows = 0
        self.total_bytes = 0
        self.total_errors = 0

    def _reset_interval(self) -> None:
        self.requests = 0
        self.rows = 0
        self.nbytes = 0
        self.errors = 0
        self.latencies: list[float] = []

    def record_ok(self, rows: int, nbytes: int, latency: float) -> None:
        with self._lock:
            self.requests += 1
            self.rows += rows
            self.nbytes += nbytes
            self.latencies.append(latency)
            self.total_requests += 1
            self.total_rows += rows
            self.total_bytes += nbytes

    def record_err(self, latency: float) -> None:
        with self._lock:
            self.errors += 1
            self.latencies.append(latency)
            self.total_errors += 1

    def drain(self, dt: float) -> dict:
        with self._lock:
            requests, rows, nbytes, errors, latencies = (
                self.requests,
                self.rows,
                self.nbytes,
                self.errors,
                sorted(self.latencies),
            )
            self._reset_interval()
        return {
            "rps": requests / dt if dt > 0 else 0.0,
            "rows_s": rows / dt if dt > 0 else 0.0,
            "mb_s": (nbytes / dt / 1e6) if dt > 0 else 0.0,
            "err_rate": errors / max(requests + errors, 1),
            "errors": errors,
            "p50": percentile(latencies, 0.50),
            "p95": percentile(latencies, 0.95),
            "p99": percentile(latencies, 0.99),
        }

    def totals(self) -> dict:
        with self._lock:
            return {
                "requests": self.total_requests,
                "rows": self.total_rows,
                "mb": self.total_bytes / 1e6,
                "errors": self.total_errors,
            }


def percentile(sorted_values: list[float], q: float) -> float:
    if not sorted_values:
        return 0.0
    return sorted_values[min(len(sorted_values) - 1, int(q * len(sorted_values)))]


def fmt_ms(seconds: float) -> str:
    return f"{seconds * 1000:.1f}ms"


def print_load_line(elapsed: float, concurrency: int, rep: dict) -> None:
    print(
        f"[load] {elapsed:6.0f}s  conc={concurrency:3d}  {rep['rps']:9.1f} req/s  {rep['rows_s']:11.0f} rows/s  "
        f"{rep['mb_s']:6.2f} MB/s  p50={fmt_ms(rep['p50']):>8}  p95={fmt_ms(rep['p95']):>8}  "
        f"p99={fmt_ms(rep['p99']):>8}  err={rep['err_rate'] * 100:5.2f}%",
        flush=True,
    )


async def read_status(reader: asyncio.StreamReader) -> int:
    header = await reader.readuntil(b"\r\n\r\n")
    lines = header.decode("latin1").split("\r\n")
    status = int(lines[0].split(" ", 2)[1])
    length = 0
    chunked = False
    for line in lines[1:]:
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip()
        if key == "content-length":
            length = int(value)
        elif key == "transfer-encoding" and "chunked" in value.lower():
            chunked = True
    if chunked:
        while True:
            size = int((await reader.readuntil(b"\r\n")).strip(), 16)
            if size == 0:
                await reader.readuntil(b"\r\n")
                break
            await reader.readexactly(size + 2)
    elif length:
        await reader.readexactly(length)
    return status


async def load_worker(
    index: int,
    gate: AsyncGate,
    stop: asyncio.Event,
    host: str,
    port: int,
    path: str,
    host_header: str,
    bodies: list[tuple[bytes, int]],
    metrics: LoadMetrics,
    timeout: float,
    tls,
) -> None:
    rng = random.Random(index * 7919 + 13)
    reader = writer = None
    while not stop.is_set():
        if not await gate.wait_turn(index):
            return
        if writer is None:
            reader, writer = await asyncio.open_connection(host, port, ssl=tls)
        body, rows = rng.choice(bodies)
        request = (
            f"POST {path} HTTP/1.1\r\nHost: {host_header}\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: keep-alive\r\n\r\n"
        ).encode() + body
        started = time.perf_counter()
        try:
            writer.write(request)
            await writer.drain()
            status = await asyncio.wait_for(read_status(reader), timeout)
            latency = time.perf_counter() - started
            if status == 202:
                metrics.record_ok(rows, len(body), latency)
            else:
                metrics.record_err(latency)
        except Exception:  # noqa: BLE001 - a load test keeps going through failures
            metrics.record_err(time.perf_counter() - started)
            if writer is not None:
                try:
                    writer.close()
                except Exception:  # noqa: BLE001
                    pass
            reader = writer = None
            await asyncio.sleep(0.05)
    if writer is not None:
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


async def load_main(args: argparse.Namespace) -> int:
    endpoint = args.url.rstrip("/") + "/api/ingest"
    parsed = urllib.parse.urlsplit(endpoint)
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    host_header = parsed.netloc or host
    tls = ssl.create_default_context() if parsed.scheme == "https" else None

    rng = random.Random(args.seed)
    bodies = build_load_bodies(rng, max(1, args.load_batch), max(1, args.load_bodies))

    metrics = LoadMetrics()
    gate = AsyncGate()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass

    workers = [
        asyncio.create_task(
            load_worker(
                index,
                gate,
                stop,
                host,
                port,
                path,
                host_header,
                bodies,
                metrics,
                args.load_timeout,
                tls,
            )
        )
        for index in range(max(1, args.load_max))
    ]

    concurrency = max(1, args.load_start)
    await gate.set_target(concurrency)
    interval = args.load_interval
    peak_rps = 0.0  # smoothed throughput at the best concurrency
    peak_raw = 0.0  # best single-interval throughput, for the summary
    best_concurrency = concurrency
    ema = 0.0
    plateau = 0
    warmup = 1  # the first interval includes connection setup; do not trust it
    phase = "ramp"
    started = time.monotonic()
    deadline = started + args.duration if args.duration else None

    def ramp_up(current: int) -> int:
        return min(args.load_max, max(current + 1, int(current * args.load_step)))

    print(
        f"[load] {endpoint}  batch={args.load_batch} rows  bodies={len(bodies)}  "
        f"conc={args.load_start}..{args.load_max}  Ctrl-C to stop",
        flush=True,
    )

    try:
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval)
                break
            except asyncio.TimeoutError:
                pass
            report = metrics.drain(interval)
            print_load_line(time.monotonic() - started, concurrency, report)

            peak_raw = max(peak_raw, report["rps"])
            ema = report["rps"] if ema == 0.0 else 0.5 * report["rps"] + 0.5 * ema

            if report["err_rate"] > args.load_error_threshold:
                phase, plateau = "ramp", 0
                concurrency = max(1, int(concurrency * 0.7))
            elif warmup:
                warmup -= 1
                concurrency = ramp_up(concurrency)
            elif phase == "ramp":
                if ema > peak_rps * 1.05:
                    peak_rps, best_concurrency, plateau = ema, concurrency, 0
                    concurrency = ramp_up(concurrency)
                else:
                    plateau += 1
                    if plateau >= args.load_plateau:
                        phase = "hold"
                        concurrency = best_concurrency
                        print(
                            f"[load] throughput plateaued; holding ~{peak_rps:.0f} req/s at conc {best_concurrency}",
                            flush=True,
                        )
                    else:
                        concurrency = ramp_up(concurrency)
            await gate.set_target(concurrency)

            if deadline and time.monotonic() >= deadline:
                break
    finally:
        await gate.stop()
        _, pending = await asyncio.wait(workers, timeout=2)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    totals = metrics.totals()
    minutes = (time.monotonic() - started) / 60
    errors = totals["errors"]
    error_rate = errors / max(totals["requests"] + errors, 1) * 100
    print(
        f"[load] stopped after {minutes:.1f} min: sustained ~{peak_rps:.0f} req/s at conc {best_concurrency} "
        f"(peak {peak_raw:.0f}); totals {totals['requests']} requests, {totals['rows']} rows, "
        f"{totals['mb']:.1f} MB, {errors} errors ({error_rate:.3f}%)",
        flush=True,
    )
    return 0


def run_load(args: argparse.Namespace) -> int:
    try:
        return asyncio.run(load_main(args))
    except KeyboardInterrupt:
        return 130


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
    parser.add_argument(
        "--load",
        action="store_true",
        help="load-test mode: ramp concurrency until throughput plateaus, then hold",
    )
    parser.add_argument("--load-batch", type=int, default=200, help="rows per request in load mode")
    parser.add_argument("--load-bodies", type=int, default=32, help="number of pre-generated request bodies")
    parser.add_argument("--load-start", type=int, default=2, help="initial concurrency in load mode")
    parser.add_argument("--load-max", type=int, default=128, help="maximum concurrency in load mode")
    parser.add_argument("--load-step", type=float, default=1.5, help="concurrency multiplier per ramp step")
    parser.add_argument("--load-interval", type=float, default=3.0, help="control and report interval, seconds")
    parser.add_argument(
        "--load-plateau",
        type=int,
        default=3,
        help="non-improving intervals before load mode holds the sustained rate",
    )
    parser.add_argument(
        "--load-error-threshold",
        type=float,
        default=0.02,
        help="error rate that triggers backoff in load mode",
    )
    parser.add_argument("--load-timeout", type=float, default=30.0, help="per-request socket timeout, seconds")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.load:
        return run_load(args)
    return run_realistic(args)


def run_realistic(args: argparse.Namespace) -> int:
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
