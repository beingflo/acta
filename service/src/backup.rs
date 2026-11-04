//! Hourly S3 backup of completed files, plus restore.
//!
//! The backup is deliberately append-only: a file is uploaded once, by name,
//! and never deleted. Restoring the whole bucket can therefore yield two tiers
//! covering the same span, which the compaction reconcile collapses on its next
//! pass. Only closed buckets are uploaded: the hour files of the running day
//! give hour granularity, then day and month files carry the same rows once they
//! fold. Hot and recent files are skipped because they are superseded within the
//! hour.
//!
//! Every pass also reports itself: one row in the `acta-backup` source says
//! whether it succeeded, how much it uploaded and how old the bucket was when it
//! started, so the archive answers "when did the backup last work" without
//! asking the bucket. That row is what the dashboard reads; it cannot outlive the
//! process, so an optional heartbeat URL is pinged after every error-free pass
//! and a monitor alarms when the pings stop.
//!
//! Every object is encrypted to an age recipient before it leaves the host, so
//! the bucket holds ciphertext and the provider can store the archive without
//! being able to read it. The recipient is a public key, held in the
//! configuration and logged with the rest of the target; the matching identity is
//! nowhere on the server, so only a machine that can unlock the vault can read
//! the archive back (see `restore`). Objects carry a [`SUFFIX`], which is what
//! makes an object that is not ciphertext obvious by name rather than a guess.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use age::x25519;
use chrono::{DateTime, Timelike, Utc};
use futures::StreamExt;
use object_store::aws::{AmazonS3, AmazonS3Builder};
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, PutPayload};
use tracing::{debug, error, info, warn};

use crate::config::{self, BackupOptions};
use crate::ingest::{self, IngestHandle};
use crate::storage;

/// The source the backup's own reports are filed under: one row per pass.
const SOURCE: &str = "acta-backup";

/// Suffix every uploaded object carries, so the bucket says by itself that an
/// object is ciphertext. A name without it is an archive from before the backup
/// was encrypted, not something restore should guess about.
const SUFFIX: &str = ".age";

/// Run one pass at startup, then one per hour at `minute` past the hour.
///
/// A pass that cannot build its client fails like any other and is retried next
/// hour, rather than ending the loop: a backup that stopped for the life of the
/// process would leave everything else looking healthy.
pub async fn run(data_dir: PathBuf, opts: BackupOptions, ingest: IngestHandle) {
    loop {
        let started = Instant::now();
        let result = pass(&data_dir, &opts).await;
        let elapsed = started.elapsed();
        match &result {
            Ok(pass) => info!(
                uploaded = pass.uploaded,
                bucket_age_s = pass.bucket_age_s,
                elapsed_ms = elapsed.as_millis() as u64,
                "backup pass complete"
            ),
            Err(err) => error!(error = %err, "backup pass failed"),
        }
        report(&ingest, &result, elapsed).await;
        if result.is_ok() {
            heartbeat().await;
        }
        let wait = until_next_run(opts.minute);
        info!(seconds = wait.as_secs(), "next backup pass scheduled");
        tokio::time::sleep(wait).await;
    }
}

/// What a pass did beyond succeeding: the numbers its report row carries.
struct Pass {
    uploaded: usize,
    /// Age of the newest object in the bucket, in seconds, measured before this
    /// pass uploaded anything: it says how fresh the backup was when the pass
    /// found it, which is the thing worth knowing. Trivially zero otherwise.
    bucket_age_s: Option<i64>,
}

/// Build a client and run one pass. The client is built per pass — it costs no
/// request — so a provider change takes effect without a restart.
async fn pass(data_dir: &Path, opts: &BackupOptions) -> Result<Pass, String> {
    let store = client(opts)?;
    run_once(store.as_ref(), data_dir, opts).await
}

