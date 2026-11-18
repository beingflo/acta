//! Threshold alerts, mailed through the `notify` relay.
//!
//! A check is one reading and the marks it can reach: the mean over a window
//! sitting on the wrong side of a threshold for that long. Each tick runs one
//! query per check over a fixed lookback, decides which mark — if any — is met,
//! and hands the answer to a state machine that mails on the transitions: once
//! when a mark is first reached, once more if a worse one is, and once when the
//! readings are back to normal. Nothing is mailed while a mark simply stays met,
//! and nothing at all while the data is missing: a gap is silence, not an alarm.
//!
//! The checks are the `const` values below — there is no rule language and no
//! storage. A new alert is one more `Check` in `CHECKS`, with its marks; the
//! windows, sample rate and thresholds are code, so changing one is a redeploy,
//! which is the whole configuration surface this needs.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use crate::db::Db;
use crate::ingest::{self, IngestHandle};

/// One evaluation a minute. The narrowest window is five minutes wide, so a
/// faster tick would only re-read the same samples.
const TICK: Duration = Duration::from_secs(60);

/// The source the alerts' own report rows are filed under: one row per firing
/// and one per recovery, so the history lives in the archive rather than in a
/// log line that scrolls away. Read by the `alerts` dashboard.
const REPORT_SOURCE: &str = "acta-alert";

/// How much of a window's samples has to be there before its mean counts. A mean
/// over a gap is not a reading, so a window thinner than this meets no mark.
const MIN_COVERAGE: f64 = 0.5;

/// Which side of a threshold a mark is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
    Above,
    Below,
}

/// The two levels a mark can carry, least severe first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Level {
    Warn,
    Crit,
}

impl Level {
    /// What the mail carries. `notify` caps the field at 32 characters.
    fn severity(self) -> &'static str {
        match self {
            Level::Warn => "warn",
            Level::Crit => "crit",
        }
    }
}

/// One level a check can reach.
struct Mark {
    level: Level,
    /// The mean over `hold` has to be on the wrong side of this.
    threshold: f64,
    hold: Duration,
    side: Side,
}

/// One check: a reading, and the marks it can reach, least severe first.
struct Check {
    /// The rule's id, in the report rows, the logs and on the dashboard.
    id: &'static str,
    /// What the mail's subject calls it.
    title: &'static str,
    /// The mail's source tag: which part of the system raised it.
    mail_source: &'static str,
    /// The source the reading comes from, and its payload path — the query reads
    /// `data.<reading>`.
    source: &'static str,
    reading: &'static str,
    /// Printed after every number the mail and the dashboard show.
    unit: &'static str,
    marks: &'static [Mark],
    /// How long the reading has to be back on the good side before the incident
    /// counts as over. Entry reads a mark's hold window, whose mean lags: after
    /// the eos board drops to 30 °C its hour-long mean stays above 35 °C for up
    /// to another hour, so the exit reads a short window instead. That asymmetry
    /// is also the hysteresis that stops a flutter from mailing twice.
    settle: Duration,
    /// How often the source reports, which is what a window's expected sample
    /// count is measured against: `stats/collect.py` posts every 10 s, the
    /// laundry sensor roughly every 30 s.
    sample: Duration,
}

impl Check {
    /// The widest window the check reads: its longest hold, or its settle window.
    fn lookback(&self) -> Duration {
        self.marks
            .iter()
            .map(|mark| mark.hold)
            .chain(std::iter::once(self.settle))
            .max()
            .unwrap_or(TICK)
    }

    /// The side every mark of this check is on, which is also the side the check
    /// clears on.
    fn side(&self) -> Side {
        self.marks.first().map_or(Side::Above, |mark| mark.side)
    }

    /// The least severe mark: the threshold the reading has to come back to
    /// before the incident is over.
    fn lowest(&self) -> &Mark {
        self.marks.first().expect("a check has at least one mark")
    }
}

/// The eos board temperature: the same reading the eos dashboard charts, the
/// hottest of the board sensors the firmware exposes (Linux wires up no CPU
/// sensor on this hardware).
const EOS_BOARD: Check = Check {
    id: "eos_board_temp",
    title: "eos board temperature",
    mail_source: "acta-eos",
    source: "eos-stats",
    reading: "temp.board_c",
    unit: "°C",
    marks: &[
        Mark {
            level: Level::Warn,
            threshold: 35.0,
            hold: Duration::from_secs(3_600),
            side: Side::Above,
        },
        Mark {
            level: Level::Crit,
            threshold: 40.0,
            hold: Duration::from_secs(300),
            side: Side::Above,
        },
    ],
    settle: Duration::from_secs(600),
    sample: Duration::from_secs(10),
};

