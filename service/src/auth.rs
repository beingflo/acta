//! HTTP basic authentication for the dashboard and the ingest endpoint.
//!
//! Two independent credentials are supported. The UI role may reach every path;
//! the sensor role may only write data (`POST /api/ingest`, `POST /api/gps/{source}`),
//! so a sensor credential can be rotated without touching the dashboard password.
//! `/health` stays public for the deploy script and any external probe.
//!
//! The GPS route additionally accepts the sensor password as an
//! `Authorization: Bearer` token, because the Overland app can send nothing else:
//! its settings offer a server URL and an access token, and custom headers are
//! still unimplemented upstream.

use std::fmt;

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, Method, Request, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::Engine;
use chrono::Utc;
use subtle::ConstantTimeEq;

use crate::session::{self, Sessions};

#[derive(Clone)]
pub struct Credential {
    pub user: String,
    pub password: String,
}

impl Credential {
    fn matches(&self, user: &str, password: &str) -> bool {
        // Compare both fields in constant time; the lengths are not secret.
        let user_ok: bool = self.user.as_bytes().ct_eq(user.as_bytes()).into();
        let password_ok: bool = self.password.as_bytes().ct_eq(password.as_bytes()).into();
        user_ok & password_ok
    }
}

// Keep the password out of `Debug` output (and therefore out of any log line
// that happens to format `Settings`).
impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("user", &self.user)
            .field("password", &"<redacted>")
            .finish()
    }
}

/// The configured credentials. With no UI credential, authentication is off.
#[derive(Clone, Debug, Default)]
pub struct Auth {
    pub ui: Option<Credential>,
    pub sensor: Option<Credential>,
    /// The signer for dashboard session cookies. Present exactly when a UI
    /// credential is configured.
    pub sessions: Option<Sessions>,
}

impl Auth {
    pub fn new(ui: Option<Credential>, sensor: Option<Credential>) -> Self {
        let sessions = ui.as_ref().map(|credential| Sessions::new(&credential.password));
        Self {
            ui,
            sensor,
            sessions,
        }
    }
}

impl Auth {
    pub fn enabled(&self) -> bool {
        self.ui.is_some()
    }

    /// The sensor credential on its own, for a client that can only send a
    /// bearer token. Compared in constant time, like the basic pair.
    fn sensor_token(&self, token: &str) -> Option<Role> {
        let sensor = self.sensor.as_ref()?;
        let ok: bool = sensor.password.as_bytes().ct_eq(token.as_bytes()).into();
        ok.then_some(Role::Sensor)
    }

    fn role(&self, user: &str, password: &str) -> Option<Role> {
        if self.ui.as_ref().is_some_and(|c| c.matches(user, password)) {
            return Some(Role::Ui);
        }
        if self
            .sensor
            .as_ref()
            .is_some_and(|c| c.matches(user, password))
        {
            return Some(Role::Sensor);
        }
        None
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Ui,
    Sensor,
}

pub async fn authorize(State(auth): State<Auth>, request: Request<Body>, next: Next) -> Response {
    if !auth.enabled() {
        return next.run(request).await;
    }

    let role = if is_gps(&request) {
        bearer_token(request.headers()).and_then(|token| auth.sensor_token(&token))
    } else {
        None
    }
    // The session cookie first: it is a single signature check, and it is what
    // every dashboard request carries once the user has signed in.
    .or_else(|| session_role(&auth, request.headers()))
    .or_else(|| basic_credentials(request.headers()).and_then(|(user, password)| auth.role(&user, &password)));

    // The sensor role may write data and nothing else.
    let sensor_route = is_ingest(&request) || is_gps(&request);
    match role {
        Some(Role::Ui) => next.run(request).await,
        Some(Role::Sensor) if sensor_route => next.run(request).await,
        _ => unauthorized(),
    }
}

fn is_ingest(request: &Request<Body>) -> bool {
    request.method() == Method::POST && request.uri().path() == "/api/ingest"
}

/// The dashboard's own credential: a cookie this process signed, still inside
/// its two months.
fn session_role(auth: &Auth, headers: &HeaderMap) -> Option<Role> {
    let sessions = auth.sessions.as_ref()?;
    let token = session::token_from(headers)?;
    sessions.verify(token, Utc::now()).then_some(Role::Ui)
}

fn is_gps(request: &Request<Body>) -> bool {
    request.method() == Method::POST && request.uri().path().starts_with("/api/gps/")
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))?
        .trim();
    (!token.is_empty()).then(|| token.to_string())
}

fn basic_credentials(headers: &HeaderMap) -> Option<(String, String)> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let encoded = value
        .strip_prefix("Basic ")
        .or_else(|| value.strip_prefix("basic "))?
        .trim();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let (user, password) = text.split_once(':')?;
    if user.is_empty() {
        return None;
    }
    Some((user.to_string(), password.to_string()))
}

/// A refusal, deliberately without `WWW-Authenticate`.
///
/// The challenge is what makes a *browser* pop its own credential dialog, and
/// every request this service refuses comes from the dashboard, which owns its
/// sign-in. A challenge on a `fetch` would put the browser's dialog in front of
/// the app's, and clients that cannot answer a modal (headless browsers, and the
/// connection pool behind them) hang instead of failing. So the app gets a bare
/// 401 and decides for itself what to show.
fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "authentication required").into_response()
}
