use crate::live::{Change, Live};
use bytes::Bytes;
use flate2::Compression;
use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use nunatak_protocol::{Batch, Event, Kind, Stream, Summary};
use nunatak_store::{
    Filter, Index, Log, Page, QuerySummary, RecordingKey, Recordings, Result, Seen, Status,
};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::{Arc, PoisonError};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub struct Pipeline {
    project: String,
    log: Arc<dyn Log>,
    recordings: Arc<dyn Recordings>,
    index: Arc<dyn Index>,
    streams: Mutex<HashMap<String, Seen>>,
    heard: std::sync::Mutex<HashMap<String, Instant>>,
    live: Live,
}

#[derive(Debug, thiserror::Error)]
pub enum Imported {
    #[error("{0}")]
    Invalid(nunatak_protocol::Invalid),
    #[error("{0}")]
    Storage(nunatak_store::Error),
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Accepted {
    pub accepted: usize,
    pub duplicates: usize,
    pub running: Vec<String>,
}

impl Pipeline {
    pub fn new(
        project: impl Into<String>,
        log: Arc<dyn Log>,
        recordings: Arc<dyn Recordings>,
        index: Arc<dyn Index>,
    ) -> Self {
        Self {
            project: project.into(),
            log,
            recordings,
            index,
            streams: Mutex::new(HashMap::new()),
            heard: std::sync::Mutex::new(HashMap::new()),
            live: Live::default(),
        }
    }

    pub fn project(&self) -> &str {
        &self.project
    }

    pub fn index(&self) -> &dyn Index {
        self.index.as_ref()
    }

    pub fn recordings(&self) -> &dyn Recordings {
        self.recordings.as_ref()
    }

    pub fn live(&self) -> &Live {
        &self.live
    }

    pub fn log(&self) -> &dyn Log {
        self.log.as_ref()
    }

    pub async fn accept(&self, batch: &Batch) -> Result<Accepted> {
        let mut streams = self.streams.lock().await;
        if !streams.contains_key(&batch.stream.id) {
            let seen = self.index.seen(&batch.stream.id).await?;
            streams.insert(batch.stream.id.clone(), seen);
        }
        let mut seen = streams[&batch.stream.id].clone();
        let mut fresh: Vec<&Event> = Vec::new();
        let mut in_batch = HashSet::new();
        for event in &batch.events {
            if !seen.has(event.seq) && in_batch.insert(event.seq) {
                fresh.push(event);
            }
        }

        let mut order: Vec<&str> = Vec::new();
        let mut by_query: HashMap<&str, Vec<&Event>> = HashMap::new();
        for event in &fresh {
            if let Some(query) = event.query_id.as_deref() {
                if !by_query.contains_key(query) {
                    order.push(query);
                }
                by_query.entry(query).or_default().push(event);
            }
        }

        let mut running = Vec::new();
        for query in order {
            let events = &by_query[query];
            let lines: Vec<&str> = events.iter().map(|e| e.line.as_str()).collect();
            self.log.append(query, &batch.process.line, &lines).await?;
            self.live.publish(Change::Events {
                query_id: query.to_owned(),
                lines: events.iter().map(|e| (e.seq, e.line.clone())).collect(),
            });
            let started = events.iter().find(|e| e.kind == Kind::Started);
            if let Some(started) = started {
                self.live.started(query, &started.line);
            }
            if let Some(finished) = events.iter().find(|e| e.kind == Kind::Finished) {
                let row = self.finish(&batch.stream, query, finished).await?;
                self.heard().remove(query);
                self.live.finished(query);
                self.live.publish(Change::Query(Box::new(row)));
            } else {
                if let Some(row) = self.start(&batch.stream, query, started.copied()).await? {
                    self.live.publish(Change::Query(Box::new(row)));
                }
                let pulse = events
                    .iter()
                    .filter(|e| e.kind == Kind::Progress)
                    .filter_map(|e| self.live.progress(query, &e.line))
                    .last();
                if let Some(pulse) = pulse {
                    self.live.publish(Change::Pulse(pulse));
                }
                self.heard().insert(query.to_owned(), Instant::now());
                running.push(query.to_owned());
            }
        }

        for event in &fresh {
            seen.add(event.seq);
        }
        self.index.set_seen(&batch.stream.id, &seen).await?;
        streams.insert(batch.stream.id.clone(), seen);
        Ok(Accepted {
            accepted: fresh.len(),
            duplicates: batch.events.len() - fresh.len(),
            running,
        })
    }

    pub async fn import(&self, text: &str) -> std::result::Result<Accepted, Imported> {
        let batches = nunatak_protocol::parse_streams(text).map_err(Imported::Invalid)?;
        let mut total = Accepted::default();
        for batch in &batches {
            let accepted = self.accept(batch).await.map_err(Imported::Storage)?;
            total.accepted += accepted.accepted;
            total.duplicates += accepted.duplicates;
            total.running.extend(accepted.running);
        }
        total.running.sort();
        total.running.dedup();
        for query in &total.running {
            self.close_unfinished(query)
                .await
                .map_err(Imported::Storage)?;
        }
        Ok(total)
    }

    pub async fn close_silent(&self, quiet: Duration) -> Result<Vec<String>> {
        let _streams = self.streams.lock().await;
        let filter = Filter {
            project: Some(self.project.clone()),
            status: Some(Status::Running),
            ..Filter::default()
        };
        let running = self
            .index
            .list(
                &filter,
                Page {
                    limit: u32::MAX,
                    offset: 0,
                },
            )
            .await?;
        let now = Instant::now();
        let silent: Vec<String> = {
            let mut heard = self.heard();
            running
                .into_iter()
                .filter(|row| {
                    let at = *heard.entry(row.query_id.clone()).or_insert(now);
                    now.duration_since(at) >= quiet
                })
                .map(|row| row.query_id)
                .collect()
        };
        for query in &silent {
            self.close_unfinished(query).await?;
            self.heard().remove(query);
            self.live.finished(query);
            if let Some(row) = self.index.query(query).await? {
                self.live.publish(Change::Query(Box::new(row)));
            }
        }
        Ok(silent)
    }

