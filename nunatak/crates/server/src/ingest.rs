use crate::Server;
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use nunatak_protocol::{Batch, Event, Kind, SCHEMA};
use nunatak_store::RecordingKey;
use serde_json::json;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

pub(crate) struct Ingest {
    server: Server,
    seen: Mutex<HashMap<String, Seen>>,
}

#[derive(Default)]
struct Seen {
    through: u64,
    above: BTreeSet<u64>,
}

impl Seen {
    fn has(&self, seq: u64) -> bool {
        seq <= self.through || self.above.contains(&seq)
    }

    fn add(&mut self, seq: u64) {
        if seq == self.through + 1 {
            self.through = seq;
            while self.above.remove(&(self.through + 1)) {
                self.through += 1;
            }
        } else if seq > self.through {
            self.above.insert(seq);
        }
    }
}

impl Ingest {
    pub(crate) fn new(server: Server) -> Self {
        Self {
            server,
            seen: Mutex::new(HashMap::new()),
        }
    }
}

pub(crate) async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "protocol": [SCHEMA] }))
}

pub(crate) async fn events(
    State(ingest): State<Arc<Ingest>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authorized(&headers, &ingest.server.token) {
        return problem(StatusCode::UNAUTHORIZED, "missing or wrong token", None);
    }
    let text = match decode(&headers, &body, ingest.server.limits.decoded) {
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
    match store(&ingest, &batch).await {
        Ok((accepted, duplicates)) => (
            StatusCode::ACCEPTED,
            Json(json!({ "accepted": accepted, "duplicates": duplicates })),
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

async fn store(ingest: &Ingest, batch: &Batch) -> nunatak_store::Result<(usize, usize)> {
    let mut seen = ingest.seen.lock().await;
    let known = seen.entry(batch.stream.id.clone()).or_default();
    let mut fresh: Vec<&Event> = Vec::new();
    let mut in_batch = HashSet::new();
    for event in &batch.events {
        if !known.has(event.seq) && in_batch.insert(event.seq) {
            fresh.push(event);
        }
    }
    let duplicates = batch.events.len() - fresh.len();

    let mut queries: Vec<&str> = Vec::new();
    let mut lines: HashMap<&str, Vec<&str>> = HashMap::new();
    for event in &fresh {
        if let Some(query) = event.query_id.as_deref() {
            if !lines.contains_key(query) {
                queries.push(query);
            }
            lines.entry(query).or_default().push(event.line.as_str());
        }
    }
    for query in &queries {
        ingest
            .server
            .log
            .append(query, &batch.process.line, &lines[query])
            .await?;
    }
    for event in fresh.iter().filter(|e| e.kind == Kind::Finished) {
        if let Some(query) = event.query_id.as_deref() {
            finish(ingest, query).await?;
        }
    }

    for event in &fresh {
        known.add(event.seq);
    }
    Ok((fresh.len(), duplicates))
}

async fn finish(ingest: &Ingest, query: &str) -> nunatak_store::Result<()> {
    let Some(text) = ingest.server.log.take(query).await? else {
        return Ok(());
    };
    let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
    gzip.write_all(&text)?;
    let key = RecordingKey(format!("{}/{query}.jsonl.gz", today()));
    ingest
        .server
        .recordings
        .put(&key, Bytes::from(gzip.finish()?))
        .await
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

fn problem(status: StatusCode, error: &str, line: Option<usize>) -> Response {
    let body = match line {
        Some(line) => json!({ "error": error, "line": line }),
        None => json!({ "error": error }),
    };
    (status, Json(body)).into_response()
}

fn today() -> String {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() / 86_400);
    let (year, month, day) = civil(i64::try_from(days).unwrap_or(0));
    format!("{year:04}/{month:02}/{day:02}")
}

fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stream_remembers_what_it_has_seen() {
        let mut seen = Seen::default();
        for seq in [1, 2, 4, 5] {
            seen.add(seq);
        }
        assert!(seen.has(2) && seen.has(5) && !seen.has(3));
        seen.add(3);
        assert_eq!(seen.through, 5);
        assert!(seen.above.is_empty());
    }

    #[test]
    fn days_become_dates() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(20_372), (2025, 10, 11));
        assert_eq!(civil(19_782), (2024, 2, 29));
    }
}
