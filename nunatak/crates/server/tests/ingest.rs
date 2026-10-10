use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use http_body_util::BodyExt;
use nunatak_server::{Limits, Pipeline, app_router, ingest_router};
use nunatak_store_fs::{FsLog, FsRecordings};
use nunatak_store_sqlite::SqliteIndex;
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

fn pipeline(data: &Path) -> Arc<Pipeline> {
    Arc::new(Pipeline::new(
        "default",
        Arc::new(FsLog::new(data)),
        Arc::new(FsRecordings::new(data)),
        Arc::new(SqliteIndex::in_memory().unwrap()),
    ))
}

fn app(data: &Path) -> axum::Router {
    let pipeline = pipeline(data);
    ingest_router(Arc::clone(&pipeline), TOKEN.into(), Limits::default())
        .merge(app_router(pipeline))
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
    assert_eq!(body["error"], "the body could not be read as gzip");
}

#[tokio::test]
async fn a_batch_too_large_once_decompressed_is_refused() {
    let data = tempfile::tempdir().unwrap();
    let small = ingest_router(
        pipeline(data.path()),
        TOKEN.into(),
        Limits {
            body: 1024 * 1024,
            decoded: 1000,
        },
    );
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

async fn get(app: &axum::Router, path: &str) -> (StatusCode, Vec<u8>) {
    let request = Request::get(path).body(Body::empty()).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    (
        status,
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
}

async fn get_json(app: &axum::Router, path: &str) -> (StatusCode, Value) {
    let (status, body) = get(app, path).await;
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn a_finished_query_is_listed_with_its_summary_and_recording() {
    let data = tempfile::tempdir().unwrap();
    let app = app(data.path());
    post(&app, TOKEN, gzip(&example("finished.jsonl"))).await;
    let (status, list) = get_json(&app, "/api/queries").await;
    assert_eq!(status, StatusCode::OK);
    let query = &list[0];
    assert_eq!(query["status"], "finished");
    assert_eq!(query["label"], "clickbench/regex_domains");
    assert_eq!(query["service"], "clickbench");
    assert!(query["wall_ms"].as_f64().unwrap() > 0.0);
    let id = query["query_id"].as_str().unwrap();
    let (status, one) = get_json(&app, &format!("/api/queries/{id}")).await;
    assert_eq!((status, &one), (StatusCode::OK, query));
    let (status, recording) = get(&app, &format!("/api/queries/{id}/recording")).await;
    assert_eq!(status, StatusCode::OK);
    let mut text = String::new();
    GzDecoder::new(&recording[..])
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, example("finished.jsonl"));
}

#[tokio::test]
async fn a_running_query_is_listed_as_running_without_a_recording() {
    let data = tempfile::tempdir().unwrap();
    let app = app(data.path());
    post(&app, TOKEN, gzip(&example("unfinished.jsonl"))).await;
    let (_, list) = get_json(&app, "/api/queries?status=running").await;
    assert_eq!(list[0]["status"], "running");
    assert_eq!(list[0]["label"], "clickbench/regex_domains");
    let id = list[0]["query_id"].as_str().unwrap();
    let (status, _) = get(&app, &format!("/api/queries/{id}/recording")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, finished) = get_json(&app, "/api/queries?status=finished").await;
    assert_eq!(finished, serde_json::json!([]));
}

#[tokio::test]
async fn groups_and_filters_answer_and_refuse_what_they_do_not_know() {
    let data = tempfile::tempdir().unwrap();
    let app = app(data.path());
    post(&app, TOKEN, gzip(&example("finished.jsonl"))).await;
    let (_, groups) = get_json(&app, "/api/groups?by=label").await;
    assert_eq!(groups[0]["key"], "clickbench/regex_domains");
    assert_eq!(groups[0]["runs"], 1);
    assert!(groups[0]["usual_wall_ms"].as_f64().unwrap() > 0.0);
    assert_eq!(groups[0]["recent_wall_ms"].as_array().unwrap().len(), 1);
    let (_, facets) = get_json(&app, "/api/facets").await;
    assert_eq!(facets["service"][0]["value"], "clickbench");
    assert_eq!(
        facets["status"][0],
        serde_json::json!({ "value": "finished", "runs": 1 })
    );
    let (status, body) = get_json(&app, "/api/groups?by=color").await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("cannot group by color"))
    );
    let (status, _) = get_json(&app, "/api/queries?status=sleepy").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = get_json(&app, "/api/queries/01a12532-0000-0000-0000-000000000000").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn events_seen_before_a_restart_are_still_recognised() {
    let data = tempfile::tempdir().unwrap();
    let index = Arc::new(SqliteIndex::open(&data.path().join("index.db")).unwrap());
    let started = |index: Arc<SqliteIndex>| {
        let pipeline = Arc::new(Pipeline::new(
            "default",
            Arc::new(FsLog::new(data.path())),
            Arc::new(FsRecordings::new(data.path())),
            index,
        ));
        ingest_router(pipeline, TOKEN.into(), Limits::default())
    };
    post(
        &started(Arc::clone(&index)),
        TOKEN,
        gzip(&example("unfinished.jsonl")),
    )
    .await;
    drop(index);
    let reopened = Arc::new(SqliteIndex::open(&data.path().join("index.db")).unwrap());
    let (_, body) = post(&started(reopened), TOKEN, gzip(&example("finished.jsonl"))).await;
    assert_eq!(body["accepted"], 1);
}

#[tokio::test]
async fn an_imported_file_is_stored_like_sent_events_and_unfinished_queries_are_closed() {
    let data = tempfile::tempdir().unwrap();
    let pipeline = pipeline(data.path());
    let finished = example("finished.jsonl");
    let started: Value = serde_json::from_str(finished.lines().nth(1).unwrap()).unwrap();
    let process: Value = serde_json::from_str(finished.lines().next().unwrap()).unwrap();
    let query = started["query_id"].as_str().unwrap();
    let stream = process["id"].as_str().unwrap();
    let elsewhere = example("unfinished.jsonl")
        .replace(query, "01a12532-0000-7000-8000-000000000001")
        .replace(stream, "5f0c2a1e-0000-4000-8000-000000000002");

    let imported = pipeline
        .import(&format!("{finished}{elsewhere}"))
        .await
        .unwrap();
    assert_eq!(
        imported.running,
        vec!["01a12532-0000-7000-8000-000000000001".to_owned()]
    );

    let app = app_router(Arc::clone(&pipeline));
    let (_, list) = get_json(&app, "/api/queries").await;
    let mut statuses: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|q| q["status"].as_str().unwrap())
        .collect();
    statuses.sort_unstable();
    assert_eq!(statuses, ["finished", "unfinished"]);
    let (status, _) = get(
        &app,
        "/api/queries/01a12532-0000-7000-8000-000000000001/recording",
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let again = pipeline.import(&finished).await.unwrap();
    assert_eq!(again.accepted, 0);
    assert!(pipeline.import("not json").await.is_err());
}

#[tokio::test]
async fn every_page_path_gets_the_dashboard_and_unknown_api_paths_a_json_404() {
    let data = tempfile::tempdir().unwrap();
    let app = app(data.path());
    for path in [
        "/",
        "/queries",
        "/queries/01a12532-7bcd-7082-8a3f-bd94907497ea",
    ] {
        let (status, body) = get(&app, path).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert!(
            String::from_utf8(body).unwrap().contains("Nunatak"),
            "{path}"
        );
    }
    let (status, body) = get_json(&app, "/api/nothing").await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::NOT_FOUND, Some("no such API"))
    );
}

