use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use crate::db::DbOptions;

/// Runtime configuration, all overridable via environment variables.
#[derive(Debug)]
pub struct Settings {
    pub addr: SocketAddr,
    pub ui_dir: PathBuf,
    pub tiles_dir: PathBuf,
    pub db: DbOptions,
    pub write: WriteOptions,
}

/// Write path configuration.
#[derive(Clone, Debug)]
pub struct WriteOptions {
    pub flush_interval: Duration,
    pub flush_max_rows: usize,
    pub flush_max_bytes: usize,
    pub backlog: usize,
    pub compaction_interval: Duration,
    pub compaction_grace: Duration,
    pub row_group_size: usize,
    pub trash_retention: Duration,
    pub trash_gc_interval: Duration,
    pub ingest_max_body_bytes: usize,
    pub ingest_max_batch: usize,
}

impl Settings {
    pub fn from_env() -> Result<Self, String> {
        let addr = env_str("ACTA_ADDR", "127.0.0.1:8080")
            .parse()
            .map_err(|e| format!("ACTA_ADDR: {e}"))?;

        let ui_dir = PathBuf::from(env_str("ACTA_UI_DIR", "ui/dist"));
        let tiles_dir = PathBuf::from(env_str("ACTA_TILES_DIR", "tiles"));

        let db = DbOptions {
            data_dir: PathBuf::from(env_str("ACTA_DATA_DIR", "data")),
            pool_size: env_parse("ACTA_POOL_SIZE", 4)?,
            memory_limit: env_str("ACTA_MEMORY_LIMIT", "1GB"),
            threads: env_parse("ACTA_THREADS", 1)?,
            query_timeout: Duration::from_millis(env_parse("ACTA_QUERY_TIMEOUT_MS", 10_000)?),
            max_response_bytes: env_parse("ACTA_MAX_RESPONSE_BYTES", 8 * 1024 * 1024)?,
        };

        let write = WriteOptions {
            flush_interval: Duration::from_millis(env_parse("ACTA_FLUSH_INTERVAL_MS", 10_000)?),
            flush_max_rows: env_parse("ACTA_FLUSH_MAX_ROWS", 50_000)?,
            flush_max_bytes: env_parse("ACTA_FLUSH_MAX_BYTES", 64 * 1024 * 1024)?,
            backlog: env_parse("ACTA_INGEST_BACKLOG", 256)?,
            compaction_interval: Duration::from_millis(env_parse(
                "ACTA_COMPACTION_INTERVAL_MS",
                60_000,
            )?),
            compaction_grace: Duration::from_millis(env_parse(
                "ACTA_COMPACTION_GRACE_MS",
                30_000,
            )?),
            row_group_size: env_parse("ACTA_ROW_GROUP_SIZE", 250_000)?,
            trash_retention: Duration::from_millis(env_parse("ACTA_TRASH_RETENTION_MS", 86_400_000)?),
            trash_gc_interval: Duration::from_millis(env_parse(
                "ACTA_TRASH_GC_INTERVAL_MS",
                600_000,
            )?),
            ingest_max_body_bytes: env_parse("ACTA_INGEST_MAX_BODY_BYTES", 16 * 1024 * 1024)?,
            ingest_max_batch: env_parse("ACTA_INGEST_MAX_BATCH", 10_000)?,
        };

        Ok(Self {
            addr,
            ui_dir,
            tiles_dir,
            db,
            write,
        })
    }
}

fn env_str(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> Result<T, String>
where
    T::Err: std::fmt::Display,
{
    match std::env::var(key) {
        Ok(v) => v.parse().map_err(|e| format!("{key}: {e}")),
        Err(_) => Ok(default),
    }
}
