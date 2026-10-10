#![allow(clippy::missing_panics_doc)]

use crate::{Count, Filter, Grouping, Index, Page, QuerySummary, RecordingKey, Seen, Status};

const PAGE: Page = Page {
    limit: 100,
    offset: 0,
};

#[must_use]
pub fn query(id: u8, label: &str, started: i64) -> QuerySummary {
    QuerySummary {
        query_id: format!("01a12532-7bcd-7082-8a3f-bd94907497{id:02x}"),
        stream_id: "5f0c2a1e-1111-4222-8333-944445555666".into(),
        project: "default".into(),
        service: Some("orders-etl".into()),
        environment: Some("prod".into()),
        host: "worker-3".into(),
        label: Some(label.into()),
        fingerprint: Some(format!("shape-{label}")),
        status: Status::Finished,
        started_unix_ns: started,
        wall_ms: Some(100.0),
        cpu_ms: Some(400.0),
        result_rows: Some(25),
        failed: None,
        warnings: 1,
        rules: vec!["python_udf".into()],
        recording: Some(RecordingKey(format!("2026/10/10/{id}.jsonl.gz"))),
    }
}

pub async fn a_query_reads_back_as_written(index: &dyn Index) {
    let written = query(1, "nightly", 1_000);
    index.put_query(&written).await.unwrap();
    assert_eq!(index.query(&written.query_id).await.unwrap(), Some(written));
    assert_eq!(index.query("nope").await.unwrap(), None);
}

pub async fn writing_a_query_again_replaces_it(index: &dyn Index) {
    let mut running = query(1, "nightly", 1_000);
    running.status = Status::Running;
    running.wall_ms = None;
    running.recording = None;
    index.put_query(&running).await.unwrap();
    let finished = query(1, "nightly", 1_000);
    index.put_query(&finished).await.unwrap();
    assert_eq!(
        index.query(&finished.query_id).await.unwrap(),
        Some(finished)
    );
    assert_eq!(index.list(&Filter::default(), PAGE).await.unwrap().len(), 1);
}

pub async fn a_list_is_newest_first_filtered_and_paged(index: &dyn Index) {
    for (id, label, started) in [(1, "a", 1_000), (2, "b", 3_000), (3, "a", 2_000)] {
        index.put_query(&query(id, label, started)).await.unwrap();
    }
    let mut failed = query(4, "b", 4_000);
    failed.status = Status::Failed;
    failed.failed = Some("boom".into());
    index.put_query(&failed).await.unwrap();

    let started =
        |list: Vec<QuerySummary>| list.iter().map(|q| q.started_unix_ns).collect::<Vec<_>>();
    let all = Filter::default();
    assert_eq!(
        started(index.list(&all, PAGE).await.unwrap()),
        [4_000, 3_000, 2_000, 1_000]
    );
    let label = Filter {
        label: Some("a".into()),
        ..Filter::default()
    };
    assert_eq!(
        started(index.list(&label, PAGE).await.unwrap()),
        [2_000, 1_000]
    );
    let failing = Filter {
        status: Some(Status::Failed),
        ..Filter::default()
    };
    assert_eq!(started(index.list(&failing, PAGE).await.unwrap()), [4_000]);
    let window = Filter {
        since_unix_ns: Some(2_000),
        until_unix_ns: Some(3_000),
        ..Filter::default()
    };
    assert_eq!(
        started(index.list(&window, PAGE).await.unwrap()),
        [3_000, 2_000]
    );
    let mut moved = query(2, "b", 3_000);
    moved.host = "worker-9".into();
    index.put_query(&moved).await.unwrap();
    let on_host = Filter {
        host: Some("worker-9".into()),
        ..Filter::default()
    };
    assert_eq!(started(index.list(&on_host, PAGE).await.unwrap()), [3_000]);
    let elsewhere = Filter {
        project: Some("other".into()),
        ..Filter::default()
    };
    assert_eq!(
        index.list(&elsewhere, PAGE).await.unwrap(),
        [] as [QuerySummary; 0]
    );
    let second_page = Page {
        limit: 2,
        offset: 2,
    };
    assert_eq!(
        started(index.list(&all, second_page).await.unwrap()),
        [2_000, 1_000]
    );
}

