//! Authentication for the dashboard and the ingest endpoint.
//!
//! Two independent credentials are supported. The UI role may reach every path;
//! the sensor role may only write data (`POST /api/ingest`, `POST /api/gps/{source}`),
//! so a sensor credential can be rotated without touching the dashboard password.
//! `/health` stays public for the deploy script and any external probe.
//!
//! **Basic credentials are only read where something presents them on purpose:**
//! the dashboard's own sign-in (`POST /api/session`) and the sensor's write
//! routes. Every other route wants the session cookie, which keeps the surface
//! that can be guessed against down to one endpoint — and that endpoint is paced
//! by the throttle below. Without that narrowing, a single global failure budget
//! would be spread across the whole API and measuring nothing.
//!
//! The GPS route additionally accepts the sensor password as an
//! `Authorization: Bearer` token, because the Overland app can send nothing else:
//! its settings offer a server URL and an access token, and custom headers are
//! still unimplemented upstream.

use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

/// How many failed sign-ins are tolerated in one window, and how long the window
/// lasts. Deliberately tiny numbers: this exists to make online guessing cost
/// time, not to shape traffic.
const SIGN_IN_FAILURES: u32 = 10;
const SIGN_IN_WINDOW: Duration = Duration::from_secs(60);

/// One global budget for failed sign-ins.
///
/// No per-address state, and no map to grow or evict: with one or two people
/// behind this service, all the budget has to do is make guessing slow. A
/// *correct* credential is verified before the budget is consulted, so a flood of
/// wrong guesses can never lock the owner out — only its own kind out.
#[derive(Debug, Default)]
pub struct Throttle {
    state: Mutex<ThrottleState>,
}

#[derive(Debug, Default)]
struct ThrottleState {
    window: Option<Instant>,
    failures: u32,
}

impl Throttle {
    /// Note one failed sign-in. `Some(seconds)` means the caller has spent the
    /// budget and should be refused for that long.
    fn failure(&self, now: Instant) -> Option<u64> {
        let mut state = self.state.lock().expect("throttle");
        let window = match state.window {
            Some(window) if now.duration_since(window) < SIGN_IN_WINDOW => window,
            _ => {
                state.window = Some(now);
                state.failures = 0;
                now
            }
        };
        state.failures += 1;
        (state.failures > SIGN_IN_FAILURES)
            .then(|| (SIGN_IN_WINDOW - now.duration_since(window)).as_secs().max(1))
    }

    /// A credential was accepted: the budget starts over.
    fn success(&self) {
        let mut state = self.state.lock().expect("throttle");
        state.window = None;
        state.failures = 0;
    }
}

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
    /// A second dashboard credential, restricted to `Scope::Home`.
    pub home: Option<Credential>,
    pub sensor: Option<Credential>,
    /// The signer for dashboard session cookies. Present exactly when a UI
    /// credential is configured.
    pub sessions: Option<Sessions>,
    /// Paces failed sign-ins; shared by every clone of `Auth`.
    throttle: Arc<Throttle>,
}

impl Auth {
    pub fn new(
        ui: Option<Credential>,
        home: Option<Credential>,
        sensor: Option<Credential>,
    ) -> Self {
        // Both dashboard passwords seed the session key: rotating *either* one
        // invalidates every outstanding cookie, so withdrawing the restricted
        // viewer's access does not leave their cookie alive for two months. The
        // cost is that a rotation signs everybody out, which is the right trade
        // for a household-sized service.
        let sessions = ui.as_ref().map(|ui| {
            let mut seed = ui.password.clone();
            if let Some(home) = home.as_ref() {
                seed.push('\u{0}');
                seed.push_str(&home.password);
            }
            Sessions::new(&seed)
        });
        Self {
            ui,
            home,
            sensor,
            sessions,
            throttle: Arc::new(Throttle::default()),
        }
    }
}

impl Auth {
    pub fn enabled(&self) -> bool {
        self.ui.is_some()
    }

    /// The sensor credential on its own, for a client that can only send a
    /// bearer token. Compared in constant time, like the basic pair.
    /// The scope a user and password stand for, if they stand for anything.
    fn scope(&self, user: &str, password: &str) -> Option<Scope> {
        if self.ui.as_ref().is_some_and(|c| c.matches(user, password)) {
            return Some(Scope::All);
        }
        if self.home.as_ref().is_some_and(|c| c.matches(user, password)) {
            return Some(Scope::Home);
        }
        None
    }

    fn sensor_token(&self, token: &str) -> Option<Role> {
        let sensor = self.sensor.as_ref()?;
        let ok: bool = sensor.password.as_bytes().ct_eq(token.as_bytes()).into();
        ok.then_some(Role::Sensor)
    }

    fn role(&self, user: &str, password: &str) -> Option<Role> {
        if let Some(scope) = self.scope(user, password) {
            return Some(Role::Ui(scope));
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

/// What a signed-in dashboard user may read.
///
/// The scope is a property of the credential, not of the request: it is resolved
/// once at sign-in, signed into the cookie, and checked before the handler runs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    /// Everything: the SQL endpoint, the tile archives, every dashboard.
    All,
    /// The named home readings and the app itself, nothing else.
    Home,
}

impl Scope {
    /// The byte that rides inside the signed cookie.
    pub fn byte(self) -> u8 {
        match self {
            Scope::All => 0,
            Scope::Home => 1,
        }
    }

    pub fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            0 => Some(Scope::All),
            1 => Some(Scope::Home),
            _ => None,
        }
    }

