//! Write path: accept JSON, buffer it, flush it to Parquet.
//!
//! Rows are buffered in memory and flushed to one `hot-` file per interval. A
//! flush is bucketed by arrival time, so a closed bucket can never receive
//! another row and compaction (see `compact.rs`) stays append-only.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{Notify, RwLock, mpsc};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

use crate::compact;
use crate::config::WriteOptions;
use crate::parquet::{self, Row};
use crate::storage;

/// One element of a `POST /api/ingest` batch.
#[derive(Deserialize)]
pub struct IngestItem {
    pub source: String,
    /// Event time as an RFC 3339 string or an epoch number. Defaults to the
    /// server's receive time.
    #[serde(default)]
    pub timestamp: Option<Value>,
    pub data: Value,
}

#[derive(Clone)]
pub struct IngestHandle {
    tx: mpsc::Sender<Vec<Row>>,
}

impl IngestHandle {
    /// Hand a batch to the buffer. Waits when the backlog is full, so a stalled
    /// writer applies backpressure to the sender instead of dropping rows.
    pub async fn submit(&self, rows: Vec<Row>) -> Result<(), String> {
        self.tx
            .send(rows)
            .await
            .map_err(|_| "ingest buffer is not running".to_string())
    }
}

/// Create the data directory, and a zero-row seed file if it holds no Parquet
/// yet, so the read view can always bind.
pub async fn prepare(data_dir: &Path) -> Result<(), String> {
    let data_dir = data_dir.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        storage::ensure_dirs(&data_dir)
            .map_err(|e| format!("data dir {}: {e}", data_dir.display()))?;
        storage::clear_staging(&storage::staging_dir(&data_dir));
        if storage::has_parquet(&data_dir).map_err(|e| e.to_string())? {
            return Ok(());
        }
        let staging = storage::staging_dir(&data_dir);
        let seed = parquet::write_seed(&staging)?;
        let target = data_dir.join(storage::SEED_FILE);
        std::fs::rename(&seed, &target).map_err(|e| format!("{}: {e}", target.display()))?;
        tracing::info!(path = %target.display(), "wrote seed parquet for an empty data directory");
        Ok(())
    })
    .await
    .map_err(|e| format!("prepare task failed: {e}"))?
}

/// The running write path. Main keeps this so it can flush the buffer before
/// the process exits.
pub struct Ingest {
    handle: IngestHandle,
    shutdown: Arc<Notify>,
    buffer_task: JoinHandle<()>,
    writer_task: JoinHandle<()>,
}

impl Ingest {
    pub fn handle(&self) -> IngestHandle {
        self.handle.clone()
    }

    /// Hand the buffered rows to the writer and wait for both loops to finish.
    pub async fn shutdown(self) {
        self.shutdown.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(15), self.buffer_task).await;
        let _ = tokio::time::timeout(Duration::from_secs(15), self.writer_task).await;
    }
}

/// Full buffers that may wait behind the one being written. One is enough to
/// keep buffering through a flush while bounding memory to a few batches.
const FLUSH_QUEUE: usize = 1;

/// Start the buffer, writer and compaction tasks.
pub fn start(data_dir: PathBuf, opts: WriteOptions, lock: Arc<RwLock<()>>) -> Ingest {
    let (tx, rx) = mpsc::channel(opts.backlog.max(1));
    let (flush_tx, flush_rx) = mpsc::channel::<Vec<Row>>(FLUSH_QUEUE);

    let writer_data_dir = data_dir.clone();
    let writer_staging = storage::staging_dir(&data_dir);
    let writer_opts = opts.clone();
    let writer_task = tokio::spawn(async move {
        if let Err(err) = writer_loop(flush_rx, writer_data_dir, writer_staging, writer_opts).await {
            tracing::error!(error = %err, "ingest writer loop stopped");
        }
    });

    let buffer_opts = opts.clone();
    let shutdown = Arc::new(Notify::new());
    let buffer_shutdown = Arc::clone(&shutdown);
    let buffer_task = tokio::spawn(async move {
        if let Err(err) = buffer_loop(rx, flush_tx, buffer_opts, buffer_shutdown).await {
            tracing::error!(error = %err, "ingest buffer loop stopped");
        }
    });

    let context = Arc::new(compact::Context {
        grace_ms: opts.compaction_grace.as_millis() as i64,
        data_dir: data_dir.clone(),
        staging: storage::staging_dir(&data_dir),
        trash: storage::trash_dir(&data_dir),
        lock,
        opts,
    });
    tokio::spawn(compact::run(context));

    Ingest {
        handle: IngestHandle { tx },
        shutdown,
        buffer_task,
        writer_task,
    }
}

pub fn now_us() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or_default()
}

pub fn item_to_row(item: IngestItem, now_us: i64) -> Result<Row, String> {
    let source = item.source.trim();
    if source.is_empty() {
        return Err("source must not be empty".to_string());
    }
    if source.len() > 256 {
        return Err("source is longer than 256 bytes".to_string());
    }
    if source.chars().any(char::is_control) {
        return Err("source contains control characters".to_string());
    }

    let ts_us = match item.timestamp {
        None | Some(Value::Null) => now_us,
        Some(value) => parse_timestamp(&value)?,
    };
    let data_json = serde_json::to_string(&item.data).map_err(|e| e.to_string())?;

    Ok(Row {
        ts_us,
        source: source.to_string(),
        data_json,
    })
}

