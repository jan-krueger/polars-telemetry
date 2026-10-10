mod ingest;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use nunatak_store::{Log, Recordings};
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

pub struct Server {
    pub token: String,
    pub limits: Limits,
    pub log: Arc<dyn Log>,
    pub recordings: Arc<dyn Recordings>,
}

pub fn router(server: Server) -> Router {
    let limit = server.limits.body;
    let state = Arc::new(ingest::Ingest::new(server));
    Router::new()
        .route(
            "/v1/events",
            post(ingest::events).layer(DefaultBodyLimit::max(limit)),
        )
        .route("/v1/health", get(ingest::health))
        .with_state(state)
}
