use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use http_body_util::BodyExt;
use nunatak_server::{Limits, Server, router};
use nunatak_store_fs::{FsLog, FsRecordings};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tower::ServiceExt;

const TOKEN: &str = "s3cret-token";

fn example(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/schemas/examples")
        .join(name);
    std::fs::read_to_string(path).unwrap()
}

fn app(data: &Path) -> axum::Router {
    router(Server {
        token: TOKEN.into(),
        limits: Limits::default(),
        log: Arc::new(FsLog::new(data)),
        recordings: Arc::new(FsRecordings::new(data)),
    })
}

fn gzip(text: &str) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(text.as_bytes()).unwrap();
    encoder.finish().unwrap()
}

async fn post(app: &axum::Router, token: &str, body: Vec<u8>) -> (StatusCode, Value) {
    let request = Request::post("/v1/events")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CONTENT_ENCODING, "gzip")
        .body(Body::from(body))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn recordings(data: &Path) -> Vec<PathBuf> {
    fn walk(folder: &Path, found: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(folder).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, found);
            } else {
                found.push(path);
            }
        }
    }
    let mut found = Vec::new();
    walk(&data.join("recordings"), &mut found);
    found
}

fn lines(path: &Path) -> Vec<String> {
    let mut text = String::new();
    GzDecoder::new(std::fs::File::open(path).unwrap())
        .read_to_string(&mut text)
        .unwrap();
    text.lines().map(str::to_owned).collect()
}

#[tokio::test]
async fn a_finished_query_becomes_a_recording_with_every_event() {
    let data = tempfile::tempdir().unwrap();
    let app = app(data.path());
    let sent = example("finished.jsonl");
    let (status, body) = post(&app, TOKEN, gzip(&sent)).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(body["duplicates"], 0);
    assert_eq!(body["accepted"], sent.lines().count() - 1);
    let stored = recordings(data.path());
    assert_eq!(stored.len(), 1);
    assert_eq!(
        lines(&stored[0]),
        sent.lines().map(str::to_owned).collect::<Vec<_>>()
    );
    assert!(
        std::fs::read_dir(data.path().join("live"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[tokio::test]
async fn a_query_still_running_stays_in_the_log() {
    let data = tempfile::tempdir().unwrap();
    let app = app(data.path());
    let (status, _) = post(&app, TOKEN, gzip(&example("unfinished.jsonl"))).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(recordings(data.path()), [] as [std::path::PathBuf; 0]);
    assert_eq!(
        std::fs::read_dir(data.path().join("live")).unwrap().count(),
        1
    );
}

#[tokio::test]
async fn events_sent_again_are_counted_and_not_stored_twice() {
    let data = tempfile::tempdir().unwrap();
    let app = app(data.path());
    let unfinished = example("unfinished.jsonl");
    post(&app, TOKEN, gzip(&unfinished)).await;
    let (status, body) = post(&app, TOKEN, gzip(&example("finished.jsonl"))).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(body["accepted"], 1);
    assert_eq!(body["duplicates"], unfinished.lines().count() - 1);
    let stored = recordings(data.path());
    assert_eq!(
        lines(&stored[0]).len(),
        example("finished.jsonl").lines().count()
    );
}

#[tokio::test]
async fn a_wrong_token_is_refused() {
    let data = tempfile::tempdir().unwrap();
    let (status, body) = post(&app(data.path()), "wrong", gzip(&example("finished.jsonl"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "missing or wrong token");
    assert_eq!(recordings(data.path()), [] as [std::path::PathBuf; 0]);
}

#[tokio::test]
async fn a_broken_batch_is_refused_with_its_line() {
    let data = tempfile::tempdir().unwrap();
    let text = example("finished.jsonl").replacen("events@1", "events@9", 1);
    let (status, body) = post(&app(data.path()), TOKEN, gzip(&text)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["line"], 1);
    let (status, body) = post(&app(data.path()), TOKEN, b"not gzip".to_vec()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "the body is not valid gzip");
}

#[tokio::test]
async fn a_batch_too_large_once_decompressed_is_refused() {
    let data = tempfile::tempdir().unwrap();
    let small = router(Server {
        token: TOKEN.into(),
        limits: Limits {
            body: 1024 * 1024,
            decoded: 1000,
        },
        log: Arc::new(FsLog::new(data.path())),
        recordings: Arc::new(FsRecordings::new(data.path())),
    });
    let (status, _) = post(&small, TOKEN, gzip(&example("finished.jsonl"))).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn health_answers_without_a_token() {
    let data = tempfile::tempdir().unwrap();
    let request = Request::get("/v1/health").body(Body::empty()).unwrap();
    let response = app(data.path()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["protocol"][0], "polars-telemetry/events@1");
}
