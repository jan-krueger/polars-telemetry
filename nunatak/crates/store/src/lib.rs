use async_trait::async_trait;
use bytes::Bytes;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("storage: {0}")]
    Io(#[from] std::io::Error),
    #[error("storage: {0}")]
    Backend(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
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
    async fn open(&self) -> Result<Vec<String>>;
}