#[tokio::test]
async fn facets_keep_every_value_and_count_each_field_under_the_other_filters() {
    let data = tempfile::tempdir().unwrap();
    let app = app(data.path());
    post(&app, TOKEN, gzip(&example("finished.jsonl"))).await;
    let process: Value =
        serde_json::from_str(example("finished.jsonl").lines().next().unwrap()).unwrap();
    let started: Value =
        serde_json::from_str(example("finished.jsonl").lines().nth(1).unwrap()).unwrap();
    let other = example("finished.jsonl")
        .replace(
            process["id"].as_str().unwrap(),
            "5f0c2a1e-0000-4000-8000-000000000002",
        )
        .replace(
            started["query_id"].as_str().unwrap(),
            "01a12532-0000-7000-8000-000000000001",
        )
        .replace("\"worker-3\"", "\"worker-4\"");
    post(&app, TOKEN, gzip(&other)).await;

    let (_, on_host) = get_json(&app, "/api/queries?host=worker-4").await;
    assert_eq!(on_host.as_array().unwrap().len(), 1);
    let (_, facets) = get_json(&app, "/api/facets?host=worker-4&status=failed").await;
    let hosts: Vec<(String, u64)> = facets["host"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["value"].as_str().unwrap().to_owned(),
                c["runs"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(hosts.len(), 2);
    assert!(hosts.iter().all(|(_, runs)| *runs == 0));
    let statuses = facets["status"].as_array().unwrap();
    assert_eq!(
        statuses[0],
        serde_json::json!({ "value": "finished", "runs": 1 })
    );
}

#[tokio::test]
async fn a_query_whose_process_went_silent_is_closed_as_unfinished_with_its_recording() {
    let data = tempfile::tempdir().unwrap();
    let pipeline = pipeline(data.path());
    let app = ingest_router(Arc::clone(&pipeline), TOKEN.into(), Limits::default());
    post(&app, TOKEN, gzip(&example("unfinished.jsonl"))).await;

    let still = pipeline
        .close_silent(std::time::Duration::from_mins(1))
        .await
        .unwrap();
    assert_eq!(still, Vec::<String>::new());
    let closed = pipeline
        .close_silent(std::time::Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(closed.len(), 1);

    let row = pipeline.index().query(&closed[0]).await.unwrap().unwrap();
    assert_eq!(row.status.as_str(), "unfinished");
    assert!(row.recording.is_some());
    assert_eq!(recordings(data.path()).len(), 1);
    assert_eq!(pipeline.live().pulses(), Vec::new());
}

#[tokio::test]
async fn a_closed_query_that_reports_again_keeps_everything_in_one_recording() {
    let data = tempfile::tempdir().unwrap();
    let pipeline = pipeline(data.path());
    let app = ingest_router(Arc::clone(&pipeline), TOKEN.into(), Limits::default());
    let all: Vec<&str> = example("finished.jsonl").leak().lines().collect();
    post(&app, TOKEN, gzip(&(all[..5].join("\n") + "\n"))).await;
    let closed = pipeline
        .close_silent(std::time::Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(closed.len(), 1);

    post(
        &app,
        TOKEN,
        gzip(&format!("{}\n{}\n", all[0], all[5..7].join("\n"))),
    )
    .await;
    let row = pipeline.index().query(&closed[0]).await.unwrap().unwrap();
    assert_eq!(row.status.as_str(), "running");
    post(
        &app,
        TOKEN,
        gzip(&format!("{}\n{}\n", all[0], all[7..].join("\n"))),
    )
    .await;

    let row = pipeline.index().query(&closed[0]).await.unwrap().unwrap();
    assert_eq!(row.status.as_str(), "finished");
    let stored = recordings(data.path());
    assert_eq!(stored.len(), 1);
    assert_eq!(lines(&stored[0]), all);
}