    /// The paths a scope may reach at all. `Scope::All` is open by default; a
    /// restricted scope is an allowlist, so a route added later is closed to it
    /// until someone says otherwise.
    fn may_reach(self, path: &str) -> bool {
        match self {
            Scope::All => true,
            Scope::Home => matches!(path, "/api/series" | "/api/me" | "/api/session"),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Ui(Scope),
    Sensor,
}

pub async fn authorize(
    State(auth): State<Auth>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    if !auth.enabled() {
        // Authentication is off (the local dev server): everyone is the owner.
        request.extensions_mut().insert(Scope::All);
        return next.run(request).await;
    }

    let path = request.uri().path().to_string();
    // The sensor role may write data and nothing else.
    let sensor_route = is_ingest(&request) || is_gps(&request);
    // The dashboard's own sign-in: the only place the UI credential is read off
    // the wire rather than out of a cookie.
    let sign_in = path == "/api/session";
    let presents_basic = request.headers().contains_key(header::AUTHORIZATION);

    let role = if is_gps(&request) {
        bearer_token(request.headers()).and_then(|token| auth.sensor_token(&token))
    } else {
        None
    }
    // The session cookie next: a single signature check, and what every
    // dashboard request carries once the user has signed in.
    .or_else(|| session_role(&auth, request.headers()))
    // Basic credentials last, and only where a client presents them on purpose:
    // signing in, or writing as a sensor. Everywhere else they are ignored, so
    // the guessable surface is one endpoint instead of the whole API.
    .or_else(|| {
        (sign_in || sensor_route)
            .then(|| basic_credentials(request.headers()))
            .flatten()
            .and_then(|(user, password)| auth.role(&user, &password))
    });

    match role {
        Some(Role::Ui(scope)) if scope.may_reach(&path) => {
            if sign_in {
                // A real sign-in clears the budget, so the owner who mistyped
                // twice does not carry that with them.
                auth.throttle.success();
            }
            // Handlers that read the scope find it here, already verified.
            request.extensions_mut().insert(scope);
            next.run(request).await
        }
        // Authenticated, but not for this path: 403, not 401 — the credential is
        // fine, the request is not.
        Some(Role::Ui(_)) => forbidden(),
        Some(Role::Sensor) if sensor_route => next.run(request).await,
        _ => {
            // A credential was offered and rejected: that is a guess, and worth
            // pacing. A request with no credential at all is the app asking
            // whether it is signed in, which must stay cheap.
            if sign_in && presents_basic {
                tracing::warn!(
                    forwarded_for = request
                        .headers()
                        .get("x-forwarded-for")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("-"),
                    "failed sign-in"
                );
                if let Some(retry) = auth.throttle.failure(Instant::now()) {
                    return too_many(retry);
                }
            }
            unauthorized()
        }
    }
}

fn too_many(seconds: u64) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [(header::RETRY_AFTER, seconds.to_string())],
        "too many failed sign-ins",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential(user: &str, password: &str) -> Credential {
        Credential {
            user: user.into(),
            password: password.into(),
        }
    }

    #[test]
    fn the_budget_runs_out_and_comes_back() {
        let throttle = Throttle::default();
        let start = Instant::now();

        for _ in 0..SIGN_IN_FAILURES {
            assert_eq!(throttle.failure(start), None, "inside the budget");
        }
        let wait = throttle.failure(start).expect("over the budget");
        assert!(wait > 0 && wait <= SIGN_IN_WINDOW.as_secs());

        // The window rolls over: the budget is whole again.
        let later = start + SIGN_IN_WINDOW + Duration::from_secs(1);
        for _ in 0..SIGN_IN_FAILURES {
            assert_eq!(throttle.failure(later), None);
        }
        assert!(throttle.failure(later).is_some());
    }

    #[test]
    fn a_good_sign_in_clears_the_budget() {
        let throttle = Throttle::default();
        let start = Instant::now();
        for _ in 0..SIGN_IN_FAILURES {
            throttle.failure(start);
        }
        assert!(throttle.failure(start).is_some(), "spent");

        throttle.success();
        assert_eq!(throttle.failure(start), None, "a real sign-in resets it");
    }

    #[test]
    fn credentials_are_resolved_to_their_scope() {
        let auth = Auth::new(
            Some(credential("owner", "ownerpw")),
            Some(credential("guest", "guestpw")),
            Some(credential("sensor", "sensorpw")),
        );
        assert!(matches!(auth.role("owner", "ownerpw"), Some(Role::Ui(Scope::All))));
        assert!(matches!(auth.role("guest", "guestpw"), Some(Role::Ui(Scope::Home))));
        assert!(matches!(auth.role("sensor", "sensorpw"), Some(Role::Sensor)));
        assert!(auth.role("guest", "ownerpw").is_none());
        assert!(auth.role("owner", "nope").is_none());
    }

    #[test]
    fn only_opted_in_routes_are_open_to_a_restricted_viewer() {
        assert!(Scope::All.may_reach("/api/data"));
        assert!(Scope::Home.may_reach("/api/series"));
        assert!(!Scope::Home.may_reach("/api/data"));
        assert!(!Scope::Home.may_reach("/tiles/world.pmtiles"));
    }
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, "not permitted for this credential").into_response()
}

fn is_ingest(request: &Request<Body>) -> bool {
    request.method() == Method::POST && request.uri().path() == "/api/ingest"
}

/// The dashboard's own credential: a cookie this process signed, still inside
/// its two months, carrying the scope it was minted for.
fn session_role(auth: &Auth, headers: &HeaderMap) -> Option<Role> {
    let sessions = auth.sessions.as_ref()?;
    let token = session::token_from(headers)?;
    sessions.verify(token, Utc::now()).map(Role::Ui)
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
