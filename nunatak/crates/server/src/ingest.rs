use crate::{Limits, Pipeline};
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use flate2::read::GzDecoder;
use nunatak_protocol::SCHEMA;
use serde_json::json;
use std::io::Read;
use std::sync::Arc;

pub(crate) struct Ingest {
    pub(crate) pipeline: Arc<Pipeline>,
    pub(crate) token: String,
    pub(crate) limits: Limits,
}

pub(crate) async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "protocol": [SCHEMA] }))
}

pub(crate) async fn events(
    State(ingest): State<Arc<Ingest>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authorized(&headers, &ingest.token) {
        return problem(StatusCode::UNAUTHORIZED, "missing or wrong token", None);
    }
    let text = match decode(&headers, &body, ingest.limits.decoded) {
        Ok(text) => text,
        Err((status, reason)) => return problem(status, &reason, None),
    };
    let batch = match nunatak_protocol::parse(&text) {
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

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    given.len() == token.len()
        && given
            .bytes()
            .zip(token.bytes())
            .fold(0, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn decode(headers: &HeaderMap, body: &Bytes, limit: usize) -> Result<String, (StatusCode, String)> {
    let encoding = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("identity");
    let bytes = match encoding {
        "gzip" => {
            let mut out = Vec::new();
            let read = GzDecoder::new(&body[..])
                .take(limit as u64 + 1)
                .read_to_end(&mut out);
            if read.is_err() {
                return Err((StatusCode::BAD_REQUEST, "the body is not valid gzip".into()));
            }
            if out.len() > limit {
                let reason = "the batch is too large once decompressed";
                return Err((StatusCode::PAYLOAD_TOO_LARGE, reason.into()));
            }
            out
        }
        "identity" => body.to_vec(),
        other => {
            let reason = format!("unsupported content encoding {other}");
            return Err((StatusCode::UNSUPPORTED_MEDIA_TYPE, reason));
        }
    };
    String::from_utf8(bytes).map_err(|_| (StatusCode::BAD_REQUEST, "the body is not UTF-8".into()))
}

pub(crate) fn problem(status: StatusCode, error: &str, line: Option<usize>) -> Response {
    let body = match line {
        Some(line) => json!({ "error": error, "line": line }),
        None => json!({ "error": error }),
    };
    (status, Json(body)).into_response()
}