/// The laundry room drying out: below 45 % means the humidifier is out of water
/// or something has stopped, which is the case worth knowing about before the
/// next load of washing goes in.
const LAUNDRY_HUMIDITY: Check = Check {
    id: "laundry_humidity",
    title: "laundry room humidity",
    mail_source: "acta-laundry",
    source: "humidity-laundry-room",
    reading: "humidity",
    unit: "%",
    marks: &[Mark {
        level: Level::Warn,
        threshold: 45.0,
        hold: Duration::from_secs(300),
        side: Side::Below,
    }],
    settle: Duration::from_secs(600),
    sample: Duration::from_secs(30),
};

/// Every check, evaluated in this order each tick.
const CHECKS: &[Check] = &[EOS_BOARD, LAUNDRY_HUMIDITY];

/// What a check made of the window it read. A check never mails anything and
/// says nothing about what it saw last time: the `Watch` holds that.
struct Verdict {
    /// The worst mark the lookback meets: its index in the check's list, and the
    /// level it carries. A mark whose window holds too few samples to mean
    /// anything is not met.
    mark: Option<usize>,
    level: Option<Level>,
    /// Whether the readings have been back on the good side for the settle
    /// window: the incident is over rather than quiet for a minute.
    settled: bool,
    /// The mean over each mark's window, in the marks' order; `None` where the
    /// window was too thin to average.
    means: Vec<Option<f64>>,
    /// The newest reading, and the worst in the lookback (the highest for an
    /// "above" check, the lowest for a "below" one).
    current: Option<f64>,
    extreme: Option<f64>,
    /// The first reading on the wrong side of the least severe threshold within
    /// the lookback. That is as far back as a `since` can be known, so a longer
    /// excursion reads as having started at the beginning of the lookback.
    since: Option<DateTime<Utc>>,
}

impl Verdict {
    /// Why the verdict is what it is, for the log line: the mean that decided it.
    fn mean_of(&self, index: usize) -> Option<f64> {
        self.means.get(index).copied().flatten()
    }
}

// --- state ------------------------------------------------------------------

/// The incident a check is in the middle of, if it is in one.
#[derive(Clone)]
struct Incident {
    /// The worst level mailed so far: a level at or below it is a repeat of a
    /// mail that has already gone out.
    level: Level,
    /// When the readings first crossed the least severe threshold.
    since: Option<DateTime<Utc>>,
    /// The worst reading seen while the incident ran.
    extreme: Option<f64>,
    /// When the last mail about this incident went out.
    fired_at: DateTime<Utc>,
    /// Set once the recovery mail has gone out. The incident then stays open
    /// until the slowest mark stops being met, and is quiet in the meantime: the
    /// wide mean lags the reading, and firing again on that tail would mail the
    /// same incident twice.
    recovered: bool,
}

/// What one verdict means for the mail, given what came before.
enum Outcome {
    Quiet,
    /// A mark was reached, or a worse one while the incident was running.
    Fire {
        /// The index into the check's marks, so the mail can quote that window.
        mark: usize,
        since: Option<DateTime<Utc>>,
    },
    /// The readings are back to normal: the one mail an incident gets on its way
    /// out.
    Recover {
        level: Level,
        since: Option<DateTime<Utc>>,
        extreme: Option<f64>,
        lasted: Duration,
    },
}

/// One check's memory across ticks. In memory only: a restart re-fires a mark
/// that is still met, which is the harmless direction to be wrong in.
struct Watch {
    side: Side,
    incident: Option<Incident>,
}

impl Watch {
    fn new(check: &Check) -> Self {
        Self {
            side: check.side(),
            incident: None,
        }
    }

