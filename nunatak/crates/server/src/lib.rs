mod api;
mod ingest;
mod pipeline;

pub use pipeline::{Accepted, Imported, Pipeline};

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use std::sync::Arc;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub body: usize,
    pub decoded: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            body: 8 * 1024 * 1024,
            decoded: 64 * 1024 * 1024,
        }
    }
}

pub fn ingest_router(pipeline: Arc<Pipeline>, token: String, limits: Limits) -> Router {
    let state = Arc::new(ingest::Ingest {
        pipeline,
        token,
        limits,
    });
    Router::new()
        .route(
            "/v1/events",
            post(ingest::events).layer(DefaultBodyLimit::max(limits.body)),
        )
        .route("/v1/health", get(ingest::health))
        .with_state(state)
}

pub fn app_router(pipeline: Arc<Pipeline>) -> Router {
    Router::new()
        .route("/api/queries", get(api::queries))
        .route("/api/queries/{id}", get(api::query))
        .route("/api/queries/{id}/recording", get(api::recording))
        .route("/api/groups", get(api::groups))
        .with_state(pipeline)
}