fn client(opts: &BackupOptions) -> Result<Arc<AmazonS3>, String> {
    let key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID is not set".to_string())?;
    let secret = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY is not set".to_string())?;

    // Logged once so a deploy can be checked against the provider's console: the
    // region is derived from a Backblaze endpoint when it is not set explicitly.
    // The client is built per pass, so the line is guarded rather than repeated
    // every hour.
    static ANNOUNCED: std::sync::Once = std::sync::Once::new();
    ANNOUNCED.call_once(|| {
        // The recipient is public, so it is logged in full: this line is how a
        // deploy is checked against the key in the vault, and a wrong key has no
        // other symptom before a restore is attempted.
        info!(
            bucket = %opts.bucket,
            region = %opts.region,
            endpoint = opts.endpoint.as_deref().unwrap_or("aws"),
            prefix = %opts.prefix,
            recipient = %opts
                .recipient
                .as_ref()
                .map_or_else(|| "none".to_string(), std::string::ToString::to_string),
            "backup target"
        );
    });

    let mut builder = AmazonS3Builder::new()
        .with_bucket_name(&opts.bucket)
        .with_region(&opts.region)
        .with_access_key_id(key)
        .with_secret_access_key(secret)
        .with_allow_http(opts.allow_http);
    if let Some(endpoint) = &opts.endpoint {
        builder = builder.with_endpoint(endpoint);
    }
    builder
        .build()
        .map(Arc::new)
        .map_err(|e| format!("s3 client: {e}"))
}

/// Encrypt one whole file to the backup recipient.
///
/// `age` works on a whole buffer in memory and spends its time on the CPU, so it
/// runs on the blocking pool: a tier file is a few megabytes today, but nothing
/// in here is asynchronous and the upload task should not depend on the files
/// staying small.
async fn encrypt(
    recipient: &x25519::Recipient,
    name: &str,
    bytes: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let recipient = recipient.clone();
    let name = name.to_string();
    tokio::task::spawn_blocking(move || age::encrypt(&recipient, &bytes).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("{name}: encrypt task: {e}"))?
        .map_err(|e| format!("{name}: encrypt: {e}"))
}

/// Decrypt one object back into the file it was uploaded from.
async fn decrypt(
    identity: &x25519::Identity,
    name: &str,
    bytes: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let identity = identity.clone();
    let name = name.to_string();
    tokio::task::spawn_blocking(move || age::decrypt(&identity, &bytes).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("{name}: decrypt task: {e}"))?
        .map_err(|e| format!("{name}: decrypt: {e}"))
}

/// The backup's age identity, read where it is used and never carried in
/// `BackupOptions`, which is logged: it is the one secret that makes the archive
/// readable, and it is deliberately not installed on the server. Restore is
/// therefore something only a machine with the vault can do.
fn identity() -> Result<x25519::Identity, String> {
    let value = config::env_option("ACTA_BACKUP_AGE_IDENTITY").ok_or(
        "ACTA_BACKUP_AGE_IDENTITY is not set; the archive can only be read with the backup's age \
         identity",
    )?;
    value
        .parse()
        .map_err(|e| format!("ACTA_BACKUP_AGE_IDENTITY: {e}"))
}

/// The local name behind an object key. Everything that reasons about a name —
/// supersession, the destination path — wants the name the file had on disk.
fn stem(object: &str) -> Option<&str> {
    object.strip_suffix(SUFFIX)
}

