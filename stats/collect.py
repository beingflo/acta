#!/usr/bin/env python3
"""Sample eos and push one reading into acta.

Installed on the server by `mise run stats:install` and run every 10 s by
`acta-stats.timer`. Each run reads the host's gauges from /proc and /sys,
derives CPU and network rates from the counters the previous run left in its
state file, and posts the result to `POST /api/ingest` as the source
`eos-stats`.

Reading /proc is nearly free; `podman stats` is not — it spawns podman and asks
every container's cgroup — so containers ride along on every sixth sample, and
the rows in between leave them out.

Standard library only, so it runs on a stock Asahi install with nothing to
install first.

    stats/collect.py --dry-run
    ACTA_URL=https://acta.example ACTA_AUTH=user:pass stats/collect.py

Everything is read defensively: a file this machine does not have (no battery
on a desktop, no thermal zones in a VM) becomes `null` in the payload instead
of an error, so the collector keeps reporting whatever else it can see.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Filesystems worth reporting: real ones. tmpfs, overlay and friends change per
# boot and say nothing about the disk filling up.
FILESYSTEMS = {"btrfs", "ext4", "xfs", "vfat", "f2fs"}

# How often `podman stats` is worth its process spawn. The host gauges are plain
# file reads and go out on every sample; containers do not.
CONTAINER_INTERVAL_S = 60

# podman stats formats memory as "12.4MB / 16GB", so both spellings of a byte
# prefix have to be understood.
SIZES = {
    "B": 1,
    "kB": 1e3,
    "MB": 1e6,
    "GB": 1e9,
    "TB": 1e12,
    "KiB": 1024,
    "MiB": 1024**2,
    "GiB": 1024**3,
    "TiB": 1024**4,
}

BASE_URL = os.environ.get("ACTA_URL", "http://127.0.0.1:8080").rstrip("/")
SOURCE = os.environ.get("ACTA_STATS_SOURCE", "eos-stats")
STATE_PATH = Path(
    os.environ.get("ACTA_STATS_STATE")
    or Path(os.environ.get("XDG_RUNTIME_DIR", f"/tmp/acta-stats-{os.getuid()}")) / "state.json"
)

# The credential pair, cached next to the counters. Never written outside the
# runtime directory, which is tmpfs: a reboot re-reads the podman secrets.
CREDENTIALS_PATH = STATE_PATH.parent / "credentials.json"


# --- remote helpers ---------------------------------------------------------


def slurp(path: str) -> str | None:
    """Contents of a /proc or /sys file, or None when this machine lacks it."""
    try:
        return Path(path).read_text()
    except OSError:
        return None


def percent(part: float, whole: float) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


def number(text: str) -> float | None:
    """`12.3%` -> 12.3."""
    try:
        return float(text.strip().rstrip("%"))
    except ValueError:
        return None


def size_mb(text: str) -> float | None:
    """`12.3MB` -> 11.7, i.e. the same figure in MiB."""
    stripped = text.strip()
    digits = len(stripped) - len(stripped.lstrip("0123456789."))
    try:
        return round(float(stripped[:digits]) * SIZES[stripped[digits:]] / 1024**2, 1)
    except (ValueError, KeyError):
        return None


# --- the host ---------------------------------------------------------------


def cpu_totals() -> tuple[int, int]:
    """Total and idle jiffies since boot, the pair every CPU rate needs."""
    fields = (slurp("/proc/stat") or "").splitlines()[:1]
    values = [int(field) for field in fields[0].split()[1:9]] if fields else []
    if len(values) < 5:  # not Linux, or an unexpected /proc
        return 0, 0
    return sum(values), values[3] + values[4]  # idle + iowait


def net_totals() -> tuple[int, int]:
    """Received and transmitted bytes over every interface but loopback."""
    received = sent = 0
    for line in (slurp("/proc/net/dev") or "").splitlines()[2:]:
        name, _, stats = line.partition(":")
        fields = stats.split()
        if name.strip() == "lo" or len(fields) < 9:
            continue
        received += int(fields[0])
        sent += int(fields[8])
    return received, sent


def memory() -> dict:
    """/proc/meminfo as the three figures a memory chart needs, in MiB."""
    info: dict[str, int] = {}
    for line in (slurp("/proc/meminfo") or "").splitlines():
        name, _, rest = line.partition(":")
        fields = rest.split()
        if fields:
            info[name] = int(fields[0])  # kB, i.e. KiB
    total = info.get("MemTotal", 0)
    used = total - info.get("MemAvailable", info.get("MemFree", 0))
    return {
        "total_mb": round(total / 1024, 1),
        "used_mb": round(used / 1024, 1),
        "used_pct": percent(used, total),
    }


def disks() -> dict:
    """Used and free space per mounted filesystem, plus the fullest one."""
    mounts: dict[str, dict] = {}
    fullest_pct, fullest_mount = 0.0, None
    for line in (slurp("/proc/self/mounts") or "").splitlines():
        fields = line.split()
        if len(fields) < 3 or fields[2] not in FILESYSTEMS:
            continue
        mount = fields[1].replace("\\040", " ")  # spaces are escaped in mounts
        try:
            stat = os.statvfs(mount)
        except OSError:
            continue
        total = stat.f_blocks * stat.f_frsize
        free = stat.f_bavail * stat.f_frsize  # what an unprivileged user may use
        used = total - stat.f_bfree * stat.f_frsize
        entry = {
            "mount": mount,
            "used_gb": round(used / 1024**3, 2),
            "total_gb": round(total / 1024**3, 2),
            "used_pct": percent(used, used + free),
        }
        mounts["root" if mount == "/" else mount.strip("/").replace("/", "-")] = entry
        if entry["used_pct"] > fullest_pct:
            fullest_pct, fullest_mount = entry["used_pct"], mount
    return {"mounts": mounts, "fullest_pct": fullest_pct, "fullest": fullest_mount}


def battery() -> dict | None:
    """The first battery the kernel reports, with Asahi's macsmc fields."""
    for supply in sorted(Path("/sys/class/power_supply").glob("*")):
        if (slurp(str(supply / "type")) or "").strip() != "Battery":
            continue

        def value(name: str, scale: float = 1) -> float | None:
            try:
                raw = (slurp(str(supply / name)) or "").strip()
                return round(float(raw) / scale, 1) if raw else None
            except ValueError:
                return None

        # power_supply reports temperature in tenths of a degree; a value this
        # large can only be a driver that reports millidegrees instead.
        raw_temp = value("temp")
        temp_c = None
        if raw_temp is not None:
            temp_c = round(raw_temp / 10, 1) if raw_temp < 1000 else round(raw_temp / 1000, 1)
        return {
            "charge_pct": value("capacity"),
            "temp_c": temp_c,
            "power_w": value("power_now", 1_000_000),  # microwatts
            "status": (slurp(str(supply / "status")) or "").strip() or None,
        }
    return None


