//! Writing and rewriting Parquet files with DuckDB.
//!
//! Every file carries the acta schema `timestamp TIMESTAMPTZ, source VARCHAR,
//! data VARIANT` and is sorted by `source, timestamp` so a source's rows stay
//! contiguous and row-group statistics can skip other sources.

use std::path::{Path, PathBuf};

use duckdb::{Config, Connection};

/// One buffered row, before it is typed into the Parquet schema.
#[derive(Debug, Clone)]
pub struct Row {
    /// Event time in microseconds since the Unix epoch.
    pub ts_us: i64,
    pub source: String,
    /// The payload as JSON text; it is cast to `VARIANT` on the way out.
    pub data_json: String,
}

/// Write one flush as a `hot-` file. Returns the path inside `staging`.
pub fn write_hot(
    staging: &Path,
    name: &str,
    rows: &[Row],
    row_group_size: usize,
) -> Result<PathBuf, String> {
    let conn = writer()?;
    conn.execute_batch("CREATE TABLE buf (ts_us BIGINT, source VARCHAR, data_json VARCHAR)")
        .map_err(|e| e.to_string())?;
    {
        let mut appender = conn.appender("buf").map_err(|e| e.to_string())?;
        for row in rows {
            appender
                .append_row((row.ts_us, row.source.as_str(), row.data_json.as_str()))
                .map_err(|e| e.to_string())?;
        }
        appender.flush().map_err(|e| e.to_string())?;
    }

    // `make_timestamptz` would be the direct way to build the column, but it
    // needs the `icu` extension in DuckDB 2.0 and fails the flush. Building a
    // naive timestamp from the same microseconds and casting it is pure core
    // arithmetic, and the build has no `icu`, so the session zone is UTC.
    let copy = format!(
        "COPY (SELECT CAST(make_timestamp(ts_us) AS TIMESTAMPTZ) AS timestamp, source, \
                    CAST(CAST(data_json AS JSON) AS VARIANT) AS data \
         FROM buf ORDER BY source, timestamp) \
         TO {} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE {row_group_size})",
        quote(&staging.join(format!("{name}.tmp")))
    );
    run(&conn, &copy)?;
    publish(tmp_path(staging, name), staging.join(name))
}

/// Merge tier files into one file. Inputs are read with `union_by_name` so a
/// future column cannot silently vanish depending on file order.
pub fn merge(
    staging: &Path,
    name: &str,
    inputs: &[PathBuf],
    row_group_size: usize,
) -> Result<PathBuf, String> {
    let conn = writer()?;
    let list = inputs
        .iter()
        .map(|p| quote(p))
        .collect::<Vec<_>>()
        .join(", ");
    let copy = format!(
        "COPY (SELECT timestamp, source, data \
         FROM read_parquet([{list}], union_by_name=true) \
         ORDER BY source, timestamp) \
         TO {} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE {row_group_size})",
        quote(&staging.join(format!("{name}.tmp")))
    );
    run(&conn, &copy)?;
    publish(tmp_path(staging, name), staging.join(name))
}

/// Zero-row file carrying the schema. `read_parquet` cannot bind an empty glob,
/// so a fresh data directory needs one file to anchor the `events` view.
pub fn write_seed(staging: &Path) -> Result<PathBuf, String> {
    let conn = writer()?;
    let copy = format!(
        "COPY (SELECT CAST(NULL AS TIMESTAMPTZ) AS timestamp, CAST(NULL AS VARCHAR) AS source, \
                     CAST(NULL AS VARIANT) AS data WHERE false) \
         TO {} (FORMAT PARQUET, COMPRESSION ZSTD)",
        quote(&staging.join(format!("{}.tmp", crate::storage::SEED_FILE)))
    );
    run(&conn, &copy)?;
    publish(
        tmp_path(staging, crate::storage::SEED_FILE),
        staging.join(crate::storage::SEED_FILE),
    )
}

fn writer() -> Result<Connection, String> {
    let config = Config::default().threads(2).map_err(|e| e.to_string())?;
    let conn = Connection::open_in_memory_with_flags(config).map_err(|e| e.to_string())?;
    conn.execute_batch("SET memory_limit='512MB';")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn run(conn: &Connection, sql: &str) -> Result<(), String> {
    conn.execute_batch(sql).map_err(|e| e.to_string())
}

fn tmp_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.tmp"))
}

/// Sync the finished file, then rename it into place so readers only ever see a
/// complete file.
fn publish(tmp: PathBuf, dest: PathBuf) -> Result<PathBuf, String> {
    if let Ok(file) = std::fs::File::open(&tmp) {
        let _ = file.sync_all();
    }
    std::fs::rename(&tmp, &dest)
        .map_err(|e| format!("{} -> {}: {e}", tmp.display(), dest.display()))?;
    if let Some(dir) = dest.parent()
        && let Ok(file) = std::fs::File::open(dir)
    {
        let _ = file.sync_all();
    }
    Ok(dest)
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "''"))
}