    fn observe(&mut self, verdict: &Verdict, now: DateTime<Utc>) -> Outcome {
        match (&mut self.incident, verdict.mark, verdict.level) {
            // Worse than what has been mailed: escalation, even when the incident
            // had already been reported as recovered — a reading that swings
            // further out after settling for ten minutes is news again.
            (Some(open), Some(mark), Some(level)) if level > open.level => {
                open.level = level;
                open.recovered = false;
                open.fired_at = now;
                open.extreme = extreme(open.extreme, verdict.extreme, self.side);
                Outcome::Fire {
                    mark,
                    since: open.since,
                }
            }
            // Recovered already: wait for the slow mark to clear, then the
            // incident is over and the next one starts from scratch.
            (Some(open), _, _) if open.recovered => {
                if verdict.mark.is_none() {
                    self.incident = None;
                }
                Outcome::Quiet
            }
            (Some(open), _, _) if verdict.settled => {
                open.recovered = true;
                open.extreme = extreme(open.extreme, verdict.extreme, self.side);
                let start = open.since.unwrap_or(open.fired_at);
                Outcome::Recover {
                    level: open.level,
                    since: open.since,
                    extreme: open.extreme,
                    lasted: (now - start).to_std().unwrap_or_default(),
                }
            }
            (Some(open), _, _) => {
                open.extreme = extreme(open.extreme, verdict.extreme, self.side);
                Outcome::Quiet
            }
            (None, Some(mark), Some(level)) => {
                self.incident = Some(Incident {
                    level,
                    since: verdict.since,
                    extreme: verdict.extreme,
                    fired_at: now,
                    recovered: false,
                });
                Outcome::Fire {
                    mark,
                    since: verdict.since,
                }
            }
            (None, _, _) => Outcome::Quiet,
        }
    }
}

/// The worse of two readings, which is the higher one for an "above" check and
/// the lower one for a "below" check.
fn extreme(a: Option<f64>, b: Option<f64>, side: Side) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(match side {
            Side::Above => a.max(b),
            Side::Below => a.min(b),
        }),
        (Some(a), None) => Some(a),
        (None, b) => b,
    }
}

// --- the relay --------------------------------------------------------------

/// The `notify` relay's `/alert` route, and the token it wants.
struct Sender {
    client: reqwest::Client,
    url: String,
    token: String,
}

impl Sender {
    fn new(url: String, token: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            url,
            token,
        }
    }

    /// POST one alert. `false` means it did not arrive, and the caller puts its
    /// state back so that the next tick tries again — a mail that never happened
    /// must not leave the alert looking fired.
    async fn send(&self, mail_source: &str, severity: &str, title: &str, body: &str) -> bool {
        // Serialized here rather than through reqwest's `json` feature, which
        // this binary would otherwise pull in for this one request.
        let payload = json!({
            "source": mail_source,
            "severity": severity,
            "title": title,
            "body": body,
        });
        let response = self
            .client
            .post(&self.url)
            .bearer_auth(&self.token)
            .header("content-type", "application/json")
            .timeout(Duration::from_secs(10))
            .body(payload.to_string())
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => true,
            Ok(response) => {
                error!(
                    status = response.status().as_u16(),
                    title,
                    "alert was refused by the relay"
                );
                false
            }
            Err(err) => {
                error!(error = %err.without_url(), title, "alert could not be delivered");
                false
            }
        }
    }
}

// --- one tick ---------------------------------------------------------------

/// The row a check's query returns.
#[derive(Deserialize)]
struct Sample {
    current: Option<f64>,
    highest: Option<f64>,
    lowest: Option<f64>,
    since_secs: Option<i64>,
    marks: Vec<MarkSample>,
    n_settle: i64,
    mean_settle: Option<f64>,
}

#[derive(Deserialize)]
struct MarkSample {
    n: i64,
    mean: Option<f64>,
}

/// One query for one tick: everything the check needs about its lookback,
/// windows included, in a single row.
///
/// The bounds are rendered from a wall clock the caller supplies, like the read
/// path does, so nothing here depends on DuckDB's time zone support. The explicit
/// lower bound is also what keeps this cheap: file and row-group statistics prune
/// the archive, so only the live end of the data is read.
fn check_sql(check: &Check, now: DateTime<Utc>) -> String {
    let stamp = |at: DateTime<Utc>| at.to_rfc3339_opts(SecondsFormat::Secs, true);
    let ago = |window: Duration| stamp(now - chrono::Duration::seconds(window.as_secs() as i64));
    let lowest = check.lowest();
    let since = match lowest.side {
        Side::Above => format!("v > {}", lowest.threshold),
        Side::Below => format!("v < {}", lowest.threshold),
    };
    let marks = check
        .marks
        .iter()
        .map(|mark| {
            let from = ago(mark.hold);
            format!(
                "struct_pack(
                   n := count(*) FILTER (WHERE timestamp >= TIMESTAMPTZ '{from}'),
                   mean := avg(v) FILTER (WHERE timestamp >= TIMESTAMPTZ '{from}')
                 )"
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "SELECT to_json(struct_pack(
           current := arg_max(v, CAST(timestamp AS TIMESTAMP)),
           highest := max(v),
           lowest := min(v),
           since_secs := CAST(epoch(CAST(min(timestamp) FILTER (WHERE {since}) AS TIMESTAMP)) AS BIGINT),
           marks := [{marks}],
           n_settle := count(*) FILTER (WHERE timestamp >= TIMESTAMPTZ '{settle_from}'),
           mean_settle := avg(v) FILTER (WHERE timestamp >= TIMESTAMPTZ '{settle_from}')
         ))::VARCHAR
         FROM (
           SELECT timestamp, data.{reading}::DOUBLE AS v
           FROM events
           WHERE source = '{source}'
             AND timestamp >= TIMESTAMPTZ '{from}'
         )
         WHERE v IS NOT NULL",
        reading = check.reading,
        source = check.source,
        settle_from = ago(check.settle),
        from = ago(check.lookback()),
    )
}

