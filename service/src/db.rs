use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use duckdb::{Config, Connection};
use tokio::sync::Semaphore;

#[derive(Clone, Debug)]
pub struct DbOptions {
    pub data_dir: PathBuf,
    pub pool_size: usize,
    pub memory_limit: String,
    pub threads: i64,
    pub query_timeout: Duration,
    pub max_response_bytes: usize,
}

#[derive(Debug)]
pub enum QueryError {
    Timeout,
    TooLarge { limit: usize, actual: usize },
    BadQuery(String),
    Internal(String),
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QueryError::Timeout => write!(f, "query timed out"),
            QueryError::TooLarge { limit, actual } => {
                write!(f, "response of {actual} bytes exceeds the {limit} byte limit")
            }
            QueryError::BadQuery(msg) => write!(f, "{msg}"),
            QueryError::Internal(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for QueryError {}

/// A pool of read-only DuckDB connections over `data_dir/*.parquet`.
///
/// Each connection is an independent in-memory database exposing the same
/// `events` view. External file access is disabled except for `data_dir` and the
/// configuration is locked, so a query can only read the acta data.
///
/// Connections are handed to blocking tasks and returned from within those
/// tasks, so a cancelled request (e.g. the browser aborting a fetch) can never
/// leak a connection. A missing or lost connection is recreated on demand.
pub struct Db {
    inner: Arc<Inner>,
}

struct Inner {
    options: DbOptions,
    pool: Mutex<Vec<Connection>>,
    permits: Arc<Semaphore>,
}

impl Db {
    pub fn open(options: DbOptions) -> Result<Self, String> {
        let data_dir = options
            .data_dir
            .canonicalize()
            .map_err(|e| format!("data dir {}: {e}", options.data_dir.display()))?;
        if !data_dir.is_dir() {
            return Err(format!("data dir {} is not a directory", data_dir.display()));
        }
        if !has_parquet(&data_dir)? {
            return Err(format!("no *.parquet files in {}", data_dir.display()));
        }

        let options = DbOptions { data_dir, ..options };
        let mut pool = Vec::with_capacity(options.pool_size);
        for _ in 0..options.pool_size {
            pool.push(connect(&options)?);
        }
        let permits = Arc::new(Semaphore::new(options.pool_size));

        Ok(Self { inner: Arc::new(Inner { options, pool: Mutex::new(pool), permits }) })
    }

    /// Run `sql`, expecting exactly one row with one `VARCHAR` column holding the
    /// JSON document to return. The query is interrupted if it runs longer than
    /// the configured timeout.
    pub async fn query_json(&self, sql: String) -> Result<String, QueryError> {
        let permit = Arc::clone(&self.inner.permits)
            .acquire_owned()
            .await
            .map_err(|e| QueryError::Internal(format!("pool closed: {e}")))?;

        let conn = self.take_connection()?;
        let interrupt = conn.interrupt_handle();

        // The timer only fires if the blocking task has not finished; the task
        // sets `done` itself, so a stale timer can never interrupt a later query
        // that reused the same connection.
        let done = Arc::new(AtomicBool::new(false));
        let timed_out = Arc::new(AtomicBool::new(false));
        let query_timeout = self.inner.options.query_timeout;
        let timer = {
            let done = Arc::clone(&done);
            let timed_out = Arc::clone(&timed_out);
            tokio::spawn(async move {
                tokio::time::sleep(query_timeout).await;
                if !done.load(Ordering::SeqCst) {
                    timed_out.store(true, Ordering::SeqCst);
                    interrupt.interrupt();
                }
            })
        };

        let inner = Arc::clone(&self.inner);
        let done_in_task = Arc::clone(&done);
        let result = tokio::task::spawn_blocking(move || {
            let out = run_json(&conn, &sql);
            done_in_task.store(true, Ordering::SeqCst);
            inner.give_back(conn);
            drop(permit);
            out
        })
        .await;

        timer.abort();

        let out = match result {
            Ok(out) => out,
            Err(e) => return Err(QueryError::Internal(format!("query task failed: {e}"))),
        };
        if timed_out.load(Ordering::SeqCst) {
            return Err(QueryError::Timeout);
        }

        let json = out?;
        if json.len() > self.inner.options.max_response_bytes {
            return Err(QueryError::TooLarge {
                limit: self.inner.options.max_response_bytes,
                actual: json.len(),
            });
        }
        Ok(json)
    }

    fn take_connection(&self) -> Result<Connection, QueryError> {
        let mut pool = self.inner.pool.lock().unwrap_or_else(|e| e.into_inner());
        match pool.pop() {
            Some(conn) => Ok(conn),
            None => {
                tracing::warn!("connection pool empty, opening a new connection");
                connect(&self.inner.options).map_err(QueryError::Internal)
            }
        }
    }
}

impl Inner {
    fn give_back(&self, conn: Connection) {
        let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
        if pool.len() < self.options.pool_size {
            pool.push(conn);
        }
    }
}

fn run_json(conn: &Connection, sql: &str) -> Result<String, QueryError> {
    conn.query_row(sql, [], |row| row.get(0))
        .map_err(|e| QueryError::BadQuery(e.to_string()))
}

fn connect(options: &DbOptions) -> Result<Connection, String> {
    let config = Config::default()
        .max_memory(&options.memory_limit)
        .map_err(|e| e.to_string())?
        .threads(options.threads)
        .map_err(|e| e.to_string())?;

    let conn = Connection::open_in_memory_with_flags(config).map_err(|e| e.to_string())?;

    // The view must be created while the data dir is explicitly allowed. Only
    // afterwards is external access switched off and the configuration locked.
    // `allowed_directories` keeps reads of `data_dir` working.
    let dir = options.data_dir.display().to_string().replace('\'', "''");
    let glob = options.glob_pattern().replace('\'', "''");
    let setup = format!(
        "SET allowed_directories = ['{dir}'];\n\
         SET enable_external_access = false;\n\
         SET lock_configuration = true;\n\
         CREATE VIEW events AS \
             SELECT timestamp, source, data FROM read_parquet('{glob}');"
    );
    conn.execute_batch(&setup).map_err(|e| e.to_string())?;

    Ok(conn)
}

impl DbOptions {
    fn glob_pattern(&self) -> String {
        format!("{}/*.parquet", self.data_dir.display())
    }
}

fn has_parquet(dir: &std::path::Path) -> Result<bool, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().is_some_and(|ext| ext == "parquet") {
            return Ok(true);
        }
    }
    Ok(false)
}
