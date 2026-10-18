//! Daily S3 backup of completed files, plus restore.
//!
//! The backup is deliberately append-only: a file is uploaded once, by name,
//! and never deleted. Restoring the whole bucket can therefore yield two tiers
//! covering the same span, which the compaction reconcile collapses on its next
//! pass. Only completed files are uploaded; hot, recent and hour files are
//! skipped because they are superseded within a day.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use futures::StreamExt;
use object_store::aws::{AmazonS3, AmazonS3Builder};
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, PutPayload};
use tracing::{info, warn};

use crate::config::BackupOptions;
use crate::storage;

/// Run one pass at startup, then one per day at `hour_utc`.
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
        let wait = until_next_run(opts.hour_utc);
        info!(seconds = wait.as_secs(), "next backup pass scheduled");
        tokio::time::sleep(wait).await;
    }
}

fn client(opts: &BackupOptions) -> Result<Arc<AmazonS3>, String> {
    let key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID is not set".to_string())?;
    let secret = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY is not set".to_string())?;

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
    // Back up completed tiers plus any archive file sitting at the top level
    // (the migration's `data.parquet`, before it is re-split into tiers). Hot,
    // recent and hour files are skipped: they are superseded within the day and
    // would only add short-lived objects. The seed carries no rows.
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
            || name.starts_with("recent-")
            || name.starts_with("hour-");
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

fn until_next_run(hour_utc: u32) -> Duration {
    let now = Utc::now();
    let today = now
        .date_naive()
        .and_hms_opt(hour_utc.min(23), 0, 0)
        .expect("valid hour");
    let mut next: DateTime<Utc> = Utc.from_utc_datetime(&today);
    if next <= now {
        next += chrono::Duration::days(1);
    }
    (next - now)
        .to_std()
        .unwrap_or_else(|_| Duration::from_secs(3_600))
}
