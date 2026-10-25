//! Overland GPS ingest.
//!
//! The iOS app posts `{"locations": [<GeoJSON Feature>, …]}` — it batches
//! whatever accumulated since the previous push, which is a handful of fixes at
//! a ten-minute cadence and occasionally a large backlog after the phone was
//! offline. Each fix becomes its own row: `events` did the same thing (one span
//! per element of the array), and the migrated `location_florian` rows are one
//! per fix, so the history continues row for row.
//!
//! The reading time is the fix's own `properties.timestamp`, never the arrival
//! time: the fixes in one push span the minutes since the last one, and stamping
//! arrival would collapse them onto a single instant. A fix without a timestamp
//! falls back to arrival time, like `/api/ingest` does.
//!
//! The feature is stored whole, so position fixes and the app's occasional
//! `properties.type == "trip"` summaries live in one source and the read path
//! branches on that field.
//!
//! The response body must carry `{"result": "ok"}`: Overland deletes its queued
//! points only when it sees that key (or when the user turns on "Consider HTTP
//! 2XX Successful"), and otherwise silently retries the same batch forever while
//! the server answers 202. `accepted` rides along for anyone watching with curl.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::{ApiError, AppState};
use crate::ingest::{self, IngestItem};

/// Rows handed to the buffer per submission. A backlog push can carry tens of
/// thousands of fixes, so the payload is chunked rather than checked against the
/// per-batch limit of the other ingest path.
const CHUNK_ROWS: usize = 1_000;

#[derive(Deserialize)]
struct Push {
    #[serde(default)]
    locations: Vec<Value>,
}

pub async fn upload(
    State(state): State<AppState>,
    Path(source): Path<String>,
    body: Bytes,
) -> Response {
    let push: Push = match serde_json::from_slice(&body) {
        Ok(push) => push,
        Err(err) => {
            return ApiError::BadRequest(format!("invalid JSON body: {err}")).into_response();
        }
    };

    let now = ingest::now_us();
    let mut rows = Vec::with_capacity(push.locations.len());
    for location in push.locations {
        let timestamp = location
            .pointer("/properties/timestamp")
            .filter(|value| value.is_string())
            .cloned();
        let item = IngestItem {
            source: source.clone(),
            timestamp,
            data: location,
        };
        match ingest::item_to_row(item, now) {
            Ok(row) => rows.push(row),
            Err(err) => return ApiError::BadRequest(err).into_response(),
        }
    }

    let accepted = rows.len();
    for chunk in rows.chunks(CHUNK_ROWS) {
        if let Err(err) = state.ingest.submit(chunk.to_vec()).await {
            return ApiError::Internal(err).into_response();
        }
    }
    (
        StatusCode::ACCEPTED,
        Json(json!({ "result": "ok", "accepted": accepted })),
    )
        .into_response()
}
