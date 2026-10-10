mod api;
mod ingest;
mod pipeline;

pub use pipeline::{Accepted, Imported, Pipeline};

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::response::Html;
use axum::routing::{get, post};
use std::sync::Arc;
use tower::ServiceBuilder;
use tower_http::decompression::RequestDecompressionLayer;
use tower_http::limit::RequestBodyLimitLayer;

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
    let state = Arc::new(ingest::Ingest { pipeline, token });
    let events = post(ingest::events).layer(
        ServiceBuilder::new()
            .layer(RequestBodyLimitLayer::new(limits.body))
            .layer(RequestDecompressionLayer::new().gzip(true))
            .layer(DefaultBodyLimit::max(limits.decoded)),
    );
    Router::new()
        .route("/v1/events", events)
        .route("/v1/health", get(ingest::health))
        .with_state(state)
}

const PAGE: &str = include_str!(concat!(env!("OUT_DIR"), "/page.html"));

pub fn app_router(pipeline: Arc<Pipeline>) -> Router {
    Router::new()
        .route("/api/queries", get(api::queries))
        .route("/api/queries/{id}", get(api::query))
        .route("/api/queries/{id}/recording", get(api::recording))
        .route("/api/groups", get(api::groups))
        .route("/api/facets", get(api::facets))
        .route("/api/{*rest}", get(api::unknown))
        .fallback(get(|| async { Html(PAGE) }))
        .with_state(pipeline)
}
