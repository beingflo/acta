//! Session cookies for the dashboard.
//!
//! iOS never offers to save HTTP basic credentials, and an installed home-screen
//! app gets its own storage container, so a PWA that relied on basic auth would
//! prompt on every cold launch. The app therefore trades the credential once for
//! a cookie the browser keeps: `HttpOnly`, so JavaScript never sees it, and
//! signed rather than stored, so the server holds no session state at all and a
//! restart costs nobody a login.

use std::fmt;

use axum::http::HeaderMap;
use axum::http::header;
use base64::Engine;
use chrono::{DateTime, Utc};
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};

/// Two months: long enough that a phone stops asking, short enough that a lost
/// device stops working on its own.
pub const LIFETIME_SECONDS: i64 = 60 * 24 * 60 * 60;

/// The cookie's name; also the only cookie this service sets.
pub const COOKIE_NAME: &str = "acta_session";

/// Mixed into the key derivation, so a cookie from another service that happens
/// to sign with the same password does not verify here.
const CONTEXT: &[u8] = b"acta-session-v1";

/// Bytes of `expiry` that lead the payload, and the nonce that follows: two
/// cookies minted in the same second must not be the same string.
const EXPIRY_BYTES: usize = 8;
const NONCE_BYTES: usize = 12;

/// Signs and checks session tokens. One instance for the life of the process.
#[derive(Clone)]
pub struct Sessions {
    key: hmac::Key,
    rng: SystemRandom,
}

impl fmt::Debug for Sessions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The key must not reach a log line, and there is nothing else to say.
        f.write_str("Sessions")
    }
}

impl Sessions {
    /// The signing key is derived from the UI password, so rotating that
    /// password invalidates every cookie that has been handed out — which is how
    /// this design revokes sessions. No stretching here: the password is not
    /// being checked, it is only the seed.
    pub fn new(password: &str) -> Self {
        let seed = hmac::Key::new(hmac::HMAC_SHA256, password.as_bytes());
        let derived = hmac::sign(&seed, CONTEXT);
        Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, derived.as_ref()),
            rng: SystemRandom::new(),
        }
    }

    /// A cookie value for a new session, or `None` when the system has no
    /// entropy to draw a nonce from.
    pub fn issue(&self, now: DateTime<Utc>) -> Option<String> {
        let mut payload = Vec::with_capacity(EXPIRY_BYTES + NONCE_BYTES);
        payload.extend_from_slice(&(now.timestamp() + LIFETIME_SECONDS).to_be_bytes());
        let mut nonce = [0u8; NONCE_BYTES];
        self.rng.fill(&mut nonce).ok()?;
        payload.extend_from_slice(&nonce);

        let tag = hmac::sign(&self.key, &payload);
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        Some(format!(
            "{}.{}",
            encoded.encode(&payload),
            encoded.encode(tag.as_ref())
        ))
    }

    /// Whether a cookie value is one this process signed and has not expired.
    /// `ring::hmac::verify` compares the tag in constant time.
    pub fn verify(&self, token: &str, now: DateTime<Utc>) -> bool {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let Some((payload, tag)) = token.split_once('.') else {
            return false;
        };
        let (Ok(payload), Ok(tag)) = (encoded.decode(payload), encoded.decode(tag)) else {
            return false;
        };
        if payload.len() != EXPIRY_BYTES + NONCE_BYTES || hmac::verify(&self.key, &payload, &tag).is_err() {
            return false;
        }
        let expiry = i64::from_be_bytes(payload[..EXPIRY_BYTES].try_into().expect("eight bytes"));
        expiry > now.timestamp()
    }
}

/// The `Set-Cookie` value that stores a session.
pub fn cookie(token: &str, secure: bool) -> String {
    format!(
        "{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={LIFETIME_SECONDS}{}",
        if secure { "; Secure" } else { "" }
    )
}

/// The `Set-Cookie` value that forgets one.
pub fn cleared_cookie(secure: bool) -> String {
    format!(
        "{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
        if secure { "; Secure" } else { "" }
    )
}

/// The session token a request carries, if any.
pub fn token_from(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookies| cookies.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE_NAME)
        .map(|(_, value)| value)
}

/// Whether a `Secure` cookie will survive the trip back. Behind Caddy the
/// connection to the service is plain HTTP, so the terminator has to say; on
/// plain HTTP (local dev) a `Secure` cookie is dropped and the login would
/// silently never stick.
pub fn is_secure(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|proto| proto.eq_ignore_ascii_case("https"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_token_verifies_and_expires() {
        let sessions = Sessions::new("correct horse");
        let now = Utc::now();
        let token = sessions.issue(now).expect("entropy");

        assert!(sessions.verify(&token, now));
        assert!(sessions.verify(&token, now + chrono::Duration::days(59)));
        assert!(!sessions.verify(&token, now + chrono::Duration::days(61)));
    }

    #[test]
    fn tokens_are_short_and_differ() {
        let sessions = Sessions::new("correct horse");
        let now = Utc::now();
        let first = sessions.issue(now).expect("entropy");
        let second = sessions.issue(now).expect("entropy");

        assert_ne!(first, second, "the nonce keeps two cookies apart");
        assert!(first.len() < 96, "a cookie header should stay small");
    }

    #[test]
    fn tampering_and_other_passwords_fail() {
        let sessions = Sessions::new("correct horse");
        let now = Utc::now();
        let token = sessions.issue(now).expect("entropy");

        let mut flipped = token.clone().into_bytes();
        let last = flipped.len() - 1;
        flipped[last] = if flipped[last] == b'A' { b'B' } else { b'A' };
        assert!(!sessions.verify(&String::from_utf8(flipped).unwrap(), now));

        assert!(!Sessions::new("battery staple").verify(&token, now));
        assert!(!sessions.verify("nonsense", now));
        assert!(!sessions.verify("", now));
    }

    #[test]
    fn the_cookie_says_what_it_means() {
        let stored = cookie("abc", true);
        assert!(stored.starts_with("acta_session=abc;"));
        assert!(stored.contains("HttpOnly"));
        assert!(stored.contains("Max-Age=5184000"));
        assert!(stored.ends_with("; Secure"));

        assert!(!cookie("abc", false).contains("Secure"));
        assert!(cleared_cookie(false).contains("Max-Age=0"));
    }

    #[test]
    fn the_token_is_read_out_of_a_cookie_header() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "other=1; acta_session=xyz; more=2".parse().unwrap());
        assert_eq!(token_from(&headers), Some("xyz"));

        headers.insert(header::COOKIE, "other=1".parse().unwrap());
        assert_eq!(token_from(&headers), None);
    }

    #[test]
    fn only_https_gets_a_secure_cookie() {
        let mut headers = HeaderMap::new();
        assert!(!is_secure(&headers));

        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        assert!(is_secure(&headers));

        headers.insert("x-forwarded-proto", "http".parse().unwrap());
        assert!(!is_secure(&headers));
    }
}