/// A window is only a reading when it holds most of the samples it should.
fn covered(n: i64, window: Duration, sample: Duration) -> bool {
    n as f64 >= MIN_COVERAGE * window.as_secs_f64() / sample.as_secs_f64()
}

fn judge(check: &Check, sample: &Sample) -> Verdict {
    let means: Vec<Option<f64>> = check
        .marks
        .iter()
        .zip(&sample.marks)
        .map(|(mark, read)| read.mean.filter(|_| covered(read.n, mark.hold, check.sample)))
        .collect();

    // The marks are ordered least severe first, so the last met one is the worst.
    let met = check
        .marks
        .iter()
        .zip(&means)
        .enumerate()
        .filter(|(_, (mark, mean))| match (mark.side, **mean) {
            (Side::Above, Some(mean)) => mean > mark.threshold,
            (Side::Below, Some(mean)) => mean < mark.threshold,
            _ => false,
        })
        .map(|(index, _)| index)
        .next_back();

    // Back to normal is the least severe threshold, whichever mark was reached,
    // and whichever side it is on.
    let lowest = check.lowest();
    let settled = sample
        .mean_settle
        .filter(|_| covered(sample.n_settle, check.settle, check.sample))
        .is_some_and(|mean| match lowest.side {
            Side::Above => mean <= lowest.threshold,
            Side::Below => mean >= lowest.threshold,
        });

    Verdict {
        mark: met,
        level: met.map(|index| check.marks[index].level),
        settled,
        means,
        current: sample.current,
        extreme: match check.side() {
            Side::Above => sample.highest,
            Side::Below => sample.lowest,
        },
        since: sample
            .since_secs
            .and_then(|secs| DateTime::from_timestamp(secs, 0)),
    }
}

async fn read_check(db: &Db, check: &Check) -> Result<Verdict, String> {
    let json = db
        .query_json(check_sql(check, Utc::now()))
        .await
        .map_err(|err| err.to_string())?;
    let sample: Sample =
        serde_json::from_str(&json).map_err(|err| format!("alert query: {err}"))?;
    Ok(judge(check, &sample))
}

// --- the mails --------------------------------------------------------------

