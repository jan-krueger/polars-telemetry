use crate::Pipeline;
use axum::Json;
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use nunatak_protocol::SCHEMA;
use serde_json::json;
use std::sync::Arc;
use subtle::ConstantTimeEq;

pub(crate) struct Ingest {
    pub(crate) pipeline: Arc<Pipeline>,
    pub(crate) token: String,
}

pub(crate) async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "protocol": [SCHEMA] }))
}

pub(crate) async fn events(
    State(ingest): State<Arc<Ingest>>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    if !authorized(&headers, &ingest.token) {
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

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    given.as_bytes().ct_eq(token.as_bytes()).into()
}

pub(crate) fn problem(status: StatusCode, error: &str, line: Option<usize>) -> Response {
    let body = match line {
        Some(line) => json!({ "error": error, "line": line }),
        None => json!({ "error": error }),
    };
    (status, Json(body)).into_response()
}
