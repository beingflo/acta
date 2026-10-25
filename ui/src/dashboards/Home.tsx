import LatestStrip from '../components/LatestStrip'
import TimeSeriesTile from '../components/TimeSeriesTile'

// Every reading here is a metric the service defines — source, expression and
// the type casts included (see `service/src/metrics.rs`). Nothing in this file
// is SQL, which is what lets a restricted viewer be given this dashboard and
// only this dashboard: it can name these readings and no others.
export default function Home() {
  return (
    <div class="dashboard">
      <LatestStrip />
      <TimeSeriesTile wide title="Living room CO₂" metric="co2_ppm" label="CO₂" yLabel="CO₂ [ppm]" />
      <TimeSeriesTile
        title="Living room temperature"
        metric="living_temp_c"
        label="Temperature"
        yLabel="Temperature [°C]"
      />
      <TimeSeriesTile
        title="Living room brightness"
        metric="brightness_lux"
        label="Brightness"
        yLabel="Brightness [lux]"
      />
      <TimeSeriesTile
        title="Living room humidity"
        metric="living_humidity_pct"
        label="Humidity"
        yLabel="Humidity [%]"
      />
      <TimeSeriesTile
        title="Living room pressure"
        metric="living_pressure_hpa"
        label="Pressure"
        yLabel="Pressure [hPa]"
      />
      <TimeSeriesTile
        title="Laundry room humidity"
        metric="laundry_humidity_pct"
        label="Humidity"
        yLabel="Humidity [%]"
      />
      <TimeSeriesTile
        title="Laundry room temperature"
        metric="laundry_temp_c"
        label="Temperature"
        yLabel="Temperature [°C]"
      />
    </div>
  )
}
