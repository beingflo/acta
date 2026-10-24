import SnapshotTile from '../components/SnapshotTile'
import TimeSeriesTile from '../components/TimeSeriesTile'

/** `stats/collect.py`, run by a systemd timer on the server. */
const SOURCE = 'eos-stats'

/** A gauge: one reading per sample, averaged over the bucket. */
const gauge = (path: string) => `avg(${path}::DOUBLE)`

/**
 * The server itself: CPU, memory, containers, disk, network, battery. The tiles
 * below are the gauges worth a line over time; everything else the collector
 * sends (per container, per mount, per thermal zone) is in the last tile.
 */
export default function Eos() {
  return (
    <div class="dashboard">
      <TimeSeriesTile
        wide
        title="CPU"
        source={SOURCE}
        yLabel="Usage [%]"
        yRange={[0, 100]}
        series={[{ label: 'CPU', expr: gauge('data.cpu.usage_pct') }]}
      />
      <TimeSeriesTile
        title="CPU temperature"
        source={SOURCE}
        yLabel="Temperature [°C]"
        series={[{ label: 'CPU', expr: gauge('data.temp.cpu_c') }]}
      />
      <TimeSeriesTile
        title="Memory"
        source={SOURCE}
        yLabel="Used [%]"
        yRange={[0, 100]}
        series={[{ label: 'Memory', expr: gauge('data.memory.used_pct') }]}
      />
      <TimeSeriesTile
        title="Load average"
        source={SOURCE}
        yLabel="Load [1m]"
        series={[{ label: 'Load', expr: gauge('data.cpu.load1') }]}
      />
      <TimeSeriesTile
        title="Disk"
        source={SOURCE}
        yLabel="Root filesystem [%]"
        yRange={[0, 100]}
        series={[{ label: 'Disk', expr: gauge('data.disk.used_pct') }]}
      />
      <TimeSeriesTile
        title="Containers CPU"
        source={SOURCE}
        yLabel="Usage [%]"
        series={[{ label: 'Containers', expr: gauge('data.containers_total.cpu_pct') }]}
      />
      <TimeSeriesTile
        title="Containers memory"
        source={SOURCE}
        yLabel="Used [MB]"
        series={[{ label: 'Containers', expr: gauge('data.containers_total.mem_mb') }]}
      />
      <TimeSeriesTile
        title="Network in"
        source={SOURCE}
        yLabel="Rate [kB/s]"
        series={[{ label: 'In', expr: gauge('data.network.rx_kbps') }]}
      />
      <TimeSeriesTile
        title="Network out"
        source={SOURCE}
        yLabel="Rate [kB/s]"
        series={[{ label: 'Out', expr: gauge('data.network.tx_kbps') }]}
      />
      <TimeSeriesTile
        title="Battery charge"
        source={SOURCE}
        yLabel="Charge [%]"
        yRange={[0, 100]}
        series={[{ label: 'Charge', expr: gauge('data.battery.charge_pct') }]}
      />
      <TimeSeriesTile
        title="Battery temperature"
        source={SOURCE}
        yLabel="Temperature [°C]"
        series={[{ label: 'Temperature', expr: gauge('data.battery.temp_c') }]}
      />
      <SnapshotTile wide source={SOURCE} title="Latest sample" />
    </div>
  )
}