fn mail(check: &Check, outcome: &Outcome, verdict: &Verdict) -> Option<(String, String)> {
    let side = check.side();
    let lowest = check.lowest();
    let (phrase, extreme_word) = match side {
        Side::Above => ("above", "highest"),
        Side::Below => ("below", "lowest"),
    };
    let reading = |label: &str, value: Option<f64>| match value {
        Some(value) => format!(" {label}: {value:.1} {}\n", check.unit),
        None => String::new(),
    };
    let since = |since: Option<DateTime<Utc>>| match since {
        Some(at) => format!(
            " first {phrase} {} {} at: {}\n",
            lowest.threshold,
            check.unit,
            at.format("%Y-%m-%d %H:%MZ")
        ),
        None => String::new(),
    };

    match outcome {
        Outcome::Quiet => None,
        Outcome::Fire { mark, since: at } => {
            let reached = check.marks.get(*mark).unwrap_or(lowest);
            let body = [
                format!(
                    "{} is {phrase} {} {} (mean over the last {}).\n",
                    check.title,
                    reached.threshold,
                    check.unit,
                    span(reached.hold),
                ),
                reading("mean", verdict.mean_of(*mark)),
                reading("newest", verdict.current),
                reading(
                    &format!("{extreme_word} in the last {}", span(check.lookback())),
                    verdict.extreme,
                ),
                since(*at),
                format!("\n{}. `{}`.\n", check.source, check.reading),
                format!(
                    "rule: {}; it clears when the mean over {} is {} {} {}.\n",
                    check
                        .marks
                        .iter()
                        .map(|mark| format!(
                            "mean over {} {} {} {}",
                            span(mark.hold),
                            match mark.side {
                                Side::Above => "above",
                                Side::Below => "below",
                            },
                            mark.threshold,
                            check.unit,
                        ))
                        .collect::<Vec<_>>()
                        .join(", "),
                    span(check.settle),
                    match side {
                        Side::Above => "at or below",
                        Side::Below => "at or above",
                    },
                    lowest.threshold,
                    check.unit,
                ),
                "Evaluated once a minute; a window with too few samples to average says \
                 nothing at all.\n"
                    .to_string(),
            ]
            .concat();
            Some((
                format!("{} {phrase} {} {}", check.title, reached.threshold, check.unit),
                body,
            ))
        }
        Outcome::Recover {
            level,
            extreme,
            since: at,
            lasted,
        } => {
            let now = match verdict.current {
                Some(value) => format!("back at {value:.1} {}", check.unit),
                None => "no reading".to_string(),
            };
            let body = [
                format!(
                    "{now} after {} {phrase} {} {} ({} was reached).\n",
                    span(*lasted),
                    lowest.threshold,
                    check.unit,
                    level.severity(),
                ),
                reading(extreme_word, *extreme),
                since(*at),
                format!(
                    "\n{}. `{}`. The alert is armed again.\n",
                    check.source, check.reading
                ),
            ]
            .concat();
            Some((format!("{} back to normal", check.title), body))
        }
    }
}

/// A duration as the mail writes it: `1 h 12 min`, `1 h`, `5 min`, `48 s`.
fn span(duration: Duration) -> String {
    let secs = duration.as_secs();
    let (hours, minutes) = (secs / 3_600, (secs % 3_600) / 60);
    match (hours, minutes) {
        (0, 0) => format!("{secs} s"),
        (0, minutes) => format!("{minutes} min"),
        (hours, 0) => format!("{hours} h"),
        (hours, minutes) => format!("{hours} h {minutes} min"),
    }
}

// --- the loop ---------------------------------------------------------------

/// Evaluate the checks at startup and then once a minute, for as long as the
/// process lives. Startup included on purpose: a box that is already too hot, or
/// a room that has already dried out, when the service restarts is exactly the
/// case a timer that waits a minute would be quiet about.
///
/// Alerting is off unless both `ACTA_ALERT_URL` (rendered by the deploy, since it
/// is not a secret) and `ACTA_ALERT_TOKEN` (the relay's own token, shared as a
/// podman secret) are present. Missing either is one warning and no checks at all,
/// never a silent half-configuration.
pub async fn run(
    db: Arc<Db>,
    ingest: IngestHandle,
    data_lock: Arc<RwLock<()>>,
    url: Option<String>,
) {
    let Some(url) = url else {
        return;
    };
    let token = match std::env::var("ACTA_ALERT_TOKEN") {
        Ok(token) if !token.trim().is_empty() => token.trim().to_string(),
        _ => {
            warn!(
                relay = %url,
                "alerting disabled: ACTA_ALERT_TOKEN is not set (the notify relay's own token, \
                 installed as the podman secret notify-alert-token)"
            );
            return;
        }
    };

    let sender = Sender::new(url.clone(), token);
    info!(
        relay = %url,
        tick_s = TICK.as_secs(),
        checks = CHECKS.iter().map(|check| check.id).collect::<Vec<_>>().join(","),
        "alert checks running"
    );

    let mut watches: Vec<Watch> = CHECKS.iter().map(Watch::new).collect();
    loop {
        let now = Utc::now();
        let checked: Vec<(&Check, Result<Verdict, String>)> = {
            // The read lock is what keeps a compaction swap from happening
            // mid-query; the same one `/api/data` takes. Held across every check
            // of this tick, so they all read one consistent view.
            let _read = data_lock.read().await;
            let mut checked = Vec::with_capacity(CHECKS.len());
            for check in CHECKS {
                checked.push((check, read_check(&db, check).await));
            }
            checked
        };

        for ((check, result), watch) in checked.into_iter().zip(watches.iter_mut()) {
            let verdict = match result {
                Ok(verdict) => verdict,
                Err(err) => {
                    warn!(rule = check.id, error = %err, "alert check failed");
                    continue;
                }
            };
            // The state is advanced by `observe`, and rolled back below if the
            // mail does not arrive: a failed send must not swallow the alert.
            let before = watch.incident.clone();
            let outcome = watch.observe(&verdict, now);
            let Some((title, body)) = mail(check, &outcome, &verdict) else {
                continue;
            };
            let severity = match &outcome {
                Outcome::Fire { mark, .. } => check
                    .marks
                    .get(*mark)
                    .map_or(Level::Warn, |mark| mark.level)
                    .severity(),
                _ => "ok",
            };
            let delivered = sender
                .send(check.mail_source, severity, &title, &body)
                .await;
            if delivered {
                info!(rule = check.id, title, severity, "alert mail sent");
            } else {
                watch.incident = before;
            }
            report(
                &ingest,
                json!({
                    "rule": check.id,
                    "event": match &outcome {
                        Outcome::Fire { .. } => "fire",
                        _ => "recover",
                    },
                    "severity": severity,
                    "delivered": delivered,
                    "current": verdict.current,
                    "extreme": verdict.extreme,
                    "since": verdict.since.map(stamp_of),
                    "at": stamp_of(now),
                }),
            )
            .await;
        }
        tokio::time::sleep(TICK).await;
    }
}

