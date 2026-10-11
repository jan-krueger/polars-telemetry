#![allow(clippy::missing_panics_doc)]

use crate::{Combination, Filter, Index, Page, QuerySummary, RecordingKey, Run, Seen, Status};

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

pub async fn runs_come_oldest_first_with_what_overviews_need(index: &dyn Index) {
    for (id, label, started) in [(1, "a", 2_000), (2, "b", 1_000), (3, "a", 3_000)] {
        index.put_query(&query(id, label, started)).await.unwrap();
    }
    let mut failed = query(4, "a", 4_000);
    failed.status = Status::Failed;
    failed.wall_ms = None;
    failed.service = None;
    failed.label = None;
    index.put_query(&failed).await.unwrap();

    let runs = index.runs(&Filter::default()).await.unwrap();
    let started: Vec<i64> = runs.iter().map(|run| run.started_unix_ns).collect();
    assert_eq!(started, [1_000, 2_000, 3_000, 4_000]);
    assert_eq!(
        runs[0],
        Run {
            query_id: query(2, "b", 1_000).query_id,
            label: Some("b".into()),
            fingerprint: Some("shape-b".into()),
            service: Some("orders-etl".into()),
            status: Status::Finished,
            started_unix_ns: 1_000,
            wall_ms: Some(100.0),
            rules: vec!["python_udf".into()],
        }
    );
    assert_eq!(
        (
            runs[3].label.as_deref(),
            runs[3].service.as_deref(),
            runs[3].wall_ms
        ),
        (None, None, None)
    );
    let only_a = Filter {
        label: Some("a".into()),
        since_unix_ns: Some(2_500),
        ..Filter::default()
    };
    let kept: Vec<i64> = index
        .runs(&only_a)
        .await
        .unwrap()
        .iter()
        .map(|run| run.started_unix_ns)
        .collect();
    assert_eq!(kept, [3_000]);
}

pub async fn combinations_count_runs_per_mix_of_fields(index: &dyn Index) {
    index.put_query(&query(1, "a", 1_000)).await.unwrap();
    let mut elsewhere = query(2, "a", 2_000);
    elsewhere.host = "worker-9".into();
    elsewhere.environment = None;
    elsewhere.status = Status::Failed;
    index.put_query(&elsewhere).await.unwrap();
    index.put_query(&query(3, "b", 3_000)).await.unwrap();

    let mut combinations = index.combinations(&Filter::default()).await.unwrap();
    combinations.sort_by_key(|c| c.runs);
    let mix = |environment: Option<&str>, host: &str, status, runs| Combination {
        service: Some("orders-etl".into()),
        environment: environment.map(str::to_owned),
        host: host.into(),
        status,
        runs,
    };
    assert_eq!(
        combinations,
        [
            mix(None, "worker-9", Status::Failed, 1),
            mix(Some("prod"), "worker-3", Status::Finished, 2),
        ]
    );
    let only_b = Filter {
        label: Some("b".into()),
        ..Filter::default()
    };
    assert_eq!(
        index.combinations(&only_b).await.unwrap(),
        [mix(Some("prod"), "worker-3", Status::Finished, 1)]
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

pub async fn deleted_queries_are_gone(index: &dyn Index) {
    for (id, started) in [(1, 1_000), (2, 2_000), (3, 3_000)] {
        index.put_query(&query(id, "a", started)).await.unwrap();
    }
    let gone = [
        query(1, "a", 0).query_id,
        query(2, "a", 0).query_id,
        "missing".to_owned(),
    ];
    index.delete(&gone).await.unwrap();
    let left = index
        .list(
            &Filter::default(),
            Page {
                limit: 10,
                offset: 0,
            },
        )
        .await
        .unwrap();
    assert_eq!(left, [query(3, "a", 3_000)]);
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
            async fn runs_come_oldest_first_with_what_overviews_need() {
                $crate::conformance::runs_come_oldest_first_with_what_overviews_need(&$index).await;
            }

            #[tokio::test]
            async fn combinations_count_runs_per_mix_of_fields() {
                $crate::conformance::combinations_count_runs_per_mix_of_fields(&$index).await;
            }

            #[tokio::test]
            async fn deleted_queries_are_gone() {
                $crate::conformance::deleted_queries_are_gone(&$index).await;
            }

            #[tokio::test]
            async fn a_stream_keeps_what_it_has_seen() {
                $crate::conformance::a_stream_keeps_what_it_has_seen(&$index).await;
            }
        }
    };
}
