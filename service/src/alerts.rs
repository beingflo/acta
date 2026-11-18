//! Threshold alerts, mailed through the `notify` relay.
//!
//! A check is a small hand-written function: it runs one query over a fixed
//! lookback window, decides whether any of its levels is met, and hands the
//! answer to a state machine that mails on the transitions — once when a level
//! is first reached, once more if a worse level is, and once when the readings
//! are back to normal. Nothing is mailed while a level simply stays met, and
//! nothing at all while the data is missing: a gap is silence, not an alarm.
//!
//! There is one check and two levels, so there is no rule language and no
//! storage. A second alert is another `check_*` function and one line in the
//! tick; the windows and the sample rate are constants because they are
//! properties of the data, not settings. The thresholds are code too, so changing
//! one is a redeploy — which is the whole configuration surface this needs.

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

/// What a mail says it came from: the system that raised it, not the check.
const ALERT_SOURCE: &str = "acta-eos";

// --- eos board temperature --------------------------------------------------

const BOARD_SOURCE: &str = "eos-stats";

/// The reading the eos dashboard's board temperature chart plots: the hottest of
/// the board sensors the firmware exposes. Not a CPU temperature — Apple Silicon
/// keeps those in the SMC, and Linux wires up only the board-level ones.
const BOARD_FIELD: &str = "data.temp.board_c::DOUBLE";

const BOARD_WARN_C: f64 = 35.0;
const BOARD_CRIT_C: f64 = 40.0;

/// How long a level has to hold, as a mean over its window.
const BOARD_WARN_HOLD: Duration = Duration::from_secs(3_600);
const BOARD_CRIT_HOLD: Duration = Duration::from_secs(300);

/// How long the readings have to sit at or below the lowest threshold before the
/// incident counts as over. Entry reads the hold window's mean, which lags: after
/// the board drops to 30 °C an hour-long mean stays above 35 °C for up to another
/// hour, so the exit reads a short window instead of the same one. That asymmetry
/// is also the hysteresis — a 35.1/34.9 flutter settles nothing.
const BOARD_SETTLE: Duration = Duration::from_secs(600);

/// `stats/collect.py` posts one sample every ten seconds. A window holding fewer
/// than half the samples it should is a gap, and a mean over a gap is not a
/// reading, so a level whose window is that thin is simply not met.
const SAMPLE_SECS: f64 = 10.0;
const MIN_COVERAGE: f64 = 0.5;

/// The two levels every check may reach, worst last.
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

    /// The mean that decides this level, and how long it has to hold.
    fn threshold(self) -> f64 {
        match self {
            Level::Warn => BOARD_WARN_C,
            Level::Crit => BOARD_CRIT_C,
        }
    }

    fn hold(self) -> Duration {
        match self {
            Level::Warn => BOARD_WARN_HOLD,
            Level::Crit => BOARD_CRIT_HOLD,
        }
    }
}

/// What a check made of the window it read. A check never mails anything and says
/// nothing about what it saw last time: the `Watch` holds that.
struct Verdict {
    /// The worst level the window meets. A level whose window holds too few
    /// samples to mean anything is not met.
    level: Option<Level>,
    /// Whether the readings have been at or below the lowest threshold for the
    /// settle window: the incident is over rather than quiet for a minute.
    settled: bool,
    /// The mean over each level's window, as the query returned it — the mail
    /// quotes the one that decided the level.
    mean_warn: Option<f64>,
    mean_crit: Option<f64>,
    /// The newest reading and the worst in the lookback. Both are absent only
    /// when the lookback holds nothing at all.
    current: Option<f64>,
    peak: Option<f64>,
    /// The first reading above the lowest threshold within the lookback. That is
    /// as far back as a `since` can be known, so a longer excursion reads as
    /// having started an hour before it was seen.
    since: Option<DateTime<Utc>>,
}

impl Verdict {
    fn mean_for(&self, level: Level) -> Option<f64> {
        match level {
            Level::Warn => self.mean_warn,
            Level::Crit => self.mean_crit,
        }
    }
}

// --- state ------------------------------------------------------------------

/// The incident a check is in the middle of, if it is in one.
#[derive(Clone)]
struct Incident {
    /// The worst level mailed so far: a level at or below it is a repeat of a
    /// mail that has already gone out.
    level: Level,
    /// When the readings first went above the lowest threshold.
    since: Option<DateTime<Utc>>,
    /// The worst reading seen while the incident ran.
    peak: Option<f64>,
    /// When the last mail about this incident went out.
    fired_at: DateTime<Utc>,
    /// Set once the recovery mail has gone out. The incident then stays open
    /// until the slowest level stops being met, and is quiet in the meantime: the
    /// hour-long mean is still above 35 °C for a while after the board cools, and
    /// firing again on that tail would mail the same incident twice.
    recovered: bool,
}