fn stamp_of(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Record one firing or recovery in the archive, under `acta-alert`.
///
/// The row cannot be the alert itself — it is written after the mail either way —
/// but it is what the `alerts` dashboard reads, and it says whether the mail
/// arrived.
async fn report(ingest: &IngestHandle, data: Value) {
    let item = ingest::IngestItem {
        source: REPORT_SOURCE.to_string(),
        timestamp: None,
        data,
    };
    let row = match ingest::item_to_row(item, ingest::now_us()) {
        Ok(row) => row,
        Err(err) => {
            warn!(error = %err, "alert: could not build the report row");
            return;
        }
    };
    // A wedged writer must not take the alert loop down with it: the row is worth
    // missing, the next check is not.
    match tokio::time::timeout(Duration::from_secs(30), ingest.submit(vec![row])).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => warn!(error = %err, "alert: could not record the event"),
        Err(_) => warn!("alert: the ingest buffer did not take the report row"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use chrono::TimeZone;

    fn at(minute: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 6, 12, 0, 0).unwrap() + chrono::Duration::minutes(minute)
    }

    /// A window holding every sample it should.
    fn full(check: &Check, window: Duration) -> i64 {
        (window.as_secs_f64() / check.sample.as_secs_f64()) as i64
    }

    /// A sample row with every window full and the marks carrying `means`.
    fn sample(check: &Check, means: &[Option<f64>], settle: f64) -> Sample {
        Sample {
            current: Some(means[0].unwrap_or(settle)),
            highest: Some(41.5),
            lowest: Some(41.5),
            since_secs: Some(at(0).timestamp()),
            marks: check
                .marks
                .iter()
                .zip(means)
                .map(|(mark, mean)| MarkSample {
                    n: full(check, mark.hold),
                    mean: *mean,
                })
                .collect(),
            n_settle: full(check, check.settle),
            mean_settle: Some(settle),
        }
    }

    fn verdict(level: Option<Level>, settled: bool) -> Verdict {
        Verdict {
            // The test verdicts are the eos board's: mark 0 is the warning.
            mark: level.map(|level| if level == Level::Warn { 0 } else { 1 }),
            level,
            settled,
            means: vec![Some(36.4), Some(39.9)],
            current: Some(31.0),
            extreme: Some(41.5),
            since: Some(at(0)),
        }
    }

    #[test]
    fn every_check_is_coherent() {
        for check in CHECKS {
            assert!(!check.marks.is_empty(), "{} has no marks", check.id);
            assert!(
                check.marks.iter().all(|mark| mark.side == check.side()),
                "{} mixes sides",
                check.id
            );
            // The marks are ordered least severe first, and the state machine
            // reads that order as the escalation order.
            for pair in check.marks.windows(2) {
                assert!(pair[0].level < pair[1].level, "{}", check.id);
            }
            assert_eq!(
                check.marks.first().map(|mark| mark.level),
                Some(Level::Warn),
                "{} does not start at the warning",
                check.id
            );
            // The settle window has to be covered by the lookback, or the exit
            // would read samples the query never fetched.
            assert!(check.lookback() >= check.settle, "{}", check.id);
        }
        assert!(
            CHECKS.iter().map(|check| check.id).eq(["eos_board_temp", "laundry_humidity"]),
            "the dashboard mirrors this list"
        );
    }

    #[test]
    fn a_thin_window_is_not_a_reading() {
        let check = &EOS_BOARD;
        // Half the expected samples is the line; one fewer is a gap.
        assert!(covered(180, Duration::from_secs(3_600), check.sample));
        assert!(!covered(179, Duration::from_secs(3_600), check.sample));

        let mut thin = sample(check, &[Some(45.0), Some(45.0)], 45.0);
        for mark in &mut thin.marks {
            mark.n = 10;
        }
        thin.n_settle = 10;
        let verdict = judge(check, &thin);
        assert_eq!(verdict.level, None, "a spike over a gap is not a level");
        assert!(!verdict.settled, "nor is a gap a recovery");
    }

    #[test]
    fn the_mean_decides_the_level() {
        let check = &EOS_BOARD;
        assert_eq!(
            judge(check, &sample(check, &[Some(36.4), Some(39.9)], 34.0)).level,
            Some(Level::Warn)
        );
        assert_eq!(
            judge(check, &sample(check, &[Some(41.0), Some(40.1)], 39.0)).level,
            Some(Level::Crit)
        );
        // Exactly at a threshold is not above it, and the worse mark wins when
        // both hold.
        assert_eq!(
            judge(check, &sample(check, &[Some(35.0), Some(40.0)], 30.0)).level,
            None
        );
        // Back to normal is the low threshold, so a critical excursion ends when
        // the board is merely warm.
        assert!(judge(check, &sample(check, &[Some(41.0), Some(41.0)], 34.9)).settled);
        assert!(!judge(check, &sample(check, &[Some(41.0), Some(41.0)], 35.1)).settled);
    }

    #[test]
    fn a_below_check_fires_on_the_way_down_and_clears_on_the_way_up() {
        let check = &LAUNDRY_HUMIDITY;
        let dry = judge(check, &sample(check, &[Some(43.2)], 44.0));
        assert_eq!(dry.level, Some(Level::Warn));
        // The extreme is the lowest reading, not the highest.
        assert_eq!(dry.extreme, Some(41.5));
        assert!(!dry.settled);

        // Above the threshold is no level at all, and the settle window reads at
        // or above it.
        let damp = judge(check, &sample(check, &[Some(46.0)], 45.0));
        assert_eq!(damp.level, None);
        assert!(damp.settled);
        assert!(!judge(check, &sample(check, &[Some(46.0)], 44.9)).settled);
    }

    #[test]
    fn an_incident_mails_once_per_level_and_once_on_the_way_out() {
        let mut watch = Watch::new(&EOS_BOARD);

        // First crossing: warn.
        match watch.observe(&verdict(Some(Level::Warn), false), at(0)) {
            Outcome::Fire { mark, .. } => assert_eq!(mark, 0),
            _ => panic!("expected a firing"),
        }
        // Staying hot is not news, and neither is dropping back to the level that
        // has already been mailed.
        assert!(matches!(
            watch.observe(&verdict(Some(Level::Warn), false), at(1)),
            Outcome::Quiet
        ));
        // Escalation is.
        match watch.observe(&verdict(Some(Level::Crit), false), at(2)) {
            Outcome::Fire { mark, .. } => assert_eq!(mark, 1),
            _ => panic!("expected the escalation"),
        }
        assert!(matches!(
            watch.observe(&verdict(Some(Level::Warn), false), at(3)),
            Outcome::Quiet
        ));
        // Cooling: one recovery mail, with how long it lasted and how far it went.
        match watch.observe(&verdict(None, true), at(72)) {
            Outcome::Recover {
                extreme, lasted, ..
            } => {
                assert_eq!(extreme, Some(41.5));
                assert_eq!(lasted, Duration::from_secs(72 * 60));
            }
            _ => panic!("expected the recovery"),
        }
        // The hour-long mean is still above the threshold: quiet, and still open.
        assert!(matches!(
            watch.observe(&verdict(Some(Level::Warn), false), at(73)),
            Outcome::Quiet
        ));
        assert!(watch.incident.is_some());
        // Cleared: the incident closes, and the same level fires afresh later.
        assert!(matches!(
            watch.observe(&verdict(None, true), at(74)),
            Outcome::Quiet
        ));
        assert!(watch.incident.is_none());
        assert!(matches!(
            watch.observe(&verdict(Some(Level::Warn), false), at(200)),
            Outcome::Fire { .. }
        ));
    }

    #[test]
    fn a_gap_keeps_the_incident_open_instead_of_closing_it() {
        let mut watch = Watch::new(&LAUNDRY_HUMIDITY);
        watch.observe(&verdict(Some(Level::Warn), false), at(0));
        // No samples: neither a level nor a settled window.
        assert!(matches!(
            watch.observe(&verdict(None, false), at(30)),
            Outcome::Quiet
        ));
        assert!(watch.incident.is_some(), "silence is not a recovery");
    }

    #[test]
    fn the_query_carries_every_window_of_its_check() {
        let sql = check_sql(&EOS_BOARD, at(0));
        assert!(
            sql.contains("timestamp >= TIMESTAMPTZ '2026-11-06T11:00:00Z'"),
            "{sql}"
        );
        assert!(sql.contains("TIMESTAMPTZ '2026-11-06T11:55:00Z'"), "{sql}");
        assert!(sql.contains("TIMESTAMPTZ '2026-11-06T11:50:00Z'"), "{sql}");
        assert!(sql.contains("source = 'eos-stats'"));
        assert!(sql.contains("data.temp.board_c::DOUBLE"));
        assert!(sql.contains("v > 35"), "{sql}");

        // The laundry check reads a ten-minute lookback, one five-minute window,
        // and the other side of its threshold.
        let sql = check_sql(&LAUNDRY_HUMIDITY, at(0));
        assert!(
            sql.contains("timestamp >= TIMESTAMPTZ '2026-11-06T11:50:00Z'"),
            "{sql}"
        );
        assert!(sql.contains("source = 'humidity-laundry-room'"), "{sql}");
        assert!(sql.contains("data.humidity::DOUBLE"), "{sql}");
        assert!(sql.contains("v < 45"), "{sql}");
        assert_eq!(sql.matches("mean := avg").count(), 1, "{sql}");
    }

    #[test]
    fn a_mail_quotes_the_mean_that_decided_it() {
        let fire = Outcome::Fire {
            mark: 0,
            since: Some(at(0)),
        };
        let (title, body) = mail(&EOS_BOARD, &fire, &verdict(Some(Level::Warn), false)).unwrap();
        assert_eq!(title, "eos board temperature above 35 °C");
        assert!(body.contains("mean: 36.4 °C"), "{body}");
        assert!(body.contains("highest in the last 1 h: 41.5 °C"), "{body}");
        assert!(body.contains("clears when the mean over 10 min is at or below 35 °C"), "{body}");

        let recover = Outcome::Recover {
            level: Level::Crit,
            since: Some(at(0)),
            extreme: Some(41.5),
            lasted: Duration::from_secs(72 * 60),
        };
        let (title, body) = mail(&EOS_BOARD, &recover, &verdict(None, true)).unwrap();
        assert_eq!(title, "eos board temperature back to normal");
        assert!(body.contains("back at 31.0 °C after 1 h 12 min"), "{body}");

        assert!(mail(&EOS_BOARD, &Outcome::Quiet, &verdict(None, true)).is_none());
    }

    #[test]
    fn a_below_mail_reads_the_other_way_round() {
        let check = &LAUNDRY_HUMIDITY;
        let dry = judge(check, &sample(check, &[Some(43.2)], 44.0));
        let fire = Outcome::Fire {
            mark: 0,
            since: Some(at(0)),
        };
        let (title, body) = mail(check, &fire, &dry).unwrap();
        assert_eq!(title, "laundry room humidity below 45 %");
        assert!(body.contains("laundry room humidity is below 45 %"), "{body}");
        assert!(body.contains("lowest in the last 10 min: 41.5 %"), "{body}");
        assert!(body.contains("first below 45 % at: 2026-11-06 12:00Z"), "{body}");
        assert!(
            body.contains("clears when the mean over 10 min is at or above 45 %"),
            "{body}"
        );
    }

    #[test]
    fn durations_read_as_hours_minutes_and_seconds() {
        assert_eq!(span(Duration::from_secs(48)), "48 s");
        assert_eq!(span(Duration::from_secs(6 * 60)), "6 min");
        assert_eq!(span(Duration::from_secs(3_600)), "1 h");
        assert_eq!(span(Duration::from_secs(72 * 60)), "1 h 12 min");
    }
}
