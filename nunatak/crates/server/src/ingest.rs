use crate::Pipeline;
use axum::Extension;
use axum::Json;
use axum::extract::rejection::BytesRejection;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use nunatak_protocol::SCHEMA;
use serde_json::json;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;

const REFUSAL_QUIET: Duration = Duration::from_mins(10);

pub(crate) struct Ingest {
    pub(crate) pipeline: Arc<Pipeline>,
    pub(crate) token: String,
    pub(crate) refused: Mutex<Refusals>,
}

#[derive(Default)]
pub(crate) struct Refusals {
    last: HashMap<Option<IpAddr>, Instant>,
}

impl Refusals {
    fn first_in_a_while(&mut self, from: Option<IpAddr>, now: Instant) -> bool {
        self.last
            .retain(|_, at| now.duration_since(*at) < REFUSAL_QUIET);
        if self.last.contains_key(&from) {
            return false;
        }
        self.last.insert(from, now);
        true
    }
}

pub(crate) async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "protocol": [SCHEMA] }))
}

pub(crate) async fn events(
    State(ingest): State<Arc<Ingest>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    if let Err(reason) = authorized(&headers, &ingest.token) {
        let from = peer.map(|Extension(ConnectInfo(address))| address.ip());
        let first = ingest
            .refused
            .lock()
            .is_ok_and(|mut refused| refused.first_in_a_while(from, Instant::now()));
        if first {
            let from = from.map_or_else(|| "an unknown address".to_owned(), |ip| ip.to_string());
            tracing::warn!(
                "refused events from {from}: {reason}. Further refusals from there are not logged for 10 minutes"
            );
        }
        return problem(StatusCode::UNAUTHORIZED, "missing or wrong token", None);
    }
    let body = match body {
        Ok(body) => body,
        Err(rejection) if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            let reason = "the batch is too large once decompressed";
            return problem(StatusCode::PAYLOAD_TOO_LARGE, reason, None);
        }
        Err(_) => {
            return problem(
                StatusCode::BAD_REQUEST,
                "the body could not be read as gzip",
                None,
            );
        }
    };
    let Ok(text) = std::str::from_utf8(&body) else {
        return problem(StatusCode::BAD_REQUEST, "the body is not UTF-8", None);
    };
    let batch = match nunatak_protocol::parse(text) {
        Ok(batch) => batch,
        Err(invalid) => {
            return problem(
                StatusCode::BAD_REQUEST,
                &invalid.problem,
                Some(invalid.line),
            );
        }
    };
    match ingest.pipeline.accept(&batch).await {
        Ok(accepted) => (
            StatusCode::ACCEPTED,
            Json(json!({ "accepted": accepted.accepted, "duplicates": accepted.duplicates })),
        )
            .into_response(),
        Err(error) => {
            tracing::error!(%error, stream = %batch.stream.id, "storing a batch failed");
            let mut response = problem(
                StatusCode::SERVICE_UNAVAILABLE,
                "storage failed; send again",
                None,
            );
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, header::HeaderValue::from_static("1"));
            response
        }
    }
}

fn authorized(headers: &HeaderMap, token: &str) -> Result<(), &'static str> {
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or("no token")?;
    if given.as_bytes().ct_eq(token.as_bytes()).into() {
        Ok(())
    } else {
        Err("wrong token")
    }
}

pub(crate) fn problem(status: StatusCode, error: &str, line: Option<usize>) -> Response {
    let body = match line {
        Some(line) => json!({ "error": error, "line": line }),
        None => json!({ "error": error }),
    };
    (status, Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_address_is_reported_once_per_quiet_spell() {
        let mut refusals = Refusals::default();
        let start = Instant::now();
        let here = Some(IpAddr::from([10, 0, 0, 5]));
        let there = Some(IpAddr::from([10, 0, 0, 6]));
        assert!(refusals.first_in_a_while(here, start));
        assert!(!refusals.first_in_a_while(here, start + Duration::from_secs(1)));
        assert!(refusals.first_in_a_while(there, start + Duration::from_secs(1)));
        assert!(refusals.first_in_a_while(here, start + REFUSAL_QUIET));
    }
}