pub async fn groups_count_runs_failures_and_times(index: &dyn Index) {
    for (id, wall, started) in [(1, 300.0, 1_000), (2, 100.0, 2_000), (5, 200.0, 2_500)] {
        let mut run = query(id, "a", started);
        run.wall_ms = Some(wall);
        index.put_query(&run).await.unwrap();
    }
    let mut reshaped = query(6, "a", 2_600);
    reshaped.fingerprint = Some("shape-a2".into());
    reshaped.wall_ms = Some(400.0);
    index.put_query(&reshaped).await.unwrap();
    let mut failed = query(3, "b", 3_000);
    failed.status = Status::Failed;
    index.put_query(&failed).await.unwrap();

    let groups = index
        .groups(&Filter::default(), Grouping::Label)
        .await
        .unwrap();
    let a = groups
        .iter()
        .find(|g| g.key.as_deref() == Some("a"))
        .unwrap();
    assert_eq!((a.runs, a.failed, a.last_started_unix_ns), (4, 0, 2_600));
    assert!((a.total_wall_ms - 1_000.0).abs() < 1e-9);
    assert_eq!(a.rules, ["python_udf"]);
    assert_eq!(a.recent_wall_ms, [300.0, 100.0, 200.0, 400.0]);
    let b = groups
        .iter()
        .find(|g| g.key.as_deref() == Some("b"))
        .unwrap();
    assert_eq!((b.runs, b.failed, b.total_wall_ms), (1, 1, 0.0));
    assert_eq!(groups[0].key.as_deref(), Some("b"));
    let shapes = index
        .groups(&Filter::default(), Grouping::Fingerprint)
        .await
        .unwrap();
    assert!(
        shapes
            .iter()
            .any(|g| g.key.as_deref() == Some("shape-a") && g.runs == 3)
    );
}

pub async fn facets_count_runs_per_value(index: &dyn Index) {
    index.put_query(&query(1, "a", 1_000)).await.unwrap();
    let mut elsewhere = query(2, "a", 2_000);
    elsewhere.host = "worker-9".into();
    elsewhere.environment = None;
    elsewhere.status = Status::Failed;
    index.put_query(&elsewhere).await.unwrap();
    index.put_query(&query(3, "b", 3_000)).await.unwrap();

    let facets = index.facets(&Filter::default()).await.unwrap();
    let count = |value: Option<&str>, runs| Count {
        value: value.map(str::to_owned),
        runs,
    };
    assert_eq!(facets.service, [count(Some("orders-etl"), 3)]);
    assert_eq!(
        facets.host,
        [count(Some("worker-3"), 2), count(Some("worker-9"), 1)]
    );
    assert_eq!(facets.environment, [count(Some("prod"), 2), count(None, 1)]);
    assert_eq!(
        facets.status,
        [count(Some("finished"), 2), count(Some("failed"), 1)]
    );
    let only_b = Filter {
        label: Some("b".into()),
        ..Filter::default()
    };
    assert_eq!(
        index.facets(&only_b).await.unwrap().service,
        [count(Some("orders-etl"), 1)]
    );
}

pub async fn a_stream_keeps_what_it_has_seen(index: &dyn Index) {
    let stream = "5f0c2a1e-1111-4222-8333-944445555666";
    assert_eq!(index.seen(stream).await.unwrap(), Seen::default());
    let mut seen = Seen::default();
    for seq in [1, 2, 5] {
        seen.add(seq);
    }
    index.set_seen(stream, &seen).await.unwrap();
    assert_eq!(index.seen(stream).await.unwrap(), seen);
}

#[macro_export]
macro_rules! conformance {
    ($index:expr) => {
        mod conformance {
            use super::*;

            #[tokio::test]
            async fn a_query_reads_back_as_written() {
                $crate::conformance::a_query_reads_back_as_written(&$index).await;
            }

            #[tokio::test]
            async fn writing_a_query_again_replaces_it() {
                $crate::conformance::writing_a_query_again_replaces_it(&$index).await;
            }

            #[tokio::test]
            async fn a_list_is_newest_first_filtered_and_paged() {
                $crate::conformance::a_list_is_newest_first_filtered_and_paged(&$index).await;
            }

            #[tokio::test]
            async fn groups_count_runs_failures_and_times() {
                $crate::conformance::groups_count_runs_failures_and_times(&$index).await;
            }

            #[tokio::test]
            async fn facets_count_runs_per_value() {
                $crate::conformance::facets_count_runs_per_value(&$index).await;
            }

            #[tokio::test]
            async fn a_stream_keeps_what_it_has_seen() {
                $crate::conformance::a_stream_keeps_what_it_has_seen(&$index).await;
            }
        }
    };
}
