use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use flate2::Compression;
use flate2::write::GzEncoder;
use http_body_util::BodyExt;
use nunatak_server::{Limits, Pipeline, app_router, ingest_router};
use nunatak_store_fs::{FsLog, FsRecordings};
use nunatak_store_sqlite::SqliteIndex;
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;

const TOKEN: &str = "s3cret-token";

fn example(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/schemas/examples")
        .join(name);
    std::fs::read_to_string(path).unwrap()
}

fn app(data: &std::path::Path) -> axum::Router {
    let pipeline = Arc::new(Pipeline::new(
        "default",
        Arc::new(FsLog::new(data)),
        Arc::new(FsRecordings::new(data)),
        Arc::new(SqliteIndex::in_memory().unwrap()),
    ));
    ingest_router(Arc::clone(&pipeline), TOKEN.into(), Limits::default())
        .merge(app_router(pipeline))
}

async fn post(app: &axum::Router, text: &str) {
    let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
    gzip.write_all(text.as_bytes()).unwrap();
    let request = Request::post("/v1/events")
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .header(header::CONTENT_ENCODING, "gzip")
        .body(Body::from(gzip.finish().unwrap()))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::ACCEPTED
    );
}

struct Feed(Body);

impl Feed {
    async fn open(app: &axum::Router, path: &str) -> Self {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/event-stream"
        );
        Self(response.into_body())
    }

    async fn until(&mut self, name: &str) -> String {
        let mut seen = String::new();
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(5), self.0.frame())
                .await
                .unwrap_or_else(|_| panic!("no {name} event; got {seen}"));
            let Some(Ok(frame)) = frame else {
                panic!("stream ended before {name}; got {seen}")
            };
            if let Ok(data) = frame.into_data() {
                let text = String::from_utf8_lossy(&data).into_owned();
                if text.contains(&format!("event: {name}\n")) {
                    return text;
                }
                seen.push_str(&text);
            }
        }
    }
}

fn data(event: &str) -> String {
    event
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn the_running_feed_opens_with_a_snapshot_then_reports_queries_and_pulses() {
    let data_dir = tempfile::tempdir().unwrap();
    let app = app(data_dir.path());
    let mut feed = Feed::open(&app, "/api/live").await;
    let snapshot: Value = serde_json::from_str(&data(&feed.until("snapshot").await)).unwrap();
    assert_eq!(snapshot["running"], serde_json::json!([]));

    post(&app, &example("unfinished.jsonl")).await;
    let query: Value = serde_json::from_str(&data(&feed.until("query").await)).unwrap();
    assert_eq!(query["status"], "running");
    let pulse: Value = serde_json::from_str(&data(&feed.until("pulse").await)).unwrap();
    assert_eq!(pulse["query_id"], query["query_id"]);
    assert!(pulse["threads"].as_array().unwrap().len() > 1);
    assert!(pulse["nodes"].as_u64().unwrap() > 0);

    let mut again = Feed::open(&app, "/api/live").await;
    let snapshot: Value = serde_json::from_str(&data(&again.until("snapshot").await)).unwrap();
    assert_eq!(snapshot["running"][0]["query_id"], query["query_id"]);
    assert_eq!(snapshot["pulses"][0]["query_id"], query["query_id"]);
}

#[tokio::test]
async fn a_followed_query_gets_its_events_so_far_then_new_ones_then_finished() {
    let data_dir = tempfile::tempdir().unwrap();
    let app = app(data_dir.path());
    let unfinished = example("unfinished.jsonl");
    post(&app, &unfinished).await;
    let started: Value = serde_json::from_str(unfinished.lines().nth(1).unwrap()).unwrap();
    let id = started["query_id"].as_str().unwrap();

    let mut feed = Feed::open(&app, &format!("/api/live/{id}")).await;
    let so_far = data(&feed.until("events").await);
    assert_eq!(so_far.lines().count(), unfinished.lines().count());

    post(&app, &example("finished.jsonl")).await;
    let fresh = data(&feed.until("events").await);
    assert_eq!(fresh.lines().count(), 1);
    assert!(fresh.contains("query.finished"));
    let finished: Value = serde_json::from_str(&data(&feed.until("finished").await)).unwrap();
    assert_eq!(finished["status"], "finished");
    assert!(
        tokio::time::timeout(Duration::from_secs(5), feed.0.frame())
            .await
            .unwrap()
            .is_none()
    );

    let mut done = Feed::open(&app, &format!("/api/live/{id}")).await;
    done.until("finished").await;
}
