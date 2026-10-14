# Distinct sources present in the `events` view.
POST {{host}}/api/data
Content-Type: application/json
{
  "sql": "SELECT to_json(array_agg(source ORDER BY source))::VARCHAR FROM (SELECT DISTINCT source FROM events)"
}
HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$" count == 6
jsonpath "$" contains "co2-sensor-living-room"
jsonpath "$" contains "humidity-laundry-room"
jsonpath "$" contains "brightness-barometer-living-room"
jsonpath "$" contains "heuried-visitors"
jsonpath "$" contains "location_florian"
jsonpath "$" contains "marending"

###

# Hourly average CO2 over a fixed day: 24 buckets with numeric timestamps/values.
POST {{host}}/api/data
Content-Type: application/json
{
  "sql": "SELECT coalesce(to_json(array_agg(struct_pack(t := epoch(b), s0 := s0) ORDER BY b)), '[]'::JSON)::VARCHAR FROM (SELECT time_bucket(INTERVAL '1 hour', CAST(timestamp AS TIMESTAMP)) AS b, avg(data.co2) AS s0 FROM events WHERE source = 'co2-sensor-living-room' AND timestamp >= TIMESTAMPTZ '2026-10-10T00:00:00.000Z' AND timestamp < TIMESTAMPTZ '2026-10-11T00:00:00.000Z' GROUP BY 1)"
}
HTTP 200
[Asserts]
jsonpath "$" count == 24
jsonpath "$[0].t" isNumber
jsonpath "$[0].s0" isNumber

###

# A source whose variant payload is a bare number, not an object.
POST {{host}}/api/data
Content-Type: application/json
{
  "sql": "SELECT coalesce(to_json(array_agg(struct_pack(t := epoch(b), s0 := s0) ORDER BY b)), '[]'::JSON)::VARCHAR FROM (SELECT time_bucket(INTERVAL '1 hour', CAST(timestamp AS TIMESTAMP)) AS b, avg(data) AS s0 FROM events WHERE source = 'heuried-visitors' AND timestamp >= TIMESTAMPTZ '2026-10-10T00:00:00.000Z' AND timestamp < TIMESTAMPTZ '2026-10-11T00:00:00.000Z' GROUP BY 1)"
}
HTTP 200
[Asserts]
jsonpath "$" count == 24
jsonpath "$[0].s0" isNumber

###

# A range with no data returns an empty array, not an error.
POST {{host}}/api/data
Content-Type: application/json
{
  "sql": "SELECT coalesce(to_json(array_agg(struct_pack(t := epoch(b), s0 := s0) ORDER BY b)), '[]'::JSON)::VARCHAR FROM (SELECT time_bucket(INTERVAL '1 hour', CAST(timestamp AS TIMESTAMP)) AS b, avg(data.co2) AS s0 FROM events WHERE source = 'co2-sensor-living-room' AND timestamp >= TIMESTAMPTZ '2000-01-01T00:00:00.000Z' AND timestamp < TIMESTAMPTZ '2000-01-02T00:00:00.000Z' GROUP BY 1)"
}
HTTP 200
[Asserts]
jsonpath "$" count == 0