async fn run_once(
    store: &dyn ObjectStore,
    data_dir: &Path,
    opts: &BackupOptions,
) -> Result<Pass, String> {
    // The bucket is listed on every pass, even one with nothing to upload: it is
    // the only step that talks to the provider, so it is what a pass succeeds at
    // when there is no new file to send.
    let prefix = prefix(opts);
    let mut existing: HashSet<ObjectPath> = HashSet::new();
    let mut newest: Option<DateTime<Utc>> = None;
    let mut listing = store.list(prefix.as_ref());
    while let Some(item) = listing.next().await {
        let meta = item.map_err(|e| format!("list: {e}"))?;
        newest = Some(newest.map_or(meta.last_modified, |at| at.max(meta.last_modified)));
        existing.insert(meta.location);
    }
    let bucket_age_s = newest.map(|at| (Utc::now() - at).num_seconds().max(0));

    // Back up closed buckets plus any archive file sitting at the top level (the
    // migration's `data.parquet`, before it is re-split into tiers). An `hour-`
    // file is only written once its hour has closed, so uploading it at the top
    // of the next hour gives hour granularity while it is still the newest file.
    // Hot and recent files are skipped: they are superseded within the hour. The
    // seed carries no rows.
    let mut wanted: Vec<(String, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(data_dir).map_err(|e| format!("{}: {e}", data_dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.path().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let skip = !name.ends_with(".parquet")
            || name == storage::SEED_FILE
            || name.starts_with("hot-")
            || name.starts_with("recent-");
        if !skip {
            wanted.push((name, entry.path()));
        }
    }

    // Present whenever backup is enabled: `parse_backup` refuses to start
    // otherwise, so a pass never gets this far without one.
    let recipient = opts
        .recipient
        .as_ref()
        .ok_or("ACTA_BACKUP_AGE_RECIPIENT is not set")?;

    let mut uploaded = 0usize;
    for (name, path) in wanted {
        let key = object_key(opts, &format!("{name}{SUFFIX}"));
        if existing.contains(&key) {
            continue;
        }
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let ciphertext = encrypt(recipient, &name, bytes).await?;
        store
            .put(&key, PutPayload::from(ciphertext))
            .await
            .map_err(|e| format!("put {key}: {e}"))?;
        uploaded += 1;
        info!(key = %key, "uploaded");
    }
    Ok(Pass {
        uploaded,
        bucket_age_s,
    })
}

/// Record the pass in the archive.
///
/// A row per hour is the cheapest way to make the backup's own history
/// queryable: the dashboard reads the newest success off it, and a failure keeps
/// its message next to the timestamp that says when it happened. Rows are small
/// and land in a hot file like any other, so they are compacted and backed up
/// with everything else.
async fn report(ingest: &IngestHandle, result: &Result<Pass, String>, elapsed: Duration) {
    let duration_ms = elapsed.as_millis() as u64;
    let data = match result {
        Ok(pass) => serde_json::json!({
            "ok": true,
            "uploaded": pass.uploaded,
            "bucket_age_s": pass.bucket_age_s,
            "duration_ms": duration_ms,
        }),
        Err(err) => serde_json::json!({
            "ok": false,
            "error": shorten(err),
            "duration_ms": duration_ms,
        }),
    };
    let item = ingest::IngestItem {
        source: SOURCE.to_string(),
        timestamp: None,
        data,
    };
    let row = match ingest::item_to_row(item, ingest::now_us()) {
        Ok(row) => row,
        Err(err) => {
            warn!(error = %err, "backup: could not build the report row");
            return;
        }
    };
    // The backlog is unbounded from this side, and a wedged writer must not take
    // the backup down with it: the row is worth missing, the pass is not.
    let submitted = tokio::time::timeout(Duration::from_secs(30), ingest.submit(vec![row])).await;
    match submitted {
        Ok(Ok(())) => {}
        Ok(Err(err)) => warn!(error = %err, "backup: could not record the pass"),
        Err(_) => warn!("backup: the ingest buffer did not take the report row"),
    }
}

/// One line, not a log: an error is a card's detail row and a value in the
/// archive, so keep the head of it and say how much was dropped.
fn shorten(err: &str) -> String {
    const MAX: usize = 200;
    let mut head: String = err.chars().take(MAX).collect();
    if err.chars().count() > MAX {
        head.push('…');
    }
    head
}

/// Ping the dead-man's switch after an error-free pass, if one is configured.
///
/// The report row proves the backup to whoever reads the dashboard; this proves
/// it to something that notices when the whole process is gone, which no row can
/// do. Nothing is sent for a failed pass: the monitor's grace window is the
/// alarm, and the row says what went wrong. The URL is the credential — anyone
/// holding it can fake a heartbeat — so it is read from the environment where it
/// is used, never from `BackupOptions`, which is logged at startup, and the error
/// is logged `without_url` because it would otherwise print it.
async fn heartbeat() {
    let Some(url) = config::env_option("ACTA_BACKUP_PING_URL") else {
        return;
    };
    let response = reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => {
            debug!(status = response.status().as_u16(), "backup heartbeat sent");
        }
        Ok(response) => warn!(
            status = response.status().as_u16(),
            "backup heartbeat was refused"
        ),
        Err(err) => warn!(error = %err.without_url(), "backup heartbeat failed"),
    }
}

/// Whether a heartbeat URL is configured, for the startup log: the URL is a
/// secret, so only its presence is reported.
pub fn heartbeat_configured() -> bool {
    config::env_option("ACTA_BACKUP_PING_URL").is_some()
}

/// Download the backed-up objects into `data_dir`, decrypting them, coarsest tier
/// first. Existing files are kept unless `force` is set.
///
/// The backup is append-only, so a file and the coarser file built from it both
/// stay in the bucket for good. Downloading both would only rewrite what the next
/// compaction pass moves to `.trash/`, so an object is skipped when the bucket
/// also holds a coarser file that supersedes it. Nothing is dropped: the check is
/// per object, so a span whose coarser file was never uploaded (the service was
/// down at the fold) is restored from its finer files as before.
pub async fn restore(data_dir: &Path, opts: &BackupOptions, force: bool) -> Result<(), String> {
    let store = client(opts)?;
    let identity = identity()?;
    std::fs::create_dir_all(data_dir).map_err(|e| format!("{}: {e}", data_dir.display()))?;

    let prefix = prefix(opts);
    let mut objects = Vec::new();
    let mut listing = store.list(prefix.as_ref());
    while let Some(item) = listing.next().await {
        objects.push(item.map_err(|e| format!("list: {e}"))?);
    }
    // Names only: supersession is decided against the whole bucket before the
    // first download starts.
    let present: HashSet<String> = objects
        .iter()
        .filter_map(|meta| meta.location.filename().and_then(stem).map(str::to_owned))
        .collect();

    let mut downloaded = 0usize;
    let mut superseded = 0usize;
    for meta in objects {
        let Some(object) = meta.location.filename() else {
            continue;
        };
        let Some(name) = stem(object) else {
            return Err(format!(
                "{object}: not an encrypted object (no {SUFFIX} suffix); the bucket holds an \
                 archive from before the backup was encrypted"
            ));
        };
        if covered(name, &present) {
            superseded += 1;
            continue;
        }
        let dest = data_dir.join(name);
        if dest.exists() && !force {
            info!(file = %dest.display(), "restore: keeping existing file");
            continue;
        }
        let ciphertext = store
            .get(&meta.location)
            .await
            .map_err(|e| format!("get {object}: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("read {object}: {e}"))?
            .to_vec();
        let bytes = decrypt(&identity, name, ciphertext).await?;
        let tmp = data_dir.join(format!(".{name}.tmp"));
        tokio::fs::write(&tmp, &bytes)
            .await
            .map_err(|e| format!("{}: {e}", tmp.display()))?;
        tokio::fs::rename(&tmp, &dest)
            .await
            .map_err(|e| format!("{}: {e}", dest.display()))?;
        downloaded += 1;
        info!(file = %dest.display(), "restored");
    }
    info!(downloaded, superseded, "restore complete");
    Ok(())
}

/// True when the bucket also holds a coarser file that was built from `name`.
///
/// Compaction folds a day only from a whole day of hours, and a month only once
/// no finer file of it is left, so the coarser file is by construction a complete
/// superset and the finer one need not travel.
fn covered(name: &str, present: &HashSet<String>) -> bool {
    let Some((tier, start_ms)) = storage::parse_name(name) else {
        return false;
    };
    let day = storage::day_name(storage::day_start_ms(start_ms));
    let month = storage::month_name(storage::month_start_ms(start_ms));
    match tier {
        storage::Tier::Hour => present.contains(&day) || present.contains(&month),
        storage::Tier::Day => present.contains(&month),
        storage::Tier::Hot | storage::Tier::Recent | storage::Tier::Month => false,
    }
}

fn object_key(opts: &BackupOptions, name: &str) -> ObjectPath {
    if opts.prefix.is_empty() {
        ObjectPath::from(name)
    } else {
        ObjectPath::from(format!("{}/{}", opts.prefix.trim_end_matches('/'), name))
    }
}

fn prefix(opts: &BackupOptions) -> Option<ObjectPath> {
    if opts.prefix.is_empty() {
        None
    } else {
        Some(ObjectPath::from(opts.prefix.trim_end_matches('/')))
    }
}

/// Time until `minute` past the next hour. Compaction builds an hour file
/// shortly after its hour closes, so a pass at a few minutes past the hour sees
/// the file of the hour that just ended.
fn until_next_run(minute: u32) -> Duration {
    let now = Utc::now();
    let mut next = now
        .with_minute(minute.min(59))
        .and_then(|t| t.with_second(0))
        .and_then(|t| t.with_nanosecond(0))
        .expect("valid minute");
    if next <= now {
        next += chrono::Duration::hours(1);
    }
    (next - now)
        .to_std()
        .unwrap_or_else(|_| Duration::from_secs(60))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{covered, shorten, stem};
    use crate::storage;

    fn set(names: &[&str]) -> HashSet<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    #[test]
    fn a_coarser_file_supersedes_the_finer_ones() {
        let hour = 1_793_404_800_000;
        let hour_name = storage::hour_name(hour);
        let day_name = storage::day_name(storage::day_start_ms(hour));
        let month_name = storage::month_name(storage::month_start_ms(hour));

        // An hour is covered by its day, and by the month even if the day file
        // was never uploaded.
        assert!(covered(&hour_name, &set(&[&day_name])));
        assert!(covered(&hour_name, &set(&[&month_name])));
        assert!(covered(&day_name, &set(&[&month_name])));

        // Nothing coarser present means the finer file is what restores the span.
        assert!(!covered(&hour_name, &set(&[])));
        assert!(!covered(&hour_name, &set(&[&hour_name])));
        assert!(!covered(&day_name, &set(&[&hour_name])));
        assert!(!covered(&month_name, &set(&[&day_name, &hour_name])));

        // Files outside the tiers (`data.parquet`) are always fetched.
        assert!(!covered("data.parquet", &set(&[&month_name])));
    }

    #[tokio::test]
    async fn an_object_decrypts_to_the_file_it_was_uploaded_from() {
        let identity = age::x25519::Identity::generate();
        let plaintext = b"PAR1 some made-up parquet bytes PAR1".to_vec();

        let ciphertext = super::encrypt(
            &identity.to_public(),
            "day-2026-11-01.parquet",
            plaintext.clone(),
        )
        .await
        .expect("encrypt");
        assert_ne!(ciphertext, plaintext);

        let restored = super::decrypt(&identity, "day-2026-11-01.parquet", ciphertext)
            .await
            .expect("decrypt");
        assert_eq!(restored, plaintext);
    }

    #[test]
    fn a_name_without_the_suffix_is_not_an_object_of_this_archive() {
        assert_eq!(stem("hour-1.parquet.age"), Some("hour-1.parquet"));
        assert_eq!(stem("hour-1.parquet"), None);
    }

    #[test]
    fn a_reported_error_is_one_short_line() {
        assert_eq!(
            shorten("put hour-1.parquet: 403 AccessDenied"),
            "put hour-1.parquet: 403 AccessDenied"
        );

        // Long messages are cut, and the ellipsis says so rather than letting the
        // row look like the whole error.
        let long = "x".repeat(500);
        let cut = shorten(&long);
        assert_eq!(cut.chars().count(), 201);
        assert!(cut.ends_with('…'));

        // Counted in characters, not bytes: an accented provider message must
        // not panic on a slice boundary.
        let accented = "é".repeat(300);
        assert_eq!(shorten(&accented).chars().count(), 201);
    }
}
