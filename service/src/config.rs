use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use crate::auth::{Auth, Credential};
use crate::db::DbOptions;

/// Runtime configuration, all overridable via environment variables.
#[derive(Debug)]
pub struct Settings {
    pub addr: SocketAddr,
    pub ui_dir: PathBuf,
    pub tiles_dir: PathBuf,
    pub db: DbOptions,
    pub write: WriteOptions,
    pub auth: Auth,
    pub backup: BackupOptions,
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

/// Hourly S3 backup configuration. Credentials are read from the standard
/// `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` variables and are deliberately
/// not stored here, so this struct is safe to log.
#[derive(Clone, Debug)]
pub struct BackupOptions {
    pub enabled: bool,
    pub bucket: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub prefix: String,
    pub minute: u32,
    pub allow_http: bool,
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

        let auth = parse_auth()?;
        let backup = parse_backup()?;

        Ok(Self {
            addr,
            ui_dir,
            tiles_dir,
            db,
            write,
            auth,
            backup,
        })
    }
}

/// The UI credential enables authentication. The sensor credential is optional
/// and, if present, may only reach `POST /api/ingest`.
fn parse_auth() -> Result<Auth, String> {
    let ui = credential("ACTA_AUTH_UI_USER", "ACTA_AUTH_UI_PASSWORD")?;
    let sensor = credential("ACTA_AUTH_SENSOR_USER", "ACTA_AUTH_SENSOR_PASSWORD")?;
    if ui.is_none() && sensor.is_some() {
        return Err(
            "ACTA_AUTH_SENSOR_* is set without ACTA_AUTH_UI_*; refusing to leave the UI open".into(),
        );
    }
    Ok(Auth::new(ui, sensor))
}

fn credential(user_key: &str, password_key: &str) -> Result<Option<Credential>, String> {
    match (std::env::var(user_key).ok(), std::env::var(password_key).ok()) {
        (None, None) => Ok(None),
        (Some(user), Some(password)) if !user.is_empty() && !password.is_empty() => {
            Ok(Some(Credential { user, password }))
        }
        _ => Err(format!(
            "{user_key} and {password_key} must both be set and non-empty"
        )),
    }
}

fn parse_backup() -> Result<BackupOptions, String> {
    let enabled = env_bool("ACTA_BACKUP", false)?;
    let bucket = env_str("ACTA_S3_BUCKET", "");
    let allow_http = env_bool("ACTA_S3_ALLOW_HTTP", false)?;
    let endpoint = std::env::var("ACTA_S3_ENDPOINT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| s3_endpoint(&value, allow_http))
        .transpose()?;
    // A Backblaze endpoint names its own region (`s3.<region>.backblazeb2.com`),
    // so bucket plus endpoint is enough there. Any other provider sets the region
    // explicitly, or gets the AWS default.
    let region = match env_str("ACTA_S3_REGION", "") {
        region if !region.is_empty() => region,
        _ => endpoint
            .as_deref()
            .and_then(region_from_endpoint)
            .unwrap_or_else(|| "us-east-1".to_string()),
    };
    let prefix = env_str("ACTA_S3_PREFIX", "");
    let minute = env_parse("ACTA_BACKUP_MINUTE", 3u32)?;

    if minute > 59 {
        return Err("ACTA_BACKUP_MINUTE must be between 0 and 59".into());
    }
    if enabled {
        if bucket.is_empty() {
            return Err("ACTA_BACKUP is on but ACTA_S3_BUCKET is empty".into());
        }
        for key in ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] {
            if std::env::var(key).is_err() {
                return Err(format!("ACTA_BACKUP is on but {key} is not set"));
            }
        }
    }

    Ok(BackupOptions {
        enabled,
        bucket,
        region,
        endpoint,
        prefix,
        minute,
        allow_http,
    })
}

/// The S3 client parses this as a URL and panics on a value it cannot read, so
/// an unusable endpoint has to stop startup here instead. The scheme is required:
/// providers print the bare host, and prefixing it silently is the kind of magic
/// that hides a mistake until a request fails.
fn s3_endpoint(endpoint: &str, allow_http: bool) -> Result<String, String> {
    let endpoint = endpoint.trim();
    let (scheme, rest) = match endpoint.strip_prefix("https://") {
        Some(rest) => ("https", rest),
        None => match endpoint.strip_prefix("http://") {
            Some(rest) => ("http", rest),
            None => return Err("ACTA_S3_ENDPOINT must start with http:// or https://".into()),
        },
    };
    if scheme == "http" && !allow_http {
        return Err("ACTA_S3_ENDPOINT is plain HTTP; set ACTA_S3_ALLOW_HTTP=on to allow it".into());
    }
    let host = rest.trim_end_matches('/');
    if host.is_empty() {
        return Err("ACTA_S3_ENDPOINT has no host".into());
    }
    Ok(format!("{scheme}://{host}"))
}

fn region_from_endpoint(endpoint: &str) -> Option<String> {
    let rest = endpoint.split_once("://").map_or(endpoint, |(_, rest)| rest);
    let host = rest.split('/').next().unwrap_or(rest);
    let host = host.split(':').next().unwrap_or(host);
    let region = host.strip_prefix("s3.")?.strip_suffix(".backblazeb2.com")?;
    (!region.is_empty()).then(|| region.to_string())
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

fn env_bool(key: &str, default: bool) -> Result<bool, String> {
    match std::env::var(key) {
        Ok(value) => match value.as_str() {
            "1" | "true" | "on" | "yes" => Ok(true),
            "0" | "false" | "off" | "no" => Ok(false),
            other => Err(format!("{key}: expected a boolean, got {other:?}")),
        },
        Err(_) => Ok(default),
    }
}
