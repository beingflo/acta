//! The vocabulary a restricted reader is allowed to ask in.
//!
//! `/api/data` takes SQL, which is exactly why it cannot be offered to someone
//! who may only see part of the data: no amount of inspection makes an arbitrary
//! query safe. Instead the service owns a small registry of named readings, each
//! naming the one source it comes from, and builds the SQL itself. A role that
//! may only see the home dashboards can name these and nothing else, so "the
//! data it must not read" is not something it can express.
//!
//! The registry is deliberately hand-written: a metric is a definition of a
//! reading — its source, its expression, whether a restricted viewer may ask for
//! it — and that definition belongs somewhere a person reviews it.

use chrono::{DateTime, SecondsFormat, Utc};

use crate::auth::Scope;

/// One named reading: where it comes from, and how to compute it.
pub struct Metric {
    /// The name the dashboard asks for.
    pub id: &'static str,
    /// The source it is computed from; a metric only ever reads this one.
    pub source: &'static str,
    /// The aggregate over a bucket, as SQL over the `events` view.
    pub expr: &'static str,
    /// Whether a restricted (`Scope::Home`) viewer may ask for it. Restricted by
    /// default: a new metric has to be opted in, not out.
    pub home: bool,
}

/// Every reading the structured endpoint serves.
pub const METRICS: &[Metric] = &[
    Metric {
        id: "co2_ppm",
        source: "co2-sensor-living-room",
        expr: "avg(data.co2::BIGINT)",
        home: true,
    },
    Metric {
        id: "living_temp_c",
        source: "co2-sensor-living-room",
        expr: "avg(data.temperature::DOUBLE)",
        home: true,
    },
    Metric {
        id: "living_humidity_pct",
        source: "co2-sensor-living-room",
        expr: "avg(data.humidity::DOUBLE)",
        home: true,
    },
    Metric {
        id: "brightness_lux",
        source: "brightness-barometer-living-room",
        expr: "avg(data.lux::DOUBLE)",
        home: true,
    },
    Metric {
        id: "living_pressure_hpa",
        source: "brightness-barometer-living-room",
        expr: "avg(data.pressure::DOUBLE)",
        home: true,
    },
    Metric {
        id: "laundry_humidity_pct",
        source: "humidity-laundry-room",
        expr: "avg(data.humidity::DOUBLE)",
        home: true,
    },
    Metric {
        id: "laundry_temp_c",
        source: "humidity-laundry-room",
        expr: "avg(data.temperature::DOUBLE)",
        home: true,
    },
];

/// The narrowest bucket, and the widest, the endpoint accepts. A sub-second
/// bucket is a client bug, and a bucket wider than the range returns a single
/// point.
pub const MIN_BUCKET_MS: u64 = 1_000;
pub const MAX_BUCKET_MS: u64 = 30 * 24 * 60 * 60 * 1_000;

/// The metric `id` may be read by a viewer with `scope`, or the reason it may not.
pub fn lookup(id: &str, scope: Scope) -> Result<&'static Metric, String> {
    let metric = METRICS
        .iter()
        .find(|metric| metric.id == id)
        .ok_or_else(|| format!("unknown metric: {id}"))?;
    if scope == Scope::All || metric.home {
        return Ok(metric);
    }
    // Deliberately the same answer as an unknown id: a restricted viewer learns
    // nothing about what else exists by asking for it.
    Err(format!("unknown metric: {id}"))
}

/// One series over `[from, to)`, bucketed, in the `{ t, s0 }` shape the charts
/// already consume. The expression comes from the registry, never from the
/// request; only integers and validated timestamps reach the string.
pub fn series_sql(
    metric: &Metric,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    bucket_ms: u64,
) -> String {
    let stamp = |at: DateTime<Utc>| at.to_rfc3339_opts(SecondsFormat::Millis, true);
    format!(
        "SELECT coalesce(
           to_json(array_agg(struct_pack(t := epoch(b), s0 := s0) ORDER BY b)),
           '[]'::JSON
         )::VARCHAR
FROM (
  SELECT time_bucket(INTERVAL '{bucket_ms} MILLISECONDS', CAST(timestamp AS TIMESTAMP)) AS b,
         {expr} AS s0
  FROM events
  WHERE timestamp >= TIMESTAMPTZ '{from}'
    AND timestamp <  TIMESTAMPTZ '{to}'
    AND source = '{source}'
  GROUP BY 1
)",
        expr = metric.expr,
        source = metric.source,
        from = stamp(from),
        to = stamp(to),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_metric_is_unique_and_names_one_source() {
        let mut ids: Vec<&str> = METRICS.iter().map(|metric| metric.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "two metrics share an id");

        for metric in METRICS {
            assert!(!metric.source.is_empty(), "{} has no source", metric.id);
            assert!(!metric.expr.is_empty(), "{} has no expression", metric.id);
        }
    }

    #[test]
    fn a_restricted_viewer_only_reaches_opted_in_metrics() {
        let home = lookup("co2_ppm", Scope::Home).expect("opted in");
        assert_eq!(home.source, "co2-sensor-living-room");

        assert!(lookup("co2_ppm", Scope::All).is_ok());
        assert!(lookup("nope", Scope::All).is_err());
        assert!(lookup("nope", Scope::Home).is_err());
    }

    #[test]
    fn the_sql_carries_the_metric_and_nothing_else() {
        let metric = lookup("laundry_temp_c", Scope::Home).expect("metric");
        let from = "2026-10-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let to = "2026-10-02T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let sql = series_sql(metric, from, to, 900_000);

        assert!(sql.contains("avg(data.temperature::DOUBLE)"));
        assert!(sql.contains("source = 'humidity-laundry-room'"));
        assert!(sql.contains("INTERVAL '900000 MILLISECONDS'"));
        assert!(sql.contains("TIMESTAMPTZ '2026-10-01T00:00:00.000Z'"));
        // The request never supplies SQL, so no quoting can escape.
        assert!(!sql.contains(';'));
    }
}
