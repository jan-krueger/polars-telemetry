use async_trait::async_trait;
use bytes::Bytes;
use serde::Serialize;
use std::collections::BTreeSet;

#[cfg(feature = "conformance")]
pub mod conformance;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("storage: {0}")]
    Io(#[from] std::io::Error),
    #[error("storage: {0}")]
    Backend(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct RecordingKey(pub String);

#[async_trait]
pub trait Recordings: Send + Sync {
    async fn put(&self, key: &RecordingKey, gzip: Bytes) -> Result<()>;
    async fn get(&self, key: &RecordingKey) -> Result<Option<Bytes>>;
    async fn delete(&self, key: &RecordingKey) -> Result<()>;
}

#[async_trait]
pub trait Log: Send + Sync {
    async fn append(&self, query_id: &str, process: &str, lines: &[&str]) -> Result<()>;
    async fn take(&self, query_id: &str) -> Result<Option<Bytes>>;
    async fn read(&self, query_id: &str) -> Result<Option<Bytes>>;
    async fn open(&self) -> Result<Vec<String>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Finished,
    Failed,
    Unfinished,
}

impl Status {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Finished => "finished",
            Self::Failed => "failed",
            Self::Unfinished => "unfinished",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "running" => Some(Self::Running),
            "finished" => Some(Self::Finished),
            "failed" => Some(Self::Failed),
            "unfinished" => Some(Self::Unfinished),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuerySummary {
    pub query_id: String,
    pub stream_id: String,
    pub project: String,
    pub service: Option<String>,
    pub environment: Option<String>,
    pub host: String,
    pub label: Option<String>,
    pub fingerprint: Option<String>,
    pub status: Status,
    pub started_unix_ns: i64,
    pub wall_ms: Option<f64>,
    pub cpu_ms: Option<f64>,
    pub result_rows: Option<i64>,
    pub failed: Option<String>,
    pub warnings: u32,
    pub rules: Vec<String>,
    pub recording: Option<RecordingKey>,
}

#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub project: Option<String>,
    pub label: Option<String>,
    pub fingerprint: Option<String>,
    pub service: Option<String>,
    pub environment: Option<String>,
    pub host: Option<String>,
    pub status: Option<Status>,
    pub since_unix_ns: Option<i64>,
    pub until_unix_ns: Option<i64>,
}

#[derive(Debug, Clone, Copy)]
pub struct Page {
    pub limit: u32,
    pub offset: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grouping {
    Label,
    Fingerprint,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GroupSummary {
    pub key: Option<String>,
    pub runs: u64,
    pub failed: u64,
    pub last_started_unix_ns: i64,
    pub total_wall_ms: f64,
    pub rules: Vec<String>,
    pub recent_wall_ms: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GroupRun {
    pub status: Status,
    pub started_unix_ns: i64,
    pub wall_ms: Option<f64>,
    pub rules: Vec<String>,
}

pub const RECENT_RUNS: usize = 30;

#[must_use]
pub fn summarize(key: Option<String>, runs: &[GroupRun]) -> GroupSummary {
    let mut order: Vec<&GroupRun> = runs.iter().collect();
    order.sort_by_key(|run| run.started_unix_ns);
    let finished: Vec<f64> = order
        .iter()
        .filter(|run| run.status == Status::Finished)
        .filter_map(|run| run.wall_ms)
        .collect();
    GroupSummary {
        key,
        runs: runs.len() as u64,
        failed: runs
            .iter()
            .filter(|run| run.status == Status::Failed)
            .count() as u64,
        last_started_unix_ns: order.last().map_or(0, |run| run.started_unix_ns),
        total_wall_ms: finished.iter().fold(0.0, |total, wall| total + wall),
        rules: runs
            .iter()
            .flat_map(|run| run.rules.iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        recent_wall_ms: finished[finished.len().saturating_sub(RECENT_RUNS)..].to_vec(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Count {
    pub value: Option<String>,
    pub runs: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Facets {
    pub service: Vec<Count>,
    pub environment: Vec<Count>,
    pub host: Vec<Count>,
    pub status: Vec<Count>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Seen {
    pub through: u64,
    pub above: BTreeSet<u64>,
}

impl Seen {
    #[must_use]
    pub fn has(&self, seq: u64) -> bool {
        seq <= self.through || self.above.contains(&seq)
    }

    pub fn add(&mut self, seq: u64) {
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

#[async_trait]
pub trait Index: Send + Sync {
    async fn put_query(&self, query: &QuerySummary) -> Result<()>;
    async fn query(&self, query_id: &str) -> Result<Option<QuerySummary>>;
    async fn list(&self, filter: &Filter, page: Page) -> Result<Vec<QuerySummary>>;
    async fn groups(&self, filter: &Filter, by: Grouping) -> Result<Vec<GroupSummary>>;
    async fn facets(&self, filter: &Filter) -> Result<Facets>;
    async fn seen(&self, stream_id: &str) -> Result<Seen>;
    async fn set_seen(&self, stream_id: &str, seen: &Seen) -> Result<()>;
    async fn delete(&self, query_ids: &[String]) -> Result<()>;
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
}
