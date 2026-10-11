use crate::Pipeline;
use crate::ingest::problem;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use nunatak_store::overview::{self, Window};
use nunatak_store::{Facets, Filter, Grouping, Index, Page, Status};
use serde::Deserialize;
use std::sync::Arc;

const MAX_LIMIT: u32 = 1000;
const MAX_DAYS: u32 = 90;
const BINS_PER_DAY: usize = 4;

#[derive(Deserialize, Default)]
pub(crate) struct Params {
    label: Option<String>,
    fingerprint: Option<String>,
    service: Option<String>,
    environment: Option<String>,
    host: Option<String>,
    status: Option<String>,
    since: Option<i64>,
    until: Option<i64>,
    limit: Option<u32>,
    offset: Option<u32>,
    by: Option<String>,
    days: Option<u32>,
    utc_offset: Option<i32>,
    order: Option<String>,
}

impl Params {
    fn filter(&self, project: &str) -> Result<Filter, String> {
        let status = match self.status.as_deref() {
            None => None,
            Some(text) => {
                Some(Status::parse(text).ok_or_else(|| format!("unknown status {text}"))?)
            }
        };
        Ok(Filter {
            project: Some(project.to_owned()),
            label: self.label.clone(),
            fingerprint: self.fingerprint.clone(),
            service: self.service.clone(),
            environment: self.environment.clone(),
            host: self.host.clone(),
            status,
            since_unix_ns: self.since,
            until_unix_ns: self.until,
        })
    }
}

pub(crate) async fn queries(
    State(pipeline): State<Arc<Pipeline>>,
    Query(params): Query<Params>,
) -> Response {
    let filter = match params.filter(pipeline.project()) {
        Ok(filter) => filter,
        Err(reason) => return problem(StatusCode::BAD_REQUEST, &reason, None),
    };
    let oldest_first = match params.order.as_deref() {
        None | Some("newest") => false,
        Some("oldest") => true,
        Some(other) => {
            return problem(
                StatusCode::BAD_REQUEST,
                &format!("cannot order by {other}"),
                None,
            );
        }
    };
    let page = Page {
        limit: params.limit.unwrap_or(100).min(MAX_LIMIT),
        offset: params.offset.unwrap_or(0),
        oldest_first,
    };
    match pipeline.index().list(&filter, page).await {
        Ok(list) => Json(list).into_response(),
        Err(error) => failed(&error),
    }
}

pub(crate) async fn query(
    State(pipeline): State<Arc<Pipeline>>,
    Path(id): Path<String>,
) -> Response {
    match pipeline.index().query(&id).await {
        Ok(Some(row)) if row.project == pipeline.project() => Json(row).into_response(),
        Ok(_) => problem(StatusCode::NOT_FOUND, "no such query", None),
        Err(error) => failed(&error),
    }
}

pub(crate) async fn recording(
    State(pipeline): State<Arc<Pipeline>>,
    Path(id): Path<String>,
) -> Response {
    let key = match pipeline.index().query(&id).await {
        Ok(Some(row)) if row.project == pipeline.project() => row.recording,
        Ok(_) => None,
        Err(error) => return failed(&error),
    };
    let Some(key) = key else {
        return problem(
            StatusCode::NOT_FOUND,
            "no recording for this query yet",
            None,
        );
    };
    match pipeline.recordings().get(&key).await {
        Ok(Some(bytes)) => (
            [
                (header::CONTENT_TYPE, "application/x-ndjson"),
                (header::CONTENT_ENCODING, "gzip"),
            ],
            bytes,
        )
            .into_response(),
        Ok(None) => problem(StatusCode::NOT_FOUND, "the recording is missing", None),
        Err(error) => failed(&error),
    }
}

pub(crate) async fn groups(
    State(pipeline): State<Arc<Pipeline>>,
    Query(params): Query<Params>,
) -> Response {
    let by = match params.by.as_deref().unwrap_or("label") {
        "label" => Grouping::Label,
        "fingerprint" => Grouping::Fingerprint,
        other => {
            return problem(
                StatusCode::BAD_REQUEST,
                &format!("cannot group by {other}"),
                None,
            );
        }
    };
    let filter = match params.filter(pipeline.project()) {
        Ok(filter) => filter,
        Err(reason) => return problem(StatusCode::BAD_REQUEST, &reason, None),
    };
    match pipeline.index().runs(&filter).await {
        Ok(runs) => Json(nunatak_store::groups(&runs, by)).into_response(),
        Err(error) => failed(&error),
    }
}

pub(crate) async fn overview(
    State(pipeline): State<Arc<Pipeline>>,
    Query(params): Query<Params>,
) -> Response {
    let days = params.days.unwrap_or(14).clamp(1, MAX_DAYS);
    let window = Window::local(
        now_unix_ns(),
        days,
        params.utc_offset.unwrap_or(0).clamp(-14 * 60, 14 * 60),
        days as usize * BINS_PER_DAY,
    );
    let filter = match params.filter(pipeline.project()) {
        Ok(filter) => Filter {
            since_unix_ns: Some(window.reads_since_unix_ns()),
            until_unix_ns: None,
            status: None,
            ..filter
        },
        Err(reason) => return problem(StatusCode::BAD_REQUEST, &reason, None),
    };
    match pipeline.index().runs(&filter).await {
        Ok(runs) => Json(serde_json::json!({
            "now_unix_ns": window.now_unix_ns,
            "since_unix_ns": window.since_unix_ns,
            "days": window.days,
            "queries": overview::overview(&runs, &window),
        }))
        .into_response(),
        Err(error) => failed(&error),
    }
}

pub(crate) async fn versions(
    State(pipeline): State<Arc<Pipeline>>,
    Query(params): Query<Params>,
) -> Response {
    if params.label.is_none() {
        return problem(StatusCode::BAD_REQUEST, "versions need a label", None);
    }
    let filter = match params.filter(pipeline.project()) {
        Ok(filter) => filter,
        Err(reason) => return problem(StatusCode::BAD_REQUEST, &reason, None),
    };
    match pipeline.index().runs(&filter).await {
        Ok(runs) => Json(overview::versions(&runs)).into_response(),
        Err(error) => failed(&error),
    }
}

fn now_unix_ns() -> i64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    i64::try_from(now.as_nanos()).unwrap_or(i64::MAX)
}

pub(crate) async fn unknown() -> Response {
    problem(StatusCode::NOT_FOUND, "no such API", None)
}

pub(crate) async fn facets(
    State(pipeline): State<Arc<Pipeline>>,
    Query(params): Query<Params>,
) -> Response {
    let filter = match params.filter(pipeline.project()) {
        Ok(filter) => filter,
        Err(reason) => return problem(StatusCode::BAD_REQUEST, &reason, None),
    };
    match facets_for(pipeline.index(), &filter).await {
        Ok(facets) => Json(facets).into_response(),
        Err(error) => failed(&error),
    }
}

async fn facets_for(index: &dyn Index, filter: &Filter) -> nunatak_store::Result<Facets> {
    let everything = Filter {
        project: filter.project.clone(),
        label: filter.label.clone(),
        since_unix_ns: filter.since_unix_ns,
        until_unix_ns: filter.until_unix_ns,
        ..Filter::default()
    };
    let combinations = index.combinations(&everything).await?;
    Ok(Facets::of(&combinations, filter))
}

fn failed(error: &nunatak_store::Error) -> Response {
    tracing::error!(%error, "reading the index failed");
    problem(
        StatusCode::INTERNAL_SERVER_ERROR,
        "reading the index failed",
        None,
    )
}