def temperatures() -> dict | None:
    """The hottest CPU thermal zone, in degrees Celsius."""
    zones: dict[str, float] = {}
    for zone in sorted(Path("/sys/class/thermal").glob("thermal_zone*")):
        kind = (slurp(str(zone / "type")) or "").strip()
        raw = (slurp(str(zone / "temp")) or "").strip()
        try:
            if kind and raw:
                zones[kind] = round(int(raw) / 1000, 1)  # millidegrees
        except ValueError:
            continue
    if not zones:
        return None
    cpu = [value for kind, value in zones.items() if "cpu" in kind.lower()]
    return {"cpu_c": max(cpu) if cpu else max(zones.values())}


def containers() -> tuple[dict, dict]:
    """CPU and memory per container, plus the totals across them."""
    stats: dict[str, dict] = {}
    try:
        result = subprocess.run(
            [
                "podman",
                "stats",
                "--no-stream",
                "--format",
                "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}",
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return stats, {"cpu_pct": 0.0, "mem_mb": 0.0, "count": 0}
    for line in result.stdout.splitlines():
        name, _, rest = line.partition("\t")
        fields = rest.split("\t")
        if not name or len(fields) < 2:
            continue
        # MemUsage looks like "12.4MB / 16GB"; the first half is what is in use.
        stats[name] = {
            "cpu_pct": number(fields[0]),
            "mem_mb": size_mb(fields[1].split("/")[0]),
            "mem_pct": number(fields[2]) if len(fields) > 2 else None,
        }
    total = {
        "cpu_pct": round(sum(entry["cpu_pct"] or 0 for entry in stats.values()), 1),
        "mem_mb": round(sum(entry["mem_mb"] or 0 for entry in stats.values()), 1),
        "count": len(stats),
    }
    return stats, total


def load_averages() -> tuple[float, float, float]:
    values = []
    for field in (slurp("/proc/loadavg") or "").split()[:3]:
        try:
            values.append(float(field))
        except ValueError:
            values.append(0.0)
    while len(values) < 3:
        values.append(0.0)
    return values[0], values[1], values[2]


# --- one sample -------------------------------------------------------------


def sample(previous: dict | None) -> tuple[dict, dict]:
    """The payload for this run, and the counters the next run needs."""
    total, idle = cpu_totals()
    received, sent = net_totals()
    load1, load5, load15 = load_averages()
    uptime = (slurp("/proc/uptime") or "").split()
    now = time.time()
    # The last container sample, so a row without containers still says how old
    # the figures it is missing are.
    containers_at = previous.get("containers_at") if previous else None
    due = containers_at is None or now - containers_at >= CONTAINER_INTERVAL_S

    data = {
        "host": os.uname().nodename,
        "uptime_s": int(float(uptime[0])) if uptime else 0,
        "cores": os.cpu_count(),
        "cpu": {"usage_pct": None, "load1": load1, "load5": load5, "load15": load15},
        "network": {"rx_kbps": None, "tx_kbps": None},
        "memory": memory(),
        "disk": disks(),
        "battery": battery(),
        "temp": temperatures(),
        "containers_at": containers_at,
    }
    if due:
        data["containers"], data["containers_total"] = containers()
        data["containers_at"] = containers_at = now

    # Rates need two readings. The first run after boot only reports gauges; the
    # rest average over however long it has been since the previous sample, so a
    # missed tick or a failed push does not skew the figure.
    if previous:
        elapsed = now - previous["at"]
        busy = total - previous["total"]
        if elapsed > 1 and busy > 0:
            data["cpu"]["usage_pct"] = round(100 * (1 - (idle - previous["idle"]) / busy), 1)
        if elapsed > 1:
            data["network"] = {
                "rx_kbps": round((received - previous["rx"]) / elapsed / 1024, 1),
                "tx_kbps": round((sent - previous["tx"]) / elapsed / 1024, 1),
            }

    counters = {
        "at": now,
        "total": total,
        "idle": idle,
        "rx": received,
        "tx": sent,
        "containers_at": containers_at,
    }
    return data, counters


def load_state() -> dict | None:
    try:
        state = json.loads(STATE_PATH.read_text())
    except (OSError, ValueError):
        return None
    return state if isinstance(state, dict) else None


def save_state(state: dict) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(state))
    except OSError as error:  # a lost state file only costs one CPU figure
        print(f"acta-stats: cannot write {STATE_PATH}: {error}", file=sys.stderr)


# --- credentials ------------------------------------------------------------

SECRET_USER = "acta-auth-sensor-user"
SECRET_PASSWORD = "acta-auth-sensor-password"


def write_private(path: Path, text: str) -> None:
    """Write a file only this user can read, atomically."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        handle, temporary = tempfile.mkstemp(dir=path.parent)
        os.fchmod(handle, 0o600)
        with os.fdopen(handle, "w") as file:
            file.write(text)
        os.replace(temporary, path)
    except OSError as error:
        print(f"acta-stats: cannot cache credentials in {path}: {error}", file=sys.stderr)


def podman_secrets() -> tuple[str, str] | None:
    """The sensor credential pair from the podman secret store."""
    values = []
    for name in (SECRET_USER, SECRET_PASSWORD):
        try:
            result = subprocess.run(
                ["podman", "secret", "inspect", "--showsecret", "--format", "{{.SecretData}}", name],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as error:
            print(f"acta-stats: cannot run podman: {error}", file=sys.stderr)
            return None
        if result.returncode != 0 or not result.stdout.strip():
            print(
                f"acta-stats: cannot read podman secret {name} "
                f"({result.stderr.strip() or 'empty'}); run: mise run deploy:secrets",
                file=sys.stderr,
            )
            return None
        values.append(result.stdout.strip())
    return values[0], values[1]


def credentials(refresh: bool = False) -> str:
    """`user:password` for /api/ingest, or "" when there are none.

    The environment wins, so a manual run can point anywhere. Otherwise the
    podman secrets are the source of truth: reading one costs a podman
    invocation, so the pair is cached in the runtime directory (tmpfs, 0600) and
    only re-read after a reboot or when the service rejects it.
    """
    from_env = os.environ.get("ACTA_AUTH", "")
    if not from_env:
        user = os.environ.get("ACTA_SENSOR_USER", "")
        if user:
            from_env = f"{user}:{os.environ.get('ACTA_SENSOR_PASSWORD', '')}"
    if from_env:
        return from_env

    if not refresh:
        try:
            cached = json.loads(CREDENTIALS_PATH.read_text())
        except (OSError, ValueError):
            cached = None
        if isinstance(cached, dict) and cached.get("user") and cached.get("password"):
            return f"{cached['user']}:{cached['password']}"

    secrets = podman_secrets()
    if secrets is None:
        return ""
    write_private(CREDENTIALS_PATH, json.dumps({"user": secrets[0], "password": secrets[1]}))
    return f"{secrets[0]}:{secrets[1]}"


def send(row: dict, refresh: bool = False) -> None:
    headers = {"Content-Type": "application/json"}
    pair = credentials(refresh)
    if pair:
        headers["Authorization"] = "Basic " + base64.b64encode(pair.encode()).decode()
    request = urllib.request.Request(
        f"{BASE_URL}/api/ingest",
        data=json.dumps([row]).encode(),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        response.read()


def post(row: dict) -> None:
    try:
        send(row)
    except urllib.error.HTTPError as error:
        if error.code != 401:
            raise
        # The password was rotated under us: forget the cached pair, read the
        # podman secrets again and retry once.
        CREDENTIALS_PATH.unlink(missing_ok=True)
        send(row, refresh=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Push one sample of host statistics into acta.")
    parser.add_argument(
        "-n",
        "--dry-run",
        action="store_true",
        help="print the sample instead of posting it",
    )
    args = parser.parse_args()

    data, counters = sample(load_state())
    row = {
        "source": SOURCE,
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "data": data,
    }
    if args.dry_run:
        print(json.dumps([row], indent=2))
        return 0

    try:
        post(row)
    except Exception as error:  # noqa: BLE001 - any failure just skips this sample
        # The counters are kept, so the next run averages over the longer gap
        # instead of reporting a spike.
        print(f"acta-stats: {error}", file=sys.stderr)
        return 1
    save_state(counters)
    return 0


if __name__ == "__main__":
    sys.exit(main())