/// What one verdict means for the mail, given what came before.
enum Outcome {
    Quiet,
    /// A level was reached, or a worse one while the incident was running.
    Fire {
        level: Level,
        since: Option<DateTime<Utc>>,
    },
    /// The readings are back to normal: the one mail an incident gets on its way
    /// out.
    Recover {
        level: Level,
        since: Option<DateTime<Utc>>,
        peak: Option<f64>,
        lasted: Duration,
    },
}

/// One check's memory across ticks. In memory only: a restart re-fires a level
/// that is still met, which is the harmless direction to be wrong in.
#[derive(Default)]
struct Watch {
    incident: Option<Incident>,
}

impl Watch {
    fn observe(&mut self, verdict: &Verdict, now: DateTime<Utc>) -> Outcome {
        match (&mut self.incident, verdict.level) {
            // Worse than what has been mailed: escalation, even when the
            // incident had already been reported as recovered — a board that
            // climbs back to 40 °C after cooling for ten minutes is news again.
            (Some(open), Some(level)) if level > open.level => {
                open.level = level;
                open.recovered = false;
                open.fired_at = now;
                open.peak = highest(open.peak, verdict.peak);
                Outcome::Fire {
                    level,
                    since: open.since,
                }
            }
            // Recovered already: wait for the slow level to clear, then the
            // incident is over and the next one starts from scratch.
            (Some(open), _) if open.recovered => {
                if verdict.level.is_none() {
                    self.incident = None;
                }
                Outcome::Quiet
            }
            (Some(open), _) if verdict.settled => {
                open.recovered = true;
                open.peak = highest(open.peak, verdict.peak);
                let start = open.since.unwrap_or(open.fired_at);
                Outcome::Recover {
                    level: open.level,
                    since: open.since,
                    peak: open.peak,
                    lasted: (now - start).to_std().unwrap_or_default(),
                }
            }
            (Some(open), _) => {
                open.peak = highest(open.peak, verdict.peak);
                Outcome::Quiet
            }
            (None, Some(level)) => {
                self.incident = Some(Incident {
                    level,
                    since: verdict.since,
                    peak: verdict.peak,
                    fired_at: now,
                    recovered: false,
                });
                Outcome::Fire {
                    level,
                    since: verdict.since,
                }
            }
            (None, None) => Outcome::Quiet,
        }
    }
}

