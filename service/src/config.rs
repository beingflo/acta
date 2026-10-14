use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use crate::db::DbOptions;

/// Runtime configuration, all overridable via environment variables.
#[derive(Debug)]
pub struct Settings {
    pub addr: SocketAddr,
    pub ui_dir: PathBuf,
    pub db: DbOptions,
}

impl Settings {
    pub fn from_env() -> Result<Self, String> {
        let addr = env_str("ACTA_ADDR", "127.0.0.1:8080")
            .parse()
            .map_err(|e| format!("ACTA_ADDR: {e}"))?;

        let ui_dir = PathBuf::from(env_str("ACTA_UI_DIR", "ui/dist"));

        let db = DbOptions {
            data_dir: PathBuf::from(env_str("ACTA_DATA_DIR", "data")),
            pool_size: env_parse("ACTA_POOL_SIZE", 4)?,
            memory_limit: env_str("ACTA_MEMORY_LIMIT", "1GB"),
            threads: env_parse("ACTA_THREADS", 2)?,
            query_timeout: Duration::from_millis(env_parse("ACTA_QUERY_TIMEOUT_MS", 10_000)?),
            max_response_bytes: env_parse("ACTA_MAX_RESPONSE_BYTES", 8 * 1024 * 1024)?,
        };

        Ok(Self { addr, ui_dir, db })
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
