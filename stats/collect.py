#!/usr/bin/env python3
"""Sample eos and push one reading into acta.

Installed on the server by `mise run stats:install` and run every 10 s by
`acta-stats.timer`. Each run reads the host's gauges from /proc and /sys,
derives CPU, network and disk rates from the counters the previous run left in
its state file, and posts the result to `POST /api/ingest` as the source
`eos-stats`.

Reading /proc is nearly free; `podman stats` is not — it spawns podman and asks
every container's cgroup — so containers ride along on every sixth sample,
together with the drive's health, which is state rather than traffic, and the
rows in between leave both out.

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
import stat
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

# How often the half of the sample that is not a free gauge is worth its cost.
# The host gauges — including the counters every rate is a difference of — are
# plain file reads and go out on every sample; `podman stats` spawns a process,
# and the drive's temperature and firmware say nothing over ten seconds.
SLOW_INTERVAL_S = 60

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


def pressure() -> dict | None:
    """Stall share per resource, as the kernel's own 10 s average, in percent.

    PSI is the one gauge here that says a task had to *wait* rather than that the
    box was busy: a compaction or a backup that blocks readers shows up here
    while the CPU chart stays flat. `some` is the share of time at least one task
    stalled, `full` the share where nothing made progress at all. cpu has no
    `full` line — a stalled CPU task is a stalled CPU — and the whole directory
    is absent on a kernel built without PSI.

    Only avg10 is kept: avg60 and avg300 are moving averages of this very series.
    """
    values: dict[str, float] = {}
    for resource in ("cpu", "memory", "io"):
        text = slurp(f"/proc/pressure/{resource}")
        if text is None:
            return None
        for line in text.splitlines():
            kind, _, rest = line.partition(" ")
            fields = dict(field.split("=", 1) for field in rest.split() if "=" in field)
            value = number(fields.get("avg10", ""))
            if value is not None:
                values[f"{resource.replace('memory', 'mem')}_{kind}"] = value
    return values or None


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


def mounts() -> list[tuple[str, str]]:
    """Device and mount point of every mount of a real filesystem."""
    found = []
    for line in (slurp("/proc/self/mounts") or "").splitlines():
        fields = line.split()
        if len(fields) >= 3 and fields[2] in FILESYSTEMS:
            found.append((fields[0], fields[1].replace("\\040", " ")))  # spaces are escaped
    return found


def block_name(device: str) -> str | None:
    """The kernel's name for a mount's device node: `/dev/mapper/x` -> `dm-0`.

    The path a mount records is a name a person chose — a mapper alias, a
    partition, a plain disk — while sysfs indexes block devices by number, so the
    node itself is the only reliable way in.
    """
    try:
        info = os.stat(device)
    except OSError:
        return None
    if not stat.S_ISBLK(info.st_mode):
        return None
    node = Path("/sys/dev/block", f"{os.major(info.st_rdev)}:{os.minor(info.st_rdev)}")
    return node.resolve().name if node.exists() else None


def whole_disks(name: str, depth: int = 0) -> set[str]:
    """The whole disk(s) behind a block device: a disk, a partition, a mapper.

    A partition's sysfs entry sits inside its disk's directory, and a mapper or
    raid device lists what it is made of in `slaves`, so either resolves in a
    step or two; the depth limit is only a guard against a cycle.
    """
    if not name or depth > 4:
        return set()
    if Path("/sys/block", name).exists():
        return {name}
    slaves = Path("/sys/class/block", name, "slaves")
    if slaves.is_dir():
        found: set[str] = set()
        for slave in slaves.iterdir():
            found |= whole_disks(slave.name, depth + 1)
        return found
    entry = Path("/sys/class/block", name)
    if not entry.exists():
        return set()
    return whole_disks(entry.resolve().parent.name, depth + 1)


def mounted_disks() -> set[str]:
    """The whole disks that carry a mounted filesystem.

    This is the one signal that separates the drives that matter from the ones
    the firmware merely declares: Apple's controller offers two namespaces beside
    the SSD that count some I/O from the boot probe and never move a byte
    afterwards, and no counter of theirs ever says so. A partition, a mapper
    device and a raid array all resolve to the disk that does the I/O.
    """
    found: set[str] = set()
    for device, _ in mounts():
        found |= whole_disks(block_name(device) or "")
    return found


def disks() -> dict:
    """Space on the filesystem behind `/`, plus `/boot`'s share.

    A device mounted several times — btrfs subvolumes such as /, /home and /var —
    is one filesystem, so its shortest mount point names it: on eos that is the
    164 GiB btrfs every user file and every container layer lives on.

    `/boot` is the one other filesystem that can fill from software (kernel
    updates land there, and a full /boot breaks them), so its share rides along.
    The rest of the box is virtual (tmpfs) or fixed-size (the ESP) and says
    nothing about the disk filling up.
    """
    # One mount point per device; the shortest is the filesystem's name.
    devices: dict[str, str] = {}
    for device, mount in mounts():
        known = devices.get(device)
        if known is None or len(mount) < len(known):
            devices[device] = mount

    def usage(mount: str) -> dict | None:
        try:
            stat = os.statvfs(mount)
        except OSError:
            return None
        total = stat.f_blocks * stat.f_frsize
        free = stat.f_bavail * stat.f_frsize  # what an unprivileged user may use
        used = total - stat.f_bfree * stat.f_frsize
        return {
            "used_gb": round(used / 1024**3, 2),
            "used_pct": percent(used, used + free),
        }

    root = usage("/")
    # /boot is only its own filesystem when it is a separate mount; otherwise it
    # is a directory on `/` and its numbers would just repeat root's.
    boot = usage("/boot") if "/boot" in devices.values() else None
    return {
        "used_gb": root["used_gb"] if root else None,
        "used_pct": root["used_pct"] if root else None,
        "boot_pct": boot["used_pct"] if boot else None,
    }


def disk_counters() -> dict[str, tuple[int, ...]]:
    """Per disk that carries a mounted filesystem, the counters every rate needs.

    Partitions are skipped — their I/O is the disk's, counted twice — and so is
    every device no filesystem is mounted from: the pseudo devices the kernel
    declares per boot (loop, ram, zram, the optical drive) and the two namespaces
    Apple's controller lists beside the SSD. Those count a little I/O from the
    boot probe and then nothing ever again, which is exactly the kind of disk
    that would sit in the payload as three zeros forever.

    /proc/diskstats counts sectors of 512 bytes whatever the drive's own sector
    size, and io_ticks as milliseconds with at least one I/O in flight.
    """
    wanted = mounted_disks()
    counters: dict[str, tuple[int, ...]] = {}
    for line in (slurp("/proc/diskstats") or "").splitlines():
        fields = line.split()
        if len(fields) < 14 or fields[2] not in wanted:
            continue
        reads, sectors_read, writes, sectors_written, io_ms = (
            int(fields[field]) for field in (3, 5, 7, 9, 12)
        )
        counters[fields[2]] = (reads, sectors_read, writes, sectors_written, io_ms)
    return counters


def disk_rates(counters: dict, previous: dict | None, elapsed: float) -> dict:
    """Throughput, saturation and latency per disk over the interval.

    `busy_pct` and `await_ms` answer different questions and neither follows from
    the other: a saturated device is busy with a short await, a sick one is idle
    with a long one.
    """
    rates = {}
    for name, now in counters.items():
        before = (previous or {}).get(name)
        if before is None or elapsed <= 0:
            continue
        reads, sectors_read, writes, sectors_written, io_ms = (a - b for a, b in zip(now, before))
        if min(reads, sectors_read, writes, sectors_written, io_ms) < 0:
            continue  # the counters restart with the device
        operations = reads + writes
        rates[name] = {
            "read_kbps": round(sectors_read * 512 / elapsed / 1024, 1),
            "write_kbps": round(sectors_written * 512 / elapsed / 1024, 1),
            "busy_pct": percent(io_ms, elapsed * 1000),
            "await_ms": round(io_ms / operations, 2) if operations else 0.0,
        }
    return rates


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


def milli_celsius(reading: str) -> float | None:
    """`26100` -> 26.1: hwmon and thermal zones both report millidegrees."""
    try:
        return round(int(reading.strip()) / 1000, 1)
    except ValueError:
        return None


def temperature() -> float | None:
    """The hottest temperature sensor this machine exposes, in degrees Celsius.

    Linux exposes no CPU temperature on Apple Silicon — the SMC holds those
    sensors, but the Devicetree wires up only the board-level ones (NAND, battery
    hotspot, charge regulator, WiFi module) — so their maximum is the hottest
    reading there is. The battery has a field of its own; it is included here
    too, and only wins when nothing else is warmer.
    """
    paths = [
        *Path("/sys/class/hwmon").glob("hwmon*/temp*_input"),
        *Path("/sys/class/thermal").glob("thermal_zone*/temp"),
    ]
    readings = [milli_celsius(slurp(str(path)) or "") for path in sorted(paths)]
    found = [value for value in readings if value is not None]
    return max(found) if found else None


def containers() -> dict:
    """CPU and memory per container.

    `cpu_ns` is the container's total CPU time, which the caller subtracts from
    the previous reading to get a rate. The `cpu_pct` alongside it is podman's
    own figure, and on its own it is useless over time: without a previous
    sample `podman stats --no-stream` divides by the whole life of the
    container, so a spike keeps decaying for hours. It survives only as the
    first value for a container, where there is nothing to subtract yet.
    """
    stats: dict[str, dict] = {}
    try:
        result = subprocess.run(
            [
                "podman",
                "stats",
                "--no-stream",
                "--format",
                "{{.Name}}\t{{.CPUPerc}}\t{{.CPUNano}}\t{{.MemUsage}}\t{{.MemPerc}}",
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return stats
    for line in result.stdout.splitlines():
        name, _, rest = line.partition("\t")
        fields = rest.split("\t")
        if not name or len(fields) < 3:
            continue
        # MemUsage looks like "12.4MB / 16GB"; the first half is what is in use.
        stats[name] = {
            "cpu_pct": number(fields[0]),
            "cpu_ns": int(fields[1]) if fields[1].strip().isdigit() else None,
            "mem_mb": size_mb(fields[2].split("/")[0]),
            "mem_pct": number(fields[3]) if len(fields) > 3 else None,
        }
    return stats


def container_totals(stats: dict) -> dict:
    """The totals across the containers, once their CPU shares are known."""
    return {
        "cpu_pct": round(sum(entry["cpu_pct"] or 0 for entry in stats.values()), 1),
        "mem_mb": round(sum(entry["mem_mb"] or 0 for entry in stats.values()), 1),
        "count": len(stats),
    }


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


def nvme() -> dict | None:
    """The drive's health, as far as sysfs exposes it without privileges.

    `temp_c` is the drive's own sensor — the hottest of the ones it exposes, and
    normally already inside `temp.board_c` too, since the kernel registers it as
    an ordinary hwmon device; it is repeated here with the critical threshold the
    drive reports, so the chart has the limit it is heading for. `state` leaves
    `live` when the controller is reset or dead.

    The counters that fill a SMART report — error_count, media_errors, percentage
    used — live in a log page reached by a privileged ioctl, so no reading of
    sysfs has them. Root on the host is what `nvme smart-log` is for.
    """
    controller = next(iter(sorted(Path("/sys/class/nvme").glob("nvme*"))), None)
    if controller is None:
        return None

    def readings(pattern: str) -> list[float]:
        found = [milli_celsius(slurp(str(path)) or "") for path in sorted(controller.glob(pattern))]
        return [value for value in found if value is not None]

    temperatures = readings("hwmon*/temp*_input")
    critical = readings("hwmon*/temp1_crit")
    return {
        "temp_c": max(temperatures) if temperatures else None,
        "crit_c": max(critical) if critical else None,
        "state": (slurp(str(controller / "state")) or "").strip() or None,
        "firmware": (slurp(str(controller / "firmware_rev")) or "").strip() or None,
    }


# --- one sample -------------------------------------------------------------


def sample(previous: dict | None) -> tuple[dict, dict]:
    """The payload for this run, and the counters the next run needs."""
    total, idle = cpu_totals()
    received, sent = net_totals()
    disk_now = disk_counters()
    load1, load5, load15 = load_averages()
    hottest = temperature()
    uptime = (slurp("/proc/uptime") or "").split()
    now = time.time()
    # The last slow sample, which carried the containers and the drive's health.
    earlier = previous or {}
    due = earlier.get("slow_at") is None or now - earlier["slow_at"] >= SLOW_INTERVAL_S
    # CPU time read last time, and when it was read: the baseline this run
    # subtracts from.
    cpu_ns = dict(earlier.get("containers_cpu") or {})
    cpu_ns_at = earlier.get("containers_cpu_at")
    slow_at = earlier.get("slow_at")

    data = {
        "host": os.uname().nodename,
        "uptime_s": int(float(uptime[0])) if uptime else 0,
        "cores": os.cpu_count(),
        "cpu": {"usage_pct": None, "load1": load1, "load5": load5, "load15": load15},
        "pressure": pressure(),
        "network": {"rx_kbps": None, "tx_kbps": None},
        "memory": memory(),
        "disk": disks(),
        "battery": battery(),
        "temp": {"board_c": hottest} if hottest is not None else None,
    }
    if due:
        stats = containers()
        for name, entry in stats.items():
            total_ns = entry.pop("cpu_ns")
            before = cpu_ns.get(name)
            if total_ns is not None:
                cpu_ns[name] = total_ns
            # Two readings of the container's CPU time give the rate over the
            # span between them, which is what the graph is asking for. A
            # counter that went backwards means the container restarted since,
            # so podman's own figure is all there is to report.
            if total_ns is not None and before is not None and total_ns > before:
                span = now - cpu_ns_at if cpu_ns_at else 0
                if span > 0:
                    entry["cpu_pct"] = round(100 * (total_ns - before) / (span * 1e9), 1)
        if stats:
            cpu_ns_at = now
        data["containers"] = stats
        data["containers_total"] = container_totals(stats)
        data["nvme"] = nvme()
        slow_at = now

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
            data["disk_io"] = disk_rates(disk_now, previous.get("disks"), elapsed)

    counters = {
        "at": now,
        "total": total,
        "idle": idle,
        "rx": received,
        "tx": sent,
        "disks": disk_now,
        "slow_at": slow_at,
        "containers_cpu": cpu_ns,
        "containers_cpu_at": cpu_ns_at,
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
