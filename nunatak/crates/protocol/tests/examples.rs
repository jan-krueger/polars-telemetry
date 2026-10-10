use nunatak_protocol::{Kind, Summary, parse, parse_streams};
use std::path::PathBuf;

fn example(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/schemas/examples")
        .join(name);
    std::fs::read_to_string(path).expect("the example recordings are in docs/schemas/examples")
}

#[test]
fn the_example_recordings_parse_as_one_stream() {
    let batch = parse(&example("finished.jsonl")).unwrap();
    let kinds: Vec<Kind> = batch.events.iter().map(|e| e.kind.clone()).collect();
    assert_eq!(kinds.first(), Some(&Kind::Started));
    assert_eq!(kinds.last(), Some(&Kind::Finished));
    assert!(kinds.contains(&Kind::Progress));
    assert_eq!(batch.stream.service.as_deref(), Some("clickbench"));
    assert!(
        parse(&example("unfinished.jsonl"))
            .unwrap()
            .events
            .iter()
            .all(|e| e.kind != Kind::Finished)
    );
}

#[test]
fn events_keep_their_line_and_seq() {
    let text = example("finished.jsonl");
    let batch = parse(&text).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(batch.process.line, lines[0]);
    assert_eq!(batch.events[0].line, lines[1]);
    let seqs: Vec<u64> = batch.events.iter().map(|e| e.seq).collect();
    assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]));
}

const PROCESS: &str = r#"{"schema":"polars-telemetry/events@1","seq":1,"type":"process","id":"5f0c2a1e-1111-4222-8333-944445555666","host":"h","pid":1,"polars_telemetry_version":"0.9.0","started_unix_ns":1}"#;

fn problem(text: &str) -> (usize, String) {
    let error = parse(text).unwrap_err();
    (error.line, error.problem)
}

#[test]
fn a_broken_batch_names_the_line_and_the_reason() {
    assert_eq!(problem(""), (1, "the batch is empty".into()));
    let progress = r#"{"schema":"polars-telemetry/events@1","seq":2,"type":"query.progress","query_id":"01a12532-7bcd-7082-8a3f-bd94907497ea","elapsed_ms":1,"nodes":{}}"#;
    assert_eq!(
        problem(progress),
        (1, "a batch starts with its process event".into())
    );
    let wrong_schema = PROCESS.replace("events@1", "events@2");
    assert!(
        problem(&wrong_schema)
            .1
            .contains("is not polars-telemetry/events@1")
    );
    let no_seq = format!("{PROCESS}\n{}", progress.replace(r#""seq":2,"#, ""));
    assert_eq!(
        problem(&no_seq),
        (2, "seq must be a whole number from 1".into())
    );
    let bad_id = format!(
        "{PROCESS}\n{}",
        progress.replace("01a12532-7bcd-7082-8a3f-bd94907497ea", "nope")
    );
    assert_eq!(problem(&bad_id), (2, "query_id must be a UUID".into()));
}

#[test]
fn new_event_types_and_fields_are_kept() {
    let text = format!(
        "{PROCESS}\n{}",
        r#"{"schema":"polars-telemetry/events@1","seq":2,"type":"query.paused","extra":true}"#
    );
    let batch = parse(&text).unwrap();
    assert_eq!(batch.events[0].kind, Kind::Other("query.paused".into()));
}

#[test]
fn a_file_with_several_streams_splits_into_one_batch_each() {
    let first = example("finished.jsonl");
    let events: Vec<&str> = first.lines().skip(1).collect();
    let text = format!("{first}{PROCESS}\n{}\n", events.join("\n"));
    let batches = parse_streams(&text).unwrap();
    assert_eq!(batches.len(), 2);
    assert_ne!(batches[0].stream.id, batches[1].stream.id);
    assert_eq!(batches[0].events.len(), batches[1].events.len());
    assert_eq!(
        parse(&text).unwrap_err().problem,
        "a batch holds one stream"
    );
}

#[test]
fn a_profile_gives_its_summary() {
    let text = example("finished.jsonl");
    let finished = text.lines().last().unwrap();
    let summary = Summary::of(finished).unwrap();
    assert_eq!(summary.label.as_deref(), Some("clickbench/regex_domains"));
    assert!(summary.wall_ms.unwrap() > 0.0);
    assert!(summary.started_unix_ns.unwrap() > 0);
    assert!(summary.fingerprint.is_some());
    assert_eq!(summary.failed, None);
    assert!(Summary::of(text.lines().nth(2).unwrap()).is_none());
}

#[test]
fn a_summary_names_each_warning_rule_once() {
    let line = r#"{"profile":{"insights":{"findings":[
        {"rule":"python_udf","level":"warn"},
        {"rule":"python_udf","level":"warn"},
        {"rule":"cross_join","level":"info"}]}}}"#
        .replace('\n', "");
    let summary = Summary::of(&line).unwrap();
    assert_eq!(summary.warnings, 2);
    assert_eq!(summary.rules, ["python_udf"]);
}
