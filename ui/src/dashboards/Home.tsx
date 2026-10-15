import TimeSeriesTile from '../components/TimeSeriesTile'

const LIVING_ROOM = 'co2-sensor-living-room'
const BAROMETER = 'brightness-barometer-living-room'
const LAUNDRY_ROOM = 'humidity-laundry-room'

// Variant fields are cast to their concrete type before aggregating: DuckDB's
// aggregates over a raw floating-point Variant field are silently wrong, e.g.
// avg(data.temperature) returns 21.0 where avg(data.temperature::DOUBLE) returns
// 21.23. Integer-typed fields happen to be correct either way.
export default function Home() {
  return (
    <div class="dashboard">
      <TimeSeriesTile
        wide
        title="Living room CO₂"
        source={LIVING_ROOM}
        series={[{ label: 'CO₂', expr: 'avg(data.co2::BIGINT)', metric: 'co2' }]}
        yLabel="CO₂ [ppm]"
      />
      <TimeSeriesTile
        title="Living room temperature"
        source={LIVING_ROOM}
        series={[{ label: 'Temperature', expr: 'avg(data.temperature::DOUBLE)', metric: 'temperature' }]}
        yLabel="Temperature [°C]"
      />
      <TimeSeriesTile
        title="Living room brightness"
        source={BAROMETER}
        series={[{ label: 'Brightness', expr: 'avg(data.lux::DOUBLE)', metric: 'brightness' }]}
        yLabel="Brightness [lux]"
      />
      <TimeSeriesTile
        title="Living room humidity"
        source={LIVING_ROOM}
        series={[{ label: 'Humidity', expr: 'avg(data.humidity::DOUBLE)', metric: 'humidity' }]}
        yLabel="Humidity [%]"
      />
      <TimeSeriesTile
        title="Living room pressure"
        source={BAROMETER}
        series={[{ label: 'Pressure', expr: 'avg(data.pressure::DOUBLE)', metric: 'pressure' }]}
        yLabel="Pressure [hPa]"
      />
      <TimeSeriesTile
        title="Laundry room humidity"
        source={LAUNDRY_ROOM}
        series={[{ label: 'Humidity', expr: 'avg(data.humidity::DOUBLE)', metric: 'humidity' }]}
        yLabel="Humidity [%]"
      />
      <TimeSeriesTile
        title="Laundry room temperature"
        source={LAUNDRY_ROOM}
        series={[{ label: 'Temperature', expr: 'avg(data.temperature::DOUBLE)', metric: 'temperature' }]}
        yLabel="Temperature [°C]"
      />
    </div>
  )
}
