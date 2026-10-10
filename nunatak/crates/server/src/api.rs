use crate::Pipeline;
use crate::ingest::problem;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use nunatak_store::{Filter, Grouping, Page, Status};
use serde::Deserialize;
use std::sync::Arc;

const MAX_LIMIT: u32 = 1000;

#[derive(Deserialize, Default)]
pub(crate) struct Params {
    label: Option<String>,
    fingerprint: Option<String>,
    service: Option<String>,
    environment: Option<String>,
    status: Option<String>,
    since: Option<i64>,
    until: Option<i64>,
    limit: Option<u32>,
    offset: Option<u32>,
    by: Option<String>,
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
    let page = Page {
        limit: params.limit.unwrap_or(100).min(MAX_LIMIT),
        offset: params.offset.unwrap_or(0),
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
    match pipeline.index().groups(&filter, by).await {
        Ok(groups) => Json(groups).into_response(),
        Err(error) => failed(&error),
    }
}

pub(crate) async fn unknown() -> Response {
    problem(StatusCode::NOT_FOUND, "no such API", None)
}

fn failed(error: &nunatak_store::Error) -> Response {
    tracing::error!(%error, "reading the index failed");
    problem(
        StatusCode::INTERNAL_SERVER_ERROR,
        "reading the index failed",
        None,
    )
}
