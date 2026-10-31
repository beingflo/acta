import LatestStrip from '../components/LatestStrip'
import TimeSeriesTile from '../components/TimeSeriesTile'
import { PERCENT, RATE, TEMPERATURE } from '../lib/scale'

// Every reading here is a metric the service defines — source, expression and
// the type casts included (see `service/src/metrics.rs`). Nothing in this file
// is SQL, which is what lets a restricted viewer be given this dashboard and
// only this dashboard: it can name these readings and no others.
export default function Home() {
  return (
    <div class="dashboard">
      <LatestStrip />
      <TimeSeriesTile
        wide
        title="Living room CO₂"
        metrics={[{ metric: 'co2_ppm', label: 'CO₂' }]}
        yLabel="CO₂ [ppm]"
        yFit={{ floor: 0, pad: 0.1, span: 200 }}
      />
      <TimeSeriesTile
        title="Living room temperature"
        // Two sensors in the same room: the air sensor's reading and the one on
        // the brightness/barometer. Their offset is the interesting part.
        metrics={[
          { metric: 'living_temp_c', label: 'CO₂ sensor' },
          { metric: 'brightness_temp_c', label: 'Barometer' },
        ]}
        yLabel="Temperature [°C]"
        yFit={TEMPERATURE}
      />
      <TimeSeriesTile
        title="Living room brightness"
        metrics={[{ metric: 'brightness_lux', label: 'Brightness' }]}
        yLabel="Brightness [lux]"
        yFit={RATE}
      />
      <TimeSeriesTile
        title="Living room humidity"
        metrics={[{ metric: 'living_humidity_pct', label: 'Humidity' }]}
        yLabel="Humidity [%]"
        yFit={PERCENT}
      />
      <TimeSeriesTile
        title="Living room pressure"
        metrics={[{ metric: 'living_pressure_hpa', label: 'Pressure' }]}
        yLabel="Pressure [hPa]"
        yFit={{ pad: 0.2, span: 10 }}
      />
      <TimeSeriesTile
        title="Laundry room humidity"
        metrics={[{ metric: 'laundry_humidity_pct', label: 'Humidity' }]}
        yLabel="Humidity [%]"
        yFit={PERCENT}
      />
      <TimeSeriesTile
        title="Laundry room temperature"
        metrics={[{ metric: 'laundry_temp_c', label: 'Temperature' }]}
        yLabel="Temperature [°C]"
        yFit={TEMPERATURE}
      />
    </div>
  )
}
