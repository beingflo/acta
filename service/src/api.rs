use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router, middleware};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::RwLock;
use tower::ServiceBuilder;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::auth::{self, Auth};
use crate::db::{Db, QueryError};
use crate::ingest::{self, IngestHandle, IngestItem};

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
    pub ingest: IngestHandle,
    /// Shared with the compaction swap: queries take a read guard, a swap takes
    /// the write guard, so no query sees a bucket twice or not at all.
    pub data_lock: Arc<RwLock<()>>,
    pub ingest_max_batch: usize,
    pub ingest_max_body_bytes: usize,
}

pub fn router(state: AppState, ui_dir: PathBuf, tiles_dir: PathBuf, auth: Auth) -> Router {
    let index = ui_dir.join("index.html");
    let spa = ServeDir::new(ui_dir).fallback(ServeFile::new(index));
    let body_limit = state.ingest_max_body_bytes;

    // PMTiles archives are pulled with HTTP Range requests. `ServeDir` supports
    // ranges and sets a strong ETag from the file metadata; the PMTiles client
    // reads that ETag to notice a replaced archive.
    let tiles = ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=300, must-revalidate"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("access-control-expose-headers"),
            HeaderValue::from_static("ETag, Content-Length, Content-Range"),
        ))
        .service(ServeDir::new(tiles_dir));

    // Everything below the health check is protected; `/health` stays public
    // so the deploy script and systemd can probe a host without credentials.
    let protected = Router::new()
        .route("/api/data", post(data))
        .route(
            "/api/ingest",
            post(ingest).layer(DefaultBodyLimit::max(body_limit)),
        )
        .nest_service("/tiles", tiles)
        .fallback_service(spa)
        .layer(middleware::from_fn_with_state(auth, auth::authorize));

    Router::new()
        .route("/health", get(health))
        .merge(protected)
        .layer(CatchPanicLayer::new())
        .with_state(state)
}

/// The sensor whose freshness defines liveness, and how old its newest reading
/// may be before the service is considered unhealthy.
const HEALTH_SOURCE: &str = "co2-sensor-living-room";
const HEALTH_MAX_AGE_MINUTES: i64 = 10;

/// Liveness and freshness: 200 only when a reading from `HEALTH_SOURCE` arrived
/// within the last `HEALTH_MAX_AGE_MINUTES`, 503 otherwise. A running process
/// with a dead sensor upstream reports unhealthy.
async fn health(State(state): State<AppState>) -> Response {
    let cutoff = (chrono::Utc::now() - chrono::Duration::minutes(HEALTH_MAX_AGE_MINUTES))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    // The window lets file and row-group statistics prune the archive, so this
    // only touches the live end of the data rather than scanning every file.
    let sql = format!(
        "SELECT to_json(struct_pack(newest := CAST(epoch(CAST(max(timestamp) AS TIMESTAMP)) AS BIGINT)))::VARCHAR \
         FROM events \
         WHERE source = '{HEALTH_SOURCE}' AND timestamp >= TIMESTAMPTZ '{cutoff}'"
    );

    match state.db.query_json(sql).await {
        Ok(json) => {
            let newest = serde_json::from_str::<serde_json::Value>(&json)
                .ok()
                .and_then(|value| value.get("newest").and_then(serde_json::Value::as_i64));
            match newest {
                Some(secs) => {
                    let age = chrono::Utc::now().timestamp() - secs;
                    (
                        StatusCode::OK,
                        format!("ok: newest {HEALTH_SOURCE} reading is {age}s old\n"),
                    )
                        .into_response()
                }
                None => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!(
                        "stale: no {HEALTH_SOURCE} reading in the last {HEALTH_MAX_AGE_MINUTES} minutes\n"
                    ),
                )
                    .into_response(),
            }
        }
        Err(err) => (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("unavailable: {err}\n"),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct DataRequest {
    sql: String,
}

/// Executes a DuckDB query and returns the JSON document the query produced.
///
/// The query must return exactly one row with a single column holding the JSON
/// text, e.g. `SELECT to_json(...)::VARCHAR`.
async fn data(State(state): State<AppState>, Json(request): Json<DataRequest>) -> Response {
    let _read = state.data_lock.read().await;
    match state.db.query_json(request.sql).await {
        Ok(json) => ([(header::CONTENT_TYPE, "application/json")], json).into_response(),
        Err(err) => ApiError::from(err).into_response(),
    }
}

/// Accepts a JSON array of `{ source, timestamp?, data }`, validates it and
/// hands it to the ingest buffer. The rows become queryable on the next flush.
async fn ingest(State(state): State<AppState>, body: Bytes) -> Response {
    let items: Vec<IngestItem> = match serde_json::from_slice(&body) {
        Ok(items) => items,
        Err(err) => {
            return ApiError::BadRequest(format!("invalid JSON body: {err}")).into_response();
        }
    };
    if items.len() > state.ingest_max_batch {
        return ApiError::TooLarge(format!(
            "batch of {} exceeds the {}-element limit",
            items.len(),
            state.ingest_max_batch
        ))
        .into_response();
    }

    let now = ingest::now_us();
    let mut rows = Vec::with_capacity(items.len());
    for item in items {
        match ingest::item_to_row(item, now) {
            Ok(row) => rows.push(row),
            Err(err) => return ApiError::BadRequest(err).into_response(),
        }
    }

    let accepted = rows.len();
    if accepted > 0 && let Err(err) = state.ingest.submit(rows).await {
        return ApiError::Internal(err).into_response();
    }
    (StatusCode::ACCEPTED, Json(json!({ "accepted": accepted }))).into_response()
}

enum ApiError {
    BadRequest(String),
    Timeout,
    TooLarge(String),
    Internal(String),
}

impl From<QueryError> for ApiError {
    fn from(err: QueryError) -> Self {
        match &err {
            QueryError::BadQuery(msg) => ApiError::BadRequest(msg.clone()),
            QueryError::Timeout => ApiError::Timeout,
            QueryError::TooLarge { .. } => ApiError::TooLarge(err.to_string()),
            QueryError::Internal(msg) => ApiError::Internal(msg.clone()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            ApiError::Timeout => (StatusCode::GATEWAY_TIMEOUT, "query timed out".to_string()),
            ApiError::TooLarge(msg) => (StatusCode::PAYLOAD_TOO_LARGE, msg),
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };
        if status.is_server_error() {
            tracing::error!(%status, %message, "request failed");
        }
        (status, Json(json!({ "error": message }))).into_response()
    }
}