fn highest(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
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
    async fn send(&self, severity: &str, title: &str, body: &str) -> bool {
        // Serialized here rather than through reqwest's `json` feature, which
        // this binary would otherwise pull in for this one request.
        let payload = json!({
            "source": ALERT_SOURCE,
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

// --- the check --------------------------------------------------------------

/// The row the check's one query returns.
#[derive(Deserialize)]
struct BoardSample {
    current: Option<f64>,
    peak: Option<f64>,
    since_secs: Option<i64>,
    n_warn: i64,
    mean_warn: Option<f64>,
    n_crit: i64,
    mean_crit: Option<f64>,
    n_settle: i64,
    mean_settle: Option<f64>,
}

/// One query for one tick: everything the check needs to know about the last
/// hour, windows included, in a single row.
///
/// The bounds are rendered from a wall clock the caller supplies, like the read
/// path does, so nothing here depends on DuckDB's time zone support. The explicit
/// lower bound is also what keeps this cheap: file and row-group statistics prune
/// the archive, so only the live end of the data is read.
fn board_sql(now: DateTime<Utc>) -> String {
    let stamp = |at: DateTime<Utc>| at.to_rfc3339_opts(SecondsFormat::Secs, true);
    let ago = |window: Duration| stamp(now - chrono::Duration::seconds(window.as_secs() as i64));
    let (crit_from, settle_from, from) = (
        ago(BOARD_CRIT_HOLD),
        ago(BOARD_SETTLE),
        ago(BOARD_WARN_HOLD),
    );

    format!(
        "SELECT to_json(struct_pack(
           current := arg_max(v, CAST(timestamp AS TIMESTAMP)),
           peak := max(v),
           since_secs := CAST(epoch(CAST(min(timestamp) FILTER (WHERE v > {warn}) AS TIMESTAMP)) AS BIGINT),
           n_warn := count(*),
           mean_warn := avg(v),
           n_crit := count(*) FILTER (WHERE timestamp >= TIMESTAMPTZ '{crit_from}'),
           mean_crit := avg(v) FILTER (WHERE timestamp >= TIMESTAMPTZ '{crit_from}'),
           n_settle := count(*) FILTER (WHERE timestamp >= TIMESTAMPTZ '{settle_from}'),
           mean_settle := avg(v) FILTER (WHERE timestamp >= TIMESTAMPTZ '{settle_from}')
         ))::VARCHAR
         FROM (
           SELECT timestamp, {field} AS v
           FROM events
           WHERE source = '{source}'
             AND timestamp >= TIMESTAMPTZ '{from}'
         )
         WHERE v IS NOT NULL",
        warn = BOARD_WARN_C,
        field = BOARD_FIELD,
        source = BOARD_SOURCE,
    )
}

/// A window is only a reading when it holds most of the samples it should.
fn covered(samples: i64, window: Duration) -> bool {
    samples as f64 >= MIN_COVERAGE * window.as_secs_f64() / SAMPLE_SECS
}

fn board_verdict(sample: &BoardSample) -> Verdict {
    // A mean over a window that is mostly gap is not a reading: the mean is
    // dropped with the coverage, so neither a level nor the settle exit can rest
    // on it.
    let mean_warn = sample
        .mean_warn
        .filter(|_| covered(sample.n_warn, BOARD_WARN_HOLD));
    let mean_crit = sample
        .mean_crit
        .filter(|_| covered(sample.n_crit, BOARD_CRIT_HOLD));
    let mean_settle = sample
        .mean_settle
        .filter(|_| covered(sample.n_settle, BOARD_SETTLE));

    let level = if mean_crit.is_some_and(|mean| mean > BOARD_CRIT_C) {
        Some(Level::Crit)
    } else if mean_warn.is_some_and(|mean| mean > BOARD_WARN_C) {
        Some(Level::Warn)
    } else {
        None
    };

    Verdict {
        level,
        // Back to normal is the low threshold, whichever level was reached: a
        // critical excursion is over when the board is merely warm again.
        settled: mean_settle.is_some_and(|mean| mean <= BOARD_WARN_C),
        mean_warn,
        mean_crit,
        current: sample.current,
        peak: sample.peak,
        since: sample
            .since_secs
            .and_then(|secs| DateTime::from_timestamp(secs, 0)),
    }
}

async fn check_eos_board(db: &Db) -> Result<Verdict, String> {
    let json = db
        .query_json(board_sql(Utc::now()))
        .await
        .map_err(|err| err.to_string())?;
    let sample: BoardSample =
        serde_json::from_str(&json).map_err(|err| format!("alert query: {err}"))?;
    Ok(board_verdict(&sample))
}

// --- the mails --------------------------------------------------------------

/// The subject is the relay's to build (`Alert (<severity>): <title>`), so the
/// title says what happened and leaves the level to the severity field.
const BOARD_TITLE: &str = "eos board temperature";

fn board_mail(outcome: &Outcome, verdict: &Verdict) -> Option<(String, String)> {
    let reading = |label: &str, value: Option<f64>| match value {
        Some(value) => format!(" {label}: {value:.1} °C\n"),
        None => String::new(),
    };
    let since = |since: Option<DateTime<Utc>>| match since {
        Some(at) => format!(" first above 35 °C at: {}\n", at.format("%Y-%m-%d %H:%MZ")),
        None => String::new(),
    };

    match outcome {
        Outcome::Quiet => None,
        Outcome::Fire { level, since: at } => {
            let window = span_duration(level.hold());
            let body = [
                format!(
                    "eos board temperature is above {} °C (mean over the last {window}).\n",
                    level.threshold()
                ),
                reading("mean", verdict.mean_for(*level)),
                reading("newest", verdict.current),
                reading("peak in the last hour", verdict.peak),
                since(*at),
                format!(
                    "\n{BOARD_SOURCE} temp.board_c — the hottest board sensor the firmware \
                     exposes.\n\
                     rule: mean over {} above {BOARD_WARN_C} °C warns, mean over {} above \
                     {BOARD_CRIT_C} °C is critical; it clears when the mean over {} is at or below \
                     {BOARD_WARN_C} °C.\n\
                     Evaluated once a minute; a window with too few samples to average says \
                     nothing at all.\n",
                    span_duration(BOARD_WARN_HOLD),
                    span_duration(BOARD_CRIT_HOLD),
                    span_duration(BOARD_SETTLE),
                ),
            ]
            .concat();
            Some((
                format!("{BOARD_TITLE} above {} °C", level.threshold()),
                body,
            ))
        }
        Outcome::Recover {
            level,
            peak,
            since: at,
            lasted,
        } => {
            let now = match verdict.current {
                Some(value) => format!("back at {value:.1} °C"),
                None => "no reading".to_string(),
            };
            let body = [
                format!(
                    "{now} after {} above {BOARD_WARN_C} °C ({} was reached).\n",
                    span_duration(*lasted),
                    level.severity(),
                ),
                reading("peak", *peak),
                since(*at),
                format!("\n{BOARD_SOURCE} temp.board_c. The alert is armed again.\n"),
            ]
            .concat();
            Some((format!("{BOARD_TITLE} back to normal"), body))
        }
    }
}

/// A duration as the mail writes it: `1 h 12 min`, `1 h`, `6 min`, `48 s`.
fn span_duration(duration: Duration) -> String {
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
/// process lives. Startup included on purpose: a box that is already too hot when
/// the service restarts is exactly the case a timer that waits a minute would be
/// quiet about.
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
        "alert checks running"
    );

    let mut board = Watch::default();
    loop {
        let now = Utc::now();
        let checked = {
            // The read lock is what keeps a compaction swap from happening
            // mid-query; the same one `/api/data` takes.
            let _read = data_lock.read().await;
            check_eos_board(&db).await
        };
        match checked {
            Ok(verdict) => {
                // The state is advanced by `observe`, and rolled back below if
                // the mail does not arrive: a failed send must not swallow the
                // alert.
                let before = board.incident.clone();
                let outcome = board.observe(&verdict, now);
                if let Some((title, body)) = board_mail(&outcome, &verdict) {
                    let severity = match &outcome {
                        Outcome::Fire { level, .. } => level.severity(),
                        _ => "ok",
                    };
                    let delivered = sender.send(severity, &title, &body).await;
                    if delivered {
                        info!(title, severity, "alert mail sent");
                    } else {
                        board.incident = before;
                    }
                    report(
                        &ingest,
                        json!({
                            "rule": "eos_board_temp",
                            "event": match &outcome {
                                Outcome::Fire { .. } => "fire",
                                _ => "recover",
                            },
                            "severity": severity,
                            "delivered": delivered,
                            "current_c": verdict.current,
                            "peak_c": verdict.peak,
                            "since": verdict.since.map(stamp),
                            "at": stamp(now),
                        }),
                    )
                    .await;
                }
            }
            Err(err) => warn!(error = %err, "alert check failed"),
        }
        tokio::time::sleep(TICK).await;
    }
}

fn stamp(at: DateTime<Utc>) -> String {
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
    fn full(window: Duration) -> i64 {
        (window.as_secs_f64() / SAMPLE_SECS) as i64
    }

    fn sample(warn: Option<f64>, crit: Option<f64>, settle: Option<f64>) -> BoardSample {
        BoardSample {
            current: Some(36.0),
            peak: Some(41.5),
            since_secs: Some(at(0).timestamp()),
            n_warn: full(BOARD_WARN_HOLD),
            mean_warn: warn,
            n_crit: full(BOARD_CRIT_HOLD),
            mean_crit: crit,
            n_settle: full(BOARD_SETTLE),
            mean_settle: settle,
        }
    }

    fn verdict(level: Option<Level>, settled: bool) -> Verdict {
        Verdict {
            level,
            settled,
            mean_warn: Some(36.4),
            mean_crit: Some(39.9),
            current: Some(31.0),
            peak: Some(41.5),
            since: Some(at(0)),
        }
    }

    #[test]
    fn a_thin_window_is_not_a_reading() {
        // Half the expected samples is the line; one fewer is a gap.
        assert!(covered(180, BOARD_WARN_HOLD));
        assert!(!covered(179, BOARD_WARN_HOLD));
        assert!(covered(15, BOARD_CRIT_HOLD));
        assert!(!covered(14, BOARD_CRIT_HOLD));

        let thin = BoardSample {
            n_warn: 10,
            n_crit: 10,
            n_settle: 10,
            ..sample(Some(45.0), Some(45.0), Some(45.0))
        };
        let verdict = board_verdict(&thin);
        assert_eq!(verdict.level, None, "a spike over a gap is not a level");
        assert!(!verdict.settled, "nor is a gap a recovery");
    }

    #[test]
    fn the_mean_decides_the_level() {
        assert_eq!(
            board_verdict(&sample(Some(36.4), Some(39.9), Some(34.0))).level,
            Some(Level::Warn)
        );
        assert_eq!(
            board_verdict(&sample(Some(41.0), Some(40.1), Some(39.0))).level,
            Some(Level::Crit)
        );
        // Exactly at a threshold is not above it, and the worse level wins when
        // both hold.
        assert_eq!(
            board_verdict(&sample(Some(35.0), Some(40.0), Some(30.0))).level,
            None
        );
        // Back to normal is the low threshold, so a critical excursion ends when
        // the board is merely warm.
        assert!(board_verdict(&sample(Some(41.0), Some(41.0), Some(34.9))).settled);
        assert!(!board_verdict(&sample(Some(41.0), Some(41.0), Some(35.1))).settled);
    }

    #[test]
    fn an_incident_mails_once_per_level_and_once_on_the_way_out() {
        let mut watch = Watch::default();

        // First crossing: warn.
        match watch.observe(&verdict(Some(Level::Warn), false), at(0)) {
            Outcome::Fire { level, .. } => assert_eq!(level, Level::Warn),
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
            Outcome::Fire { level, .. } => assert_eq!(level, Level::Crit),
            _ => panic!("expected the escalation"),
        }
        assert!(matches!(
            watch.observe(&verdict(Some(Level::Warn), false), at(3)),
            Outcome::Quiet
        ));
        // Cooling: one recovery mail, with how long it lasted and how far it went.
        match watch.observe(&verdict(None, true), at(72)) {
            Outcome::Recover { peak, lasted, .. } => {
                assert_eq!(peak, Some(41.5));
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
        let mut watch = Watch::default();
        watch.observe(&verdict(Some(Level::Warn), false), at(0));
        // No samples: neither a level nor a settled window.
        assert!(matches!(
            watch.observe(&verdict(None, false), at(30)),
            Outcome::Quiet
        ));
        assert!(watch.incident.is_some(), "silence is not a recovery");
    }

    #[test]
    fn a_climb_after_the_recovery_mail_fires_again() {
        let mut watch = Watch::default();
        watch.observe(&verdict(Some(Level::Warn), false), at(0));
        assert!(matches!(
            watch.observe(&verdict(None, true), at(10)),
            Outcome::Recover { .. }
        ));
        // Still inside the tail of the hour-long mean, but hotter than what was
        // mailed: news, and it re-arms the recovery.
        assert!(matches!(
            watch.observe(&verdict(Some(Level::Crit), false), at(11)),
            Outcome::Fire {
                level: Level::Crit,
                ..
            }
        ));
    }

    #[test]
    fn the_query_reads_one_hour_and_carries_every_window() {
        let sql = board_sql(at(0));
        assert!(
            sql.contains("timestamp >= TIMESTAMPTZ '2026-11-06T11:00:00Z'"),
            "{sql}"
        );
        assert!(sql.contains("TIMESTAMPTZ '2026-11-06T11:55:00Z'"), "{sql}");
        assert!(sql.contains("TIMESTAMPTZ '2026-11-06T11:50:00Z'"), "{sql}");
        assert!(sql.contains("source = 'eos-stats'"));
        assert!(sql.contains("data.temp.board_c::DOUBLE"));
        assert!(sql.contains("v > 35"));
    }

    #[test]
    fn a_mail_quotes_the_mean_that_decided_it() {
        let fire = Outcome::Fire {
            level: Level::Warn,
            since: Some(at(0)),
        };
        let (title, body) = board_mail(&fire, &verdict(Some(Level::Warn), false)).unwrap();
        assert_eq!(title, "eos board temperature above 35 °C");
        assert!(body.contains("mean: 36.4 °C"), "{body}");
        assert!(body.contains("above 35 °C"), "{body}");
        assert!(body.contains("peak in the last hour: 41.5 °C"), "{body}");

        let recover = Outcome::Recover {
            level: Level::Crit,
            since: Some(at(0)),
            peak: Some(41.5),
            lasted: Duration::from_secs(72 * 60),
        };
        let (title, body) = board_mail(&recover, &verdict(None, true)).unwrap();
        assert_eq!(title, "eos board temperature back to normal");
        assert!(body.contains("back at 31.0 °C after 1 h 12 min"), "{body}");

        assert!(board_mail(&Outcome::Quiet, &verdict(None, true)).is_none());
    }

    #[test]
    fn durations_read_as_hours_minutes_and_seconds() {
        assert_eq!(span_duration(Duration::from_secs(48)), "48 s");
        assert_eq!(span_duration(Duration::from_secs(6 * 60)), "6 min");
        assert_eq!(span_duration(Duration::from_secs(3_600)), "1 h");
        assert_eq!(span_duration(Duration::from_secs(72 * 60)), "1 h 12 min");
    }
}