fn parse_timestamp(value: &Value) -> Result<i64, String> {
    match value {
        Value::Number(number) => {
            let value = number.as_f64().ok_or("timestamp is out of range")?;
            let micros = if value.abs() >= 1e14 {
                value
            } else if value.abs() >= 1e11 {
                value * 1e3
            } else {
                value * 1e6
            };
            Ok(micros as i64)
        }
        Value::String(text) => parse_timestamp_str(text),
        _ => Err("timestamp must be an RFC 3339 string or an epoch number".to_string()),
    }
}

fn parse_timestamp_str(text: &str) -> Result<i64, String> {
    let text = text.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(text) {
        return Ok(dt.timestamp_micros());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(text, format) {
            return Ok(Utc.from_utc_datetime(&naive).timestamp_micros());
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        let naive = date.and_hms_opt(0, 0, 0).ok_or("invalid date")?;
        return Ok(Utc.from_utc_datetime(&naive).timestamp_micros());
    }
    Err(format!("invalid timestamp {text:?}"))
}

struct Buffer {
    rows: Vec<Row>,
    bytes: usize,
}

impl Buffer {
    fn new() -> Self {
        Self {
            rows: Vec::new(),
            bytes: 0,
        }
    }

    fn push(&mut self, rows: Vec<Row>) {
        for row in rows {
            self.bytes += row.source.len() + row.data_json.len() + 24;
            self.rows.push(row);
        }
    }

    fn take(&mut self) -> Option<Vec<Row>> {
        if self.rows.is_empty() {
            return None;
        }
        self.bytes = 0;
        Some(std::mem::take(&mut self.rows))
    }
}

/// Receive batches into a buffer and hand full buffers to the writer. The write
/// happens on another task, so buffering the next batch never waits for a
/// flush; only a writer that cannot keep up pushes back.
async fn buffer_loop(
    mut rx: mpsc::Receiver<Vec<Row>>,
    flush_tx: mpsc::Sender<Vec<Row>>,
    opts: WriteOptions,
    shutdown: Arc<Notify>,
) -> Result<(), String> {
    let mut buffer = Buffer::new();
    let mut ticker = tokio::time::interval(opts.flush_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ticker.tick().await; // the first tick fires immediately

    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            received = rx.recv() => match received {
                Some(rows) => {
                    buffer.push(rows);
                    if buffer.rows.len() >= opts.flush_max_rows || buffer.bytes >= opts.flush_max_bytes {
                        hand_off(&mut buffer, &flush_tx).await;
                    }
                }
                None => break,
            },
            _ = ticker.tick() => {
                if !buffer.rows.is_empty() {
                    hand_off(&mut buffer, &flush_tx).await;
                }
            }
        }
    }

    hand_off(&mut buffer, &flush_tx).await;
    Ok(())
}

async fn hand_off(buffer: &mut Buffer, tx: &mpsc::Sender<Vec<Row>>) {
    if let Some(rows) = buffer.take()
        && tx.send(rows).await.is_err()
    {
        tracing::error!("flush writer is gone; dropping buffered rows");
    }
}

async fn writer_loop(
    mut rx: mpsc::Receiver<Vec<Row>>,
    data_dir: PathBuf,
    staging: PathBuf,
    opts: WriteOptions,
) -> Result<(), String> {
    while let Some(rows) = rx.recv().await {
        write_buffer(&data_dir, &staging, &opts, rows).await;
    }
    Ok(())
}

/// Write one buffer, retrying a few times so a transient failure does not lose
/// data. A persistent failure drops the batch, loudly.
async fn write_buffer(data_dir: &Path, staging: &Path, opts: &WriteOptions, rows: Vec<Row>) {
    let count = rows.len();
    let row_group_size = opts.row_group_size;
    let mut rows = rows;

    for attempt in 1..=3u32 {
        let name = unique_hot_name(data_dir);
        let staging = staging.to_path_buf();
        let target = data_dir.join(&name);
        let batch = rows;
        let outcome = tokio::task::spawn_blocking(move || -> Result<(), (String, Vec<Row>)> {
            let staged = match parquet::write_hot(&staging, &name, &batch, row_group_size) {
                Ok(path) => path,
                Err(err) => return Err((err, batch)),
            };
            if let Err(err) = std::fs::rename(&staged, &target) {
                return Err((format!("{}: {err}", target.display()), batch));
            }
            Ok(())
        })
        .await;

        match outcome {
            Ok(Ok(())) => {
                tracing::debug!(rows = count, "flushed hot file");
                return;
            }
            Ok(Err((err, batch))) => {
                rows = batch;
                tracing::warn!(error = %err, attempt, rows = rows.len(), "flush failed; retrying");
                tokio::time::sleep(Duration::from_millis(200 * u64::from(attempt))).await;
            }
            Err(err) => {
                tracing::error!(error = %err, rows = count, "flush task failed; rows lost");
                return;
            }
        }
    }

    tracing::error!(rows = rows.len(), "dropping rows after repeated flush failures");
}

fn unique_hot_name(data_dir: &Path) -> String {
    let mut ms = storage::now_ms();
    loop {
        let name = storage::hot_name(ms);
        if !data_dir.join(&name).exists() {
            return name;
        }
        ms += 1;
    }
}
