import TimeSeriesTile from '../components/TimeSeriesTile'

export default function Home() {
  return (
    <div class="dashboard">
      <TimeSeriesTile
        title="Living room CO₂"
        source="co2-sensor-living-room"
        series={[{ label: 'CO₂ (ppm)', expr: 'avg(data.co2)', stroke: '#e5484d' }]}
        yLabel="ppm"
      />
    </div>
  )
}
