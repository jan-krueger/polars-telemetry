use crate::Pipeline;
use crate::ingest::problem;
use crate::live::Change;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::stream::{self, Stream, StreamExt};
use nunatak_store::{Filter, Page, Status};
use serde_json::json;
use std::convert::Infallible;
use std::sync::Arc;

type Events = std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;

fn event(name: &str, data: &impl serde::Serialize) -> Event {
    Event::default()
        .event(name)
        .json_data(data)
        .unwrap_or_else(|_| Event::default().event(name))
}

pub(crate) async fn running(State(pipeline): State<Arc<Pipeline>>) -> Response {
    let receiver = pipeline.live().subscribe();
    let filter = Filter {
        project: Some(pipeline.project().to_owned()),
        status: Some(Status::Running),
        ..Filter::default()
    };
    let page = Page {
        limit: 1000,
        offset: 0,
    };
    let queries = match pipeline.index().list(&filter, page).await {
        Ok(queries) => queries,
        Err(error) => {
            tracing::error!(%error, "reading running queries failed");
            return problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "reading the index failed",
                None,
            );
        }
    };
    let snapshot = event(
        "snapshot",
        &json!({ "running": queries, "pulses": pipeline.live().pulses() }),
    );
    let project = pipeline.project().to_owned();
    let changes = stream::unfold(receiver, move |mut receiver| {
        let project = project.clone();
        async move {
            loop {
                let change = receiver.recv().await.ok()?;
                let next = match change.as_ref() {
                    Change::Query(row) if row.project == project => {
                        Ok::<Event, Infallible>(event("query", row))
                    }
                    Change::Pulse(pulse) => Ok::<Event, Infallible>(event("pulse", pulse)),
                    _ => continue,
                };
                return Some((next, receiver));
            }
        }
    });
    let events: Events =
        Box::pin(stream::once(async move { Ok::<Event, Infallible>(snapshot) }).chain(changes));
    Sse::new(events)
        .keep_alive(KeepAlive::default())
        .into_response()
}

pub(crate) async fn query(
    State(pipeline): State<Arc<Pipeline>>,
    Path(id): Path<String>,
) -> Response {
    let receiver = pipeline.live().subscribe();
    let row = match pipeline.index().query(&id).await {
        Ok(Some(row)) if row.project == pipeline.project() => row,
        Ok(_) => return problem(StatusCode::NOT_FOUND, "no such query", None),
        Err(error) => {
            tracing::error!(%error, "reading a query failed");
            return problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "reading the index failed",
                None,
            );
        }
    };
    if row.status != Status::Running {
        let done: Events = Box::pin(stream::once(async move {
            Ok::<Event, Infallible>(event("finished", &row))
        }));
        return Sse::new(done).into_response();
    }
    let so_far = match pipeline.log().read(&id).await {
        Ok(text) => text
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default(),
        Err(error) => {
            tracing::error!(%error, "reading a running query failed");
            return problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "reading the log failed",
                None,
            );
        }
    };
    let latest = nunatak_protocol::parse(&so_far)
        .ok()
        .and_then(|batch| batch.events.iter().map(|e| e.seq).max())
        .unwrap_or(0);
    let first: Result<Event, Infallible> =
        Ok(Event::default().event("events").data(so_far.trim_end()));
    let changes = stream::unfold(Some(receiver), move |receiver| {
        let id = id.clone();
        async move {
            let mut receiver = receiver?;
            loop {
                let change = receiver.recv().await.ok()?;
                match change.as_ref() {
                    Change::Events { query_id, lines } if *query_id == id => {
                        let fresh: Vec<&str> = lines
                            .iter()
                            .filter(|(seq, _)| *seq > latest)
                            .map(|(_, line)| line.as_str())
                            .collect();
                        if !fresh.is_empty() {
                            let next = Ok(Event::default().event("events").data(fresh.join("\n")));
                            return Some((next, Some(receiver)));
                        }
                    }
                    Change::Query(row) if row.query_id == id && row.status != Status::Running => {
                        return Some((Ok::<Event, Infallible>(event("finished", row)), None));
                    }
                    _ => {}
                }
            }
        }
    });
    let events: Events = Box::pin(stream::once(async move { first }).chain(changes));
    Sse::new(events)
        .keep_alive(KeepAlive::default())
        .into_response()
}
