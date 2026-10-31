import EosStats from '../components/EosStats'
import SnapshotTile from '../components/SnapshotTile'
import TimeSeriesTile from '../components/TimeSeriesTile'
import { LOAD, PERCENT, RATE, SHARE, TEMPERATURE } from '../lib/scale'

/** `stats/collect.py`, run by a systemd timer on the server. */
const SOURCE = 'eos-stats'

/** A gauge: one reading per sample, averaged over the bucket. */
const gauge = (path: string) => `avg(${path}::DOUBLE)`

/**
 * The server itself: CPU, memory, containers, disk, network, battery. A strip of
 * scalars above the tiles says how the box is doing right now — uptime,
 * freshness, and the window's CPU, memory and temperature with their peaks.
 * The tiles below are the gauges worth a line over time; everything else the
 * collector sends (per container, per mount) is in the last tile.
 *
 * Every chart fits its own axis (`lib/scale.ts`): a quiet server zooms in
 * rather than lying flat at the bottom of a 0-100 scale. Half-width tiles come
 * in pairs of the same subject — the two container charts, the two network
 * directions, the two temperatures — and the pairs are laid out side by side.
 */
export default function Eos() {
  return (
    <div class="dashboard">
      <EosStats source={SOURCE} />
      <TimeSeriesTile
        wide
        title="CPU"
        source={SOURCE}
        yLabel="Usage [%]"
        yFit={PERCENT}
        series={[{ label: 'CPU', expr: gauge('data.cpu.usage_pct') }]}
      />
      <TimeSeriesTile
        title="Memory"
        source={SOURCE}
        yLabel="Used [%]"
        yFit={PERCENT}
        series={[{ label: 'Memory', expr: gauge('data.memory.used_pct') }]}
      />
      <TimeSeriesTile
        title="Load average"
        source={SOURCE}
        yLabel="Load [1m]"
        yFit={LOAD}
        series={[{ label: 'Load', expr: gauge('data.cpu.load1') }]}
      />
      <TimeSeriesTile
        title="Disk"
        source={SOURCE}
        yLabel="Root filesystem [%]"
        yFit={PERCENT}
        series={[{ label: 'Disk', expr: gauge('data.disk.used_pct') }]}
      />
      <TimeSeriesTile
        title="Battery charge"
        source={SOURCE}
        yLabel="Charge [%]"
        yFit={PERCENT}
        series={[{ label: 'Charge', expr: gauge('data.battery.charge_pct') }]}
      />
      <TimeSeriesTile
        title="Containers CPU"
        source={SOURCE}
        yLabel="Usage [%]"
        yFit={SHARE}
        series={[{ label: 'Containers', expr: gauge('data.containers_total.cpu_pct') }]}
      />
      <TimeSeriesTile
        title="Containers memory"
        source={SOURCE}
        yLabel="Used [MB]"
        yFit={{ floor: 0, pad: 0.2, span: 200 }}
        series={[{ label: 'Containers', expr: gauge('data.containers_total.mem_mb') }]}
      />
      <TimeSeriesTile
        title="Network in"
        source={SOURCE}
        yLabel="Rate [kB/s]"
        yFit={RATE}
        series={[{ label: 'In', expr: gauge('data.network.rx_kbps') }]}
      />
      <TimeSeriesTile
        title="Network out"
        source={SOURCE}
        yLabel="Rate [kB/s]"
        yFit={RATE}
        series={[{ label: 'Out', expr: gauge('data.network.tx_kbps') }]}
      />
      <TimeSeriesTile
        title="Board temperature"
        source={SOURCE}
        yLabel="Temperature [°C]"
        yFit={TEMPERATURE}
        series={[{ label: 'Board', expr: gauge('data.temp.board_c') }]}
      />
      <TimeSeriesTile
        title="Battery temperature"
        source={SOURCE}
        yLabel="Temperature [°C]"
        yFit={TEMPERATURE}
        series={[{ label: 'Temperature', expr: gauge('data.battery.temp_c') }]}
      />
      <SnapshotTile wide source={SOURCE} title="Latest sample" />
    </div>
  )
}