    fn heard(&self) -> std::sync::MutexGuard<'_, HashMap<String, Instant>> {
        self.heard.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub async fn close_unfinished(&self, query: &str) -> Result<()> {
        let Some(mut row) = self.index.query(query).await? else {
            return Ok(());
        };
        if row.status != Status::Running {
            return Ok(());
        }
        row.recording = self
            .record(query, row.started_unix_ns, row.recording.as_ref())
            .await?;
        row.status = Status::Unfinished;
        self.index.put_query(&row).await
    }

    async fn start(
        &self,
        stream: &Stream,
        query: &str,
        started: Option<&Event>,
    ) -> Result<Option<QuerySummary>> {
        let existing = self.index.query(query).await?;
        if started.is_none()
            && existing
                .as_ref()
                .is_some_and(|row| row.status != Status::Unfinished)
        {
            return Ok(None);
        }
        let summary = started
            .and_then(|e| Summary::of(&e.line))
            .unwrap_or_default();
        let row = self.row(
            stream,
            query,
            &summary,
            Status::Running,
            None,
            existing.as_ref(),
        );
        self.index.put_query(&row).await?;
        Ok(Some(row))
    }

    async fn finish(&self, stream: &Stream, query: &str, finished: &Event) -> Result<QuerySummary> {
        let existing = self.index.query(query).await?;
        let summary = Summary::of(&finished.line).unwrap_or_default();
        let status = if summary.failed.is_some() {
            Status::Failed
        } else {
            Status::Finished
        };
        let started = summary
            .started_unix_ns
            .or(existing.as_ref().map(|row| row.started_unix_ns))
            .unwrap_or_else(now_unix_ns);
        let earlier = existing.as_ref().and_then(|row| row.recording.as_ref());
        let recording = self.record(query, started, earlier).await?;
        let row = self.row(
            stream,
            query,
            &summary,
            status,
            recording,
            existing.as_ref(),
        );
        self.index.put_query(&row).await?;
        Ok(row)
    }

    async fn record(
        &self,
        query: &str,
        started_unix_ns: i64,
        earlier: Option<&RecordingKey>,
    ) -> Result<Option<RecordingKey>> {
        let Some(text) = self.log.take(query).await? else {
            return Ok(earlier.cloned());
        };
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        let before = match earlier {
            Some(key) => self.recordings.get(key).await?,
            None => None,
        };
        if let Some(before) = before {
            let mut kept = Vec::new();
            MultiGzDecoder::new(before.as_ref()).read_to_end(&mut kept)?;
            gzip.write_all(&kept)?;
            let process = text
                .iter()
                .position(|&b| b == b'\n')
                .map_or(text.len(), |at| at + 1);
            gzip.write_all(&text[process..])?;
        } else {
            gzip.write_all(&text)?;
        }
        let key = RecordingKey(format!("{}/{query}.jsonl.gz", date(started_unix_ns)));
        self.recordings
            .put(&key, Bytes::from(gzip.finish()?))
            .await?;
        if let Some(earlier) = earlier.filter(|earlier| **earlier != key) {
            self.recordings.delete(earlier).await?;
        }
        Ok(Some(key))
    }

    fn row(
        &self,
        stream: &Stream,
        query: &str,
        summary: &Summary,
        status: Status,
        recording: Option<RecordingKey>,
        before: Option<&QuerySummary>,
    ) -> QuerySummary {
        QuerySummary {
            query_id: query.to_owned(),
            stream_id: stream.id.clone(),
            project: self.project.clone(),
            service: stream.service.clone(),
            environment: stream.environment.clone(),
            host: stream.host.clone(),
            label: summary
                .label
                .clone()
                .or_else(|| before.and_then(|r| r.label.clone())),
            fingerprint: summary
                .fingerprint
                .clone()
                .or_else(|| before.and_then(|r| r.fingerprint.clone())),
            status,
            started_unix_ns: summary
                .started_unix_ns
                .or(before.map(|r| r.started_unix_ns))
                .unwrap_or_else(now_unix_ns),
            wall_ms: summary.wall_ms.or(before.and_then(|r| r.wall_ms)),
            cpu_ms: summary.cpu_ms.or(before.and_then(|r| r.cpu_ms)),
            result_rows: summary.result_rows.or(before.and_then(|r| r.result_rows)),
            failed: summary.failed.clone(),
            warnings: summary.warnings,
            rules: summary.rules.clone(),
            recording: recording.or_else(|| before.and_then(|r| r.recording.clone())),
        }
    }
}

fn now_unix_ns() -> i64 {
    i64::try_from(jiff::Timestamp::now().as_nanosecond()).unwrap_or(i64::MAX)
}

fn date(unix_ns: i64) -> String {
    jiff::Timestamp::from_nanosecond(i128::from(unix_ns))
        .unwrap_or(jiff::Timestamp::UNIX_EPOCH)
        .strftime("%Y/%m/%d")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recording_is_filed_under_the_utc_day_its_query_started() {
        assert_eq!(date(0), "1970/01/01");
        assert_eq!(date(1_709_164_800_000_000_000), "2024/02/29");
        assert_eq!(date(1_791_625_428_121_691_683), "2026/10/10");
    }
}
