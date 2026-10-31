use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Extension, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
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
use crate::display;
use crate::gps;
use crate::ingest::{self, IngestHandle, IngestItem};
use crate::metrics;
use crate::session;

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
    pub ingest: IngestHandle,
    /// Shared with the compaction swap: queries take a read guard, a swap takes
    /// the write guard, so no query sees a bucket twice or not at all.
    pub data_lock: Arc<RwLock<()>>,
    pub ingest_max_batch: usize,
    pub ingest_max_body_bytes: usize,
    /// How long the epaper panel waits before it asks for a new picture.
    pub dashboard_refresh_seconds: u64,
    /// Who may read, and the key that signs dashboard session cookies.
    pub auth: Auth,
}

pub fn router(state: AppState, ui_dir: PathBuf, tiles_dir: PathBuf) -> Router {
    let index = ui_dir.join("index.html");
    let spa = ServeDir::new(ui_dir).fallback(ServeFile::new(index));
    let body_limit = state.ingest_max_body_bytes;

    // PMTiles archives are pulled with HTTP Range requests. `ServeDir` supports
    // ranges and sets a strong ETag from the file metadata; a replaced archive
    // changes that ETag, which the PMTiles client uses to invalidate what it has
    // read so far.
    //
    // The archives are rebuilt by hand about twice a year, so they are worth a
    // month in the browser's HTTP cache: a tens-of-megabytes archive read in
    // ranges is the most expensive thing this service serves, and it does not
    // change between deploys. `must-revalidate` keeps the month a freshness
    // window rather than an excuse to serve a stale archive forever: after it,
    // the next range request revalidates, and a rebuilt archive fails the ETag
    // check and is reloaded.
    let tiles = ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=2592000, must-revalidate"),
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

    // Everything below the health check is protected, except the app itself: the
    // shell holds no data, and a home-screen app on iOS cannot show its own
    // sign-in form if a credential is needed to fetch the HTML. `/health` stays
    // public so the deploy script and systemd can probe a host without
    // credentials.
    let protected = Router::new()
        .route("/api/data", post(data))
        .route("/api/session", post(sign_in).delete(sign_out))
        .route("/api/series", post(series))
        .route("/api/me", get(me))
        // The epaper panel pulls a rendered picture instead of drawing one: the
        // bitmap for the device, the PNG for a browser checking a layout.
        .route("/api/dashboard", get(display::bitmap))
        .route("/api/dashboard.png", get(display::preview))
        .route(
            "/api/ingest",
            post(ingest).layer(DefaultBodyLimit::max(body_limit)),
        )
        .route(
            "/api/gps/{source}",
            post(gps::upload).layer(DefaultBodyLimit::max(body_limit)),
        )
        .nest_service("/tiles", tiles)
        .layer(middleware::from_fn_with_state(
            state.auth.clone(),
            auth::authorize,
        ));

    Router::new()
        .route("/health", get(health))
        .merge(protected)
        .fallback_service(spa)
        .layer(CatchPanicLayer::new())
        .with_state(state)
}

/// Trade basic credentials for a session cookie. The dashboard calls this from
/// its own sign-in form, with the header set by hand, so no browser dialog is
/// involved and the credential never depends on the browser remembering it. The
/// middleware has already accepted the request, so reaching this handler means
/// the caller held a valid UI credential.
async fn sign_in(
    State(state): State<AppState>,
    Extension(scope): Extension<auth::Scope>,
    headers: HeaderMap,
) -> Response {
    let Some(sessions) = state.auth.sessions.as_ref() else {
        // Authentication is off: there is nothing for the browser to keep.
        return StatusCode::NO_CONTENT.into_response();
    };
    let Some(token) = sessions.issue(scope, chrono::Utc::now()) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "no entropy for a session",
        )
            .into_response();
    };
    let cookie = session::cookie(&token, session::is_secure(&headers));
    ([(header::SET_COOKIE, cookie)], StatusCode::NO_CONTENT).into_response()
}

/// Forget the cookie. The token itself stays valid until it expires — this
/// design has no session store to revoke against; rotating the UI password is
/// what invalidates outstanding cookies.
async fn sign_out(State(_state): State<AppState>, headers: HeaderMap) -> Response {
    let cookie = session::cleared_cookie(session::is_secure(&headers));
    ([(header::SET_COOKIE, cookie)], StatusCode::NO_CONTENT).into_response()
}

/// What this credential may read, so the dashboard can show only the dashboards
/// it can fill. Presentation only — the scope is enforced server-side.
async fn me(Extension(scope): Extension<auth::Scope>) -> Response {
    let scope = match scope {
        auth::Scope::All => "all",
        auth::Scope::Home => "home",
    };
    Json(json!({ "scope": scope })).into_response()
}

/// The named readings over `[from, to)`, bucketed together. This is the whole of
/// a restricted reader's view of the data: a list of metric ids, a window and a
/// bucket width, all of which the service turns into SQL itself. One tile may
/// ask for several readings, so a chart can draw two sensors side by side.
async fn series(
    State(state): State<AppState>,
    Extension(scope): Extension<auth::Scope>,
    Json(request): Json<SeriesRequest>,
) -> Response {
    if request.metrics.is_empty() || request.metrics.len() > metrics::MAX_SERIES {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": format!("metrics must name 1 to {} readings", metrics::MAX_SERIES)
            })),
        )
            .into_response();
    }
    let mut chosen = Vec::with_capacity(request.metrics.len());
    for id in &request.metrics {
        match crate::metrics::lookup(id, scope) {
            Ok(metric) => chosen.push(metric),
            Err(message) => {
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": message })))
                    .into_response();
            }
        }
    }
    if request.bucket_ms < metrics::MIN_BUCKET_MS || request.bucket_ms > metrics::MAX_BUCKET_MS {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "bucket_ms out of range" })),
        )
            .into_response();
    }
    let window = match (parse_stamp(&request.from), parse_stamp(&request.to)) {
        (Some(from), Some(to)) if from < to => (from, to),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "from and to must be RFC 3339 stamps, from before to" })),
            )
                .into_response();
        }
    };

    let sql = metrics::series_sql(&chosen, window.0, window.1, request.bucket_ms);
    let _read = state.data_lock.read().await;
    match state.db.query_json(sql).await {
        Ok(json) => ([(header::CONTENT_TYPE, "application/json")], json).into_response(),
        Err(err) => ApiError::from(err).into_response(),
    }
}

/// A stamp is re-rendered from the parsed value, so nothing the caller typed
/// reaches the SQL string.
fn parse_stamp(text: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|at| at.with_timezone(&chrono::Utc))
}

#[derive(Deserialize)]
struct SeriesRequest {
    metrics: Vec<String>,
    bucket_ms: u64,
    from: String,
    to: String,
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
    if accepted > 0
        && let Err(err) = state.ingest.submit(rows).await
    {
        return ApiError::Internal(err).into_response();
    }
    (StatusCode::ACCEPTED, Json(json!({ "accepted": accepted }))).into_response()
}

#[derive(Debug)]
pub(crate) enum ApiError {
    BadRequest(String),
    Timeout,
    TooLarge(String),
    /// A reading the request needs is not there yet; asking again later may work.
    Unavailable(String),
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
            ApiError::Unavailable(msg) => (StatusCode::SERVICE_UNAVAILABLE, msg),
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };
        if status.is_server_error() {
            tracing::error!(%status, %message, "request failed");
        }
        (status, Json(json!({ "error": message }))).into_response()
    }
}
