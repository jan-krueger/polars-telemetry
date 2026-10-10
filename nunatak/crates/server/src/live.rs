use nunatak_store::QuerySummary;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};
use tokio::sync::broadcast;

const BACKLOG: usize = 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pulse {
    pub query_id: String,
    pub elapsed_ms: f64,
    pub threads: Vec<f64>,
    pub busiest: Option<Busiest>,
    pub done: usize,
    pub nodes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Busiest {
    pub id: u64,
    pub kind: String,
    pub threads: f64,
}

#[derive(Debug, Clone)]
pub enum Change {
    Query(Box<QuerySummary>),
    Pulse(Pulse),
    Events {
        query_id: String,
        lines: Vec<(u64, String)>,
    },
}

#[derive(Default)]
struct Running {
    kinds: HashMap<u64, String>,
    totals: HashMap<u64, u64>,
    done: HashSet<u64>,
    elapsed_ms: f64,
    threads: Vec<f64>,
    busiest: Option<Busiest>,
}

pub struct Live {
    sender: broadcast::Sender<Arc<Change>>,
    running: Mutex<HashMap<String, Running>>,
}

impl Default for Live {
    fn default() -> Self {
        Self {
            sender: broadcast::channel(BACKLOG).0,
            running: Mutex::new(HashMap::new()),
        }
    }
}

impl Live {
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Change>> {
        self.sender.subscribe()
    }

    pub fn pulses(&self) -> Vec<Pulse> {
        let running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
        running.iter().map(|(id, state)| pulse(id, state)).collect()
    }

    pub(crate) fn publish(&self, change: Change) {
        let _ = self.sender.send(Arc::new(change));
    }

    pub(crate) fn started(&self, query_id: &str, line: &str) {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let kinds = event["profile"]["plan"]["physical"]
            .as_array()
            .map(|nodes| {
                nodes
                    .iter()
                    .filter_map(|node| {
                        Some((node["id"].as_u64()?, node["kind"].as_str()?.to_owned()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
        running.entry(query_id.to_owned()).or_default().kinds = kinds;
    }

    pub(crate) fn progress(&self, query_id: &str, line: &str) -> Option<Pulse> {
        let event = serde_json::from_str::<Value>(line).ok()?;
        let elapsed_ms = event["elapsed_ms"].as_f64()?;
        let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
        let state = running.entry(query_id.to_owned()).or_default();
        let interval = elapsed_ms - state.elapsed_ms;
        let mut spent = 0u64;
        let mut busiest: Option<(u64, u64)> = None;
        for (id, counters) in event["nodes"].as_object()? {
            let Ok(id) = id.parse::<u64>() else { continue };
            if counters["done"].as_bool() == Some(true) {
                state.done.insert(id);
            }
            let Some(total) = counters["total_time_ns"].as_u64() else {
                continue;
            };
            let before = state.totals.insert(id, total).unwrap_or(0);
            let delta = total.saturating_sub(before);
            spent += delta;
            if busiest.is_none_or(|(_, most)| delta > most) {
                busiest = Some((id, delta));
            }
        }
        if interval > 0.0 {
            state.threads.push(threads(spent, interval));
            state.busiest = busiest
                .filter(|(_, delta)| *delta > 0)
                .map(|(id, delta)| Busiest {
                    id,
                    kind: state.kinds.get(&id).cloned().unwrap_or_default(),
                    threads: threads(delta, interval),
                });
            state.elapsed_ms = elapsed_ms;
        }
        Some(pulse(query_id, state))
    }

    pub(crate) fn finished(&self, query_id: &str) {
        let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
        running.remove(query_id);
    }
}

#[allow(clippy::cast_precision_loss)]
fn threads(nanoseconds: u64, interval_ms: f64) -> f64 {
    nanoseconds as f64 / 1e6 / interval_ms
}

fn pulse(query_id: &str, state: &Running) -> Pulse {
    Pulse {
        query_id: query_id.to_owned(),
        elapsed_ms: state.elapsed_ms,
        threads: state.threads.clone(),
        busiest: state.busiest.clone(),
        done: state.done.len(),
        nodes: state.kinds.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUERY: &str = "01a12532-7bcd-7082-8a3f-bd94907497ea";

    #[test]
    fn a_pulse_follows_threads_busy_the_busiest_node_and_nodes_done() {
        let live = Live::default();
        live.started(
            QUERY,
            r#"{"profile":{"plan":{"physical":[{"id":1,"kind":"MultiScan"},{"id":2,"kind":"GroupBy"}]}}}"#,
        );
        let first = live
            .progress(QUERY, r#"{"elapsed_ms":1000,"nodes":{"1":{"total_time_ns":4000000000},"2":{"total_time_ns":1000000000}}}"#)
            .unwrap();
        assert_eq!(first.threads, [5.0]);
        assert_eq!(
            first
                .busiest
                .as_ref()
                .map(|b| (b.id, b.kind.as_str(), b.threads)),
            Some((1, "MultiScan", 4.0))
        );
        assert_eq!((first.done, first.nodes), (0, 2));
        let second = live
            .progress(QUERY, r#"{"elapsed_ms":2000,"nodes":{"1":{"total_time_ns":5000000000,"done":true},"2":{"total_time_ns":4000000000}}}"#)
            .unwrap();
        assert_eq!(second.threads, [5.0, 4.0]);
        assert_eq!(
            second.busiest.map(|b| (b.kind, b.threads)),
            Some(("GroupBy".into(), 3.0))
        );
        assert_eq!(second.done, 1);
        assert_eq!(live.pulses().len(), 1);
        live.finished(QUERY);
        assert_eq!(live.pulses(), []);
    }
}
