//! On-disk layout of the data directory.
//!
//! Files live flat in `data/` and are named after the arrival bucket they belong
//! to. Buckets are cut from arrival time, never from the `timestamp` column, so a
//! closed bucket can never receive another row and compaction stays append-only.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::{Datelike, NaiveDate, TimeZone, Utc};

pub const STAGING_DIR: &str = ".staging";
pub const TRASH_DIR: &str = ".trash";
pub const SEED_FILE: &str = "_seed.parquet";

pub const RECENT_MS: i64 = 300_000;
pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 86_400_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Hot,
    Recent,
    Hour,
    Day,
    Month,
}

#[derive(Clone, Debug)]
pub struct TierFile {
    pub tier: Tier,
    pub start_ms: i64,
    pub name: String,
    pub path: PathBuf,
}

pub fn staging_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(STAGING_DIR)
}

pub fn trash_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(TRASH_DIR)
}

pub fn ensure_dirs(data_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    std::fs::create_dir_all(staging_dir(data_dir))?;
    std::fs::create_dir_all(trash_dir(data_dir))?;
    Ok(())
}

/// Drop anything left in staging by a previous run. Staging only ever holds
/// in-progress builds, which are redone from scratch; `data/` is untouched.
pub fn clear_staging(staging: &Path) {
    let Ok(entries) = std::fs::read_dir(staging) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.path().is_file() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Parquet files the service owns. AppleDouble sidecars (`._name`) are macOS
/// metadata left behind by tar extraction, not data, and reading one fails the
/// view that spans the data directory.
fn is_data_file(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| !name.to_string_lossy().starts_with('.'))
        && path.extension().is_some_and(|ext| ext == "parquet")
}

pub fn has_parquet(data_dir: &Path) -> std::io::Result<bool> {
    for entry in std::fs::read_dir(data_dir)? {
        let entry = entry?;
        if is_data_file(&entry.path()) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Every current tier file in `data_dir`, in no particular order. Staging and
/// trash live in subdirectories and are therefore never listed.
pub fn list_tier_files(data_dir: &Path) -> std::io::Result<Vec<TierFile>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(data_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !is_data_file(&path) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some((tier, start_ms)) = parse_name(&name) {
            files.push(TierFile {
                tier,
                start_ms,
                name,
                path,
            });
        }
    }
    Ok(files)
}

/// Tier and bucket start of a file name, or `None` for anything the tiers do not
/// describe (`_seed`, the migration's `data.parquet`).
pub(crate) fn parse_name(name: &str) -> Option<(Tier, i64)> {
    let stem = name.strip_suffix(".parquet")?;
    if let Some(rest) = stem.strip_prefix("hot-") {
        // `hot-<flush_ms>`; a trailing `-<seq>` is tolerated for uniqueness.
        let ms = rest.split('-').next()?.parse().ok()?;
        Some((Tier::Hot, ms))
    } else if let Some(rest) = stem.strip_prefix("recent-") {
        let seconds: i64 = rest.parse().ok()?;
        Some((Tier::Recent, seconds * 1000))
    } else if let Some(rest) = stem.strip_prefix("hour-") {
        let seconds: i64 = rest.parse().ok()?;
        Some((Tier::Hour, seconds * 1000))
    } else if let Some(rest) = stem.strip_prefix("day-") {
        let date = NaiveDate::parse_from_str(rest, "%Y-%m-%d").ok()?;
        Some((Tier::Day, date_ms(date)?))
    } else if let Some(rest) = stem.strip_prefix("month-") {
        let (year, month) = rest.split_once('-')?;
        let date = NaiveDate::from_ymd_opt(year.parse().ok()?, month.parse().ok()?, 1)?;
        Some((Tier::Month, date_ms(date)?))
    } else {
        None
    }
}

pub fn hot_name(flush_ms: i64) -> String {
    format!("hot-{flush_ms}.parquet")
}

pub fn recent_name(recent_start_ms: i64) -> String {
    format!("recent-{}.parquet", recent_start_ms / 1000)
}

pub fn hour_name(hour_start_ms: i64) -> String {
    format!("hour-{}.parquet", hour_start_ms / 1000)
}

pub fn day_name(day_start_ms: i64) -> String {
    format!("day-{}.parquet", format_date(day_start_ms, "%Y-%m-%d"))
}

pub fn month_name(month_start_ms: i64) -> String {
    format!("month-{}.parquet", format_date(month_start_ms, "%Y-%m"))
}

pub fn recent_start_ms(ms: i64) -> i64 {
    ms - ms.rem_euclid(RECENT_MS)
}

pub fn hour_start_ms(ms: i64) -> i64 {
    ms - ms.rem_euclid(HOUR_MS)
}

pub fn day_start_ms(ms: i64) -> i64 {
    ms - ms.rem_euclid(DAY_MS)
}

pub fn month_start_ms(ms: i64) -> i64 {
    let dt = Utc
        .timestamp_millis_opt(ms)
        .single()
        .expect("valid epoch milliseconds");
    Utc.with_ymd_and_hms(dt.year(), dt.month(), 1, 0, 0, 0)
        .single()
        .expect("valid month start")
        .timestamp_millis()
}

pub fn next_month_ms(month_start_ms: i64) -> i64 {
    let dt = Utc
        .timestamp_millis_opt(month_start_ms)
        .single()
        .expect("valid month start");
    let (year, month) = if dt.month() == 12 {
        (dt.year() + 1, 1)
    } else {
        (dt.year(), dt.month() + 1)
    };
    Utc.with_ymd_and_hms(year, month, 1, 0, 0, 0)
        .single()
        .expect("valid month start")
        .timestamp_millis()
}

fn date_ms(date: NaiveDate) -> Option<i64> {
    let naive = date.and_hms_opt(0, 0, 0)?;
    Some(Utc.from_utc_datetime(&naive).timestamp_millis())
}

fn format_date(ms: i64, fmt: &str) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .expect("valid epoch milliseconds")
        .format(fmt)
        .to_string()
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Move a superseded file out of the read path. Same filesystem, so this is a
/// cheap rename.
pub fn move_to_trash(path: &Path, trash: &Path) -> std::io::Result<()> {
    let Some(name) = path.file_name() else {
        return Ok(());
    };
    std::fs::rename(path, trash.join(name))
}

/// Drop trash entries that have aged out. They are only kept around so a crashed
/// swap can be recovered; the data itself lives on in the tier files.
pub fn gc_trash(trash: &Path, retention: Duration) {
    let Ok(entries) = std::fs::read_dir(trash) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let old = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age >= retention);
        if old && meta.is_file() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
