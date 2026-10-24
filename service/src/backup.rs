//! Hourly S3 backup of completed files, plus restore.
//!
//! The backup is deliberately append-only: a file is uploaded once, by name,
//! and never deleted. Restoring the whole bucket can therefore yield two tiers
//! covering the same span, which the compaction reconcile collapses on its next
//! pass. Only closed buckets are uploaded: the hour files of the running day
//! give hour granularity, then day and month files carry the same rows once they
//! fold. Hot and recent files are skipped because they are superseded within the
//! hour.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{Timelike, Utc};
use futures::StreamExt;
use object_store::aws::{AmazonS3, AmazonS3Builder};
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, PutPayload};
use tracing::{info, warn};

use crate::config::BackupOptions;
use crate::storage;

/// Run one pass at startup, then one per hour at `minute` past the hour.
pub async fn run(data_dir: PathBuf, opts: BackupOptions) {
    let store = match client(&opts) {
        Ok(store) => store,
        Err(err) => {
            warn!(error = %err, "backup disabled: could not create the S3 client");
            return;
        }
    };

    loop {
        if let Err(err) = run_once(store.as_ref(), &data_dir, &opts).await {
            warn!(error = %err, "backup pass failed");
        }
        let wait = until_next_run(opts.minute);
        info!(seconds = wait.as_secs(), "next backup pass scheduled");
        tokio::time::sleep(wait).await;
    }
}

fn client(opts: &BackupOptions) -> Result<Arc<AmazonS3>, String> {
    let key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID is not set".to_string())?;
    let secret = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY is not set".to_string())?;

    // Logged once so a deploy can be checked against the provider's console: the
    // region is derived from a Backblaze endpoint when it is not set explicitly.
    info!(
        bucket = %opts.bucket,
        region = %opts.region,
        endpoint = opts.endpoint.as_deref().unwrap_or("aws"),
        prefix = %opts.prefix,
        "backup target"
    );

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

async fn run_once(
    store: &dyn ObjectStore,
    data_dir: &Path,
    opts: &BackupOptions,
) -> Result<(), String> {
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
    if wanted.is_empty() {
        return Ok(());
    }

    let mut existing: HashSet<ObjectPath> = HashSet::new();
    let prefix = prefix(opts);
    let mut listing = store.list(prefix.as_ref());
    while let Some(item) = listing.next().await {
        let meta = item.map_err(|e| format!("list: {e}"))?;
        existing.insert(meta.location);
    }

    let mut uploaded = 0usize;
    for (name, path) in wanted {
        let key = object_key(opts, &name);
        if existing.contains(&key) {
            continue;
        }
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|e| format!("{}: {e}", path.display()))?;
        store
            .put(&key, PutPayload::from(bytes))
            .await
            .map_err(|e| format!("put {key}: {e}"))?;
        uploaded += 1;
        info!(key = %key, "uploaded");
    }
    info!(uploaded, "backup pass complete");
    Ok(())
}

/// Download every backed-up object into `data_dir`. Existing files are kept
/// unless `force` is set.
pub async fn restore(data_dir: &Path, opts: &BackupOptions, force: bool) -> Result<(), String> {
    let store = client(opts)?;
    std::fs::create_dir_all(data_dir).map_err(|e| format!("{}: {e}", data_dir.display()))?;

    let mut downloaded = 0usize;
    let prefix = prefix(opts);
    let mut listing = store.list(prefix.as_ref());
    while let Some(item) = listing.next().await {
        let meta = item.map_err(|e| format!("list: {e}"))?;
        let Some(name) = meta.location.filename() else {
            continue;
        };
        let dest = data_dir.join(name);
        if dest.exists() && !force {
            info!(file = %dest.display(), "restore: keeping existing file");
            continue;
        }
        let bytes = store
            .get(&meta.location)
            .await
            .map_err(|e| format!("get {name}: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("read {name}: {e}"))?;
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
    info!(downloaded, "restore complete");
    Ok(())
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
    (next - now).to_std().unwrap_or_else(|_| Duration::from_secs(60))
}
