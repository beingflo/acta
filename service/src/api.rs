use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tower::ServiceBuilder;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::db::{Db, QueryError};

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
}

pub fn router(state: AppState, ui_dir: PathBuf, tiles_dir: PathBuf) -> Router {
    let index = ui_dir.join("index.html");
    let spa = ServeDir::new(ui_dir).fallback(ServeFile::new(index));

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

    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/data", post(data))
        .nest_service("/tiles", tiles)
        .fallback_service(spa)
        .layer(CatchPanicLayer::new())
        .with_state(state)
}

async fn healthz() -> &'static str {
    "ok"
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
    match state.db.query_json(request.sql).await {
        Ok(json) => ([(header::CONTENT_TYPE, "application/json")], json).into_response(),
        Err(err) => ApiError::from(err).into_response(),
    }
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
