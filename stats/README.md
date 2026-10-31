# eos statistics collector

`collect.py` samples the server (hostname `eos`, an Asahi Linux box) and pushes
one row per sample into acta as the source `eos-stats`. It runs from a systemd
**user** timer every 10 s, next to the acta container, and talks to the local
instance over `127.0.0.1` with the sensor credential.

The host gauges are plain file reads and go out on every sample, and so are the
counters every rate is a difference of. Two things are not worth that frequency:
`podman stats` spawns podman and asks every container's cgroup, and the drive's
health is state rather than traffic. They ride along together on every sixth
sample, once a minute, and the rows in between leave them out.

It lives outside the acta container on purpose: the container has no host
`/proc`, no view of other containers, and should not gain either. See
`design/004-service.md`.

## What a sample carries

All paths are relative to the row's `data` object:

| Path | Meaning |
| --- | --- |
| `host`, `uptime_s`, `cores` | hostname, uptime, CPU count |
| `cpu.usage_pct` | busy time over the sample interval (null on the first run) |
| `cpu.load1`, `load5`, `load15` | load averages |
| `pressure.cpu_some`, `mem_some`, `mem_full`, `io_some`, `io_full` | share of time a task stalled, per resource, % — the kernel's own 10 s average |
| `memory.total_mb`, `used_mb`, `used_pct` | RAM |
| `disk.used_gb`, `disk.used_pct` | used space and share of the filesystem behind `/` (btrfs subvolumes count as one) |
| `disk.boot_pct` | `/boot`'s share, when it is its own filesystem |
| `disk_io.<disk>.read_kbps`, `write_kbps` | throughput over the interval, whole disks only |
| `disk_io.<disk>.busy_pct`, `await_ms` | share of the interval an I/O was in flight, and the average latency per operation |
| `network.rx_kbps`, `tx_kbps` | rates over the interval, all interfaces but `lo` |
| `battery.charge_pct`, `temp_c`, `power_w`, `status` | `macsmc-battery` |
| `temp.board_c` | hottest of the temperature sensors the firmware exposes, °C |
| `containers.<name>.cpu_pct`, `mem_mb`, `mem_pct` | `podman stats`, every 60 s |
| `containers_total.cpu_pct`, `mem_mb`, `count` | totals across containers, every 60 s |
| `nvme.temp_c`, `crit_c`, `state`, `firmware` | the drive's own sensor and the threshold it is heading for, every 60 s |

`pressure` is the one reading that says a task had to *wait* rather than that the box was busy: a compaction or a
backup that blocks readers shows up there while `cpu.usage_pct` stays flat. `some` is the share of time at least one
task stalled, `full` the share where nothing made progress at all. Only `avg10` is kept — `avg60` and `avg300` are
moving averages of the same series — and `cpu` has no `full` line, since a stalled CPU task is a stalled CPU. A
kernel built without PSI reports `null`.

`disk_io` covers whole disks, not partitions (their I/O is the disk's, counted twice) and not the per-boot
pseudo-devices. `busy_pct` and `await_ms` answer different questions and neither follows from the other: a saturated
disk is busy with a short await, a sick one is idle with a long one. Like every other rate, `disk_io` starts on the
second sample.

`nvme.temp_c` is normally already inside `temp.board_c` too, since the kernel registers the drive's sensor as an
ordinary hwmon device; it is repeated with `crit_c` so the chart has the limit it is heading for. The counters a
SMART report is made of — `error_count`, `media_errors`, percentage used — live in a log page behind a privileged
ioctl, so sysfs does not have them and this collector does not either.

`board_c` is a board-level proxy, not a CPU temperature: Linux wires up only a few of the SMC's sensors — the NAND, the
battery hotspot, the charge regulator, the WiFi module — and none of the CPU core keys macOS reads, so the hottest of
those is the only thermal reading there is. On a machine with an NVMe drive, the drive's own sensor is in there as
well. A machine with no temperature sensor at all reports `null`.

`cpu_pct` is a rate over the interval between two container samples, worked out
from each container's CPU-time counter. podman's own percentage is not used for
it: with `--no-stream` podman has no previous sample to subtract, so it divides
by the container's whole life, and a spike then decays for hours instead of
clearing with the next sample. On the first sample for a container — including
any sample after the state file is lost — there is nothing to subtract yet, so
podman's figure stands for that one point.

Anything this machine does not have (no battery in a VM, no thermal zones) is
`null` or missing rather than an error, so the collector keeps reporting what it
can see.

## Install

```sh
mise run stats:install
```

That copies the script to `~/.local/bin/acta-stats` and the units to
`~/.config/systemd/user/`, checks that the podman secrets `acta-auth-sensor-*`
exist, then enables and starts the timer on the host named by `ACTA_HOST`
(default `eos`). It never reads or writes the credential itself. Re-running it
is safe and is how updates are shipped.

## Credentials

The collector authenticates with the sensor credential, and it fetches that
itself: on the first run it reads the podman secrets `acta-auth-sensor-user` and
`acta-auth-sensor-password` (`podman secret inspect --showsecret`), then caches
the pair in `$XDG_RUNTIME_DIR/credentials.json` (mode 0600). Because that
directory is tmpfs, a reboot re-reads the secrets; because a rotated password
would make the cache stale, a `401` from the service drops the cache, re-reads
the secrets and retries once. So one podman invocation per boot, not per sample,
and nothing secret is written to persistent storage.

`ACTA_AUTH=user:pass`, or `ACTA_SENSOR_USER`/`ACTA_SENSOR_PASSWORD`, override all
of that for a manual run. `--dry-run` needs no credential: it never posts.

## Verify

```sh
ssh eos '~/.local/bin/acta-stats --dry-run'     # the sample, without posting it
ssh eos 'journalctl --user -u acta-stats -n 20' # what the timer is doing
ssh eos 'systemctl --user list-timers acta-stats'
```

The dashboard is `/eos` on the acta frontend (`?range=6h` is a useful start).
Its "Latest sample" tile prints the newest row verbatim, so every field above
can be checked without a query.

The first sample after boot / install has `cpu.usage_pct` and the network rates
`null`: those need two readings, and the second run fills them in.

## Cost

At 10 s one sample is a few tens of bytes of Parquet (ZSTD; the original gauges
measured ~19 B, by adding one field group at a time), so a day is 8,640 rows and
well under a megabyte, and a year is well under 0.1 GB. What costs more than the
rows is the per-file overhead: each
flushed file carries ~29 KB of Parquet footer (the Variant schema and column
statistics), and the store flushes every 10 s, so the hot files alone are
~0.2 GB a day of *transient* writes, folded away by compaction within minutes.
Sampling more often does not change that; raising `ACTA_FLUSH_INTERVAL_MS` on
the service does.

## Tuning

The cadence is `OnUnitActiveSec=10s` in `acta-stats.timer`, and the interval the
expensive half of the sample shares is `SLOW_INTERVAL_S` in `collect.py`. After
editing either on the host: `systemctl --user daemon-reload && systemctl --user
restart acta-stats.timer` (or re-run `mise run stats:install`).
