use async_trait::async_trait;
use bytes::Bytes;
use nunatak_store::{Error, Log, RecordingKey, Recordings, Result};
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;

pub struct FsRecordings {
    root: PathBuf,
}

impl FsRecordings {
    #[must_use]
    pub fn new(data: &Path) -> Self {
        Self {
            root: data.join("recordings"),
        }
    }

    fn path(&self, key: &RecordingKey) -> Result<PathBuf> {
        let relative = Path::new(&key.0);
        if relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        {
            Ok(self.root.join(relative))
        } else {
            Err(Error::Backend(format!("not a recording key: {}", key.0)))
        }
    }
}

#[async_trait]
impl Recordings for FsRecordings {
    async fn put(&self, key: &RecordingKey, gzip: Bytes) -> Result<()> {
        let path = self.path(key)?;
        if let Some(folder) = path.parent() {
            fs::create_dir_all(folder).await?;
        }
        let partial = path.with_extension("partial");
        fs::write(&partial, &gzip).await?;
        fs::rename(&partial, &path).await?;
        Ok(())
    }

    async fn get(&self, key: &RecordingKey) -> Result<Option<Bytes>> {
        match fs::read(self.path(key)?).await {
            Ok(bytes) => Ok(Some(Bytes::from(bytes))),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    async fn delete(&self, key: &RecordingKey) -> Result<()> {
        match fs::remove_file(self.path(key)?).await {
            Err(e) if e.kind() != ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

pub struct FsLog {
    root: PathBuf,
}

impl FsLog {
    #[must_use]
    pub fn new(data: &Path) -> Self {
        Self {
            root: data.join("live"),
        }
    }

    fn path(&self, query_id: &str) -> Result<PathBuf> {
        if !query_id.is_empty() && query_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            Ok(self.root.join(format!("{query_id}.jsonl")))
        } else {
            Err(Error::Backend(format!("not a query id: {query_id}")))
        }
    }
}

#[async_trait]
impl Log for FsLog {
    async fn append(&self, query_id: &str, process: &str, lines: &[&str]) -> Result<()> {
        let path = self.path(query_id)?;
        fs::create_dir_all(&self.root).await?;
        let new = !fs::try_exists(&path).await?;
        let mut text = String::new();
        for line in new
            .then_some(process)
            .into_iter()
            .chain(lines.iter().copied())
        {
            text.push_str(line);
            text.push('\n');
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        file.write_all(text.as_bytes()).await?;
        file.sync_data().await?;
        Ok(())
    }

    async fn read(&self, query_id: &str) -> Result<Option<Bytes>> {
        match fs::read(self.path(query_id)?).await {
            Ok(bytes) => Ok(Some(Bytes::from(bytes))),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    async fn take(&self, query_id: &str) -> Result<Option<Bytes>> {
        let path = self.path(query_id)?;
        let bytes = match fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        fs::remove_file(&path).await?;
        Ok(Some(Bytes::from(bytes)))
    }

    async fn open(&self) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        let mut entries = match fs::read_dir(&self.root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(ids),
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = entries.next_entry().await? {
            if let Some(id) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(".jsonl"))
            {
                ids.push(id.to_owned());
            }
        }
        ids.sort();
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUERY: &str = "01a12532-7bcd-7082-8a3f-bd94907497ea";

    #[tokio::test]
    async fn a_recording_reads_back_as_written() {
        let data = tempfile::tempdir().unwrap();
        let recordings = FsRecordings::new(data.path());
        let key = RecordingKey(format!("2026/10/10/{QUERY}.jsonl.gz"));
        assert!(recordings.get(&key).await.unwrap().is_none());
        recordings
            .put(&key, Bytes::from_static(b"gz"))
            .await
            .unwrap();
        assert_eq!(
            recordings.get(&key).await.unwrap().unwrap(),
            Bytes::from_static(b"gz")
        );
        recordings.delete(&key).await.unwrap();
        recordings.delete(&key).await.unwrap();
        assert!(recordings.get(&key).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_key_cannot_leave_the_recordings_folder() {
        let data = tempfile::tempdir().unwrap();
        let recordings = FsRecordings::new(data.path());
        let escape = RecordingKey("../outside.gz".into());
        assert!(recordings.put(&escape, Bytes::new()).await.is_err());
    }

    #[tokio::test]
    async fn a_log_opens_with_its_process_line_once_and_is_taken_whole() {
        let data = tempfile::tempdir().unwrap();
        let log = FsLog::new(data.path());
        log.append(QUERY, "process", &["a", "b"]).await.unwrap();
        log.append(QUERY, "process", &["c"]).await.unwrap();
        assert_eq!(log.open().await.unwrap(), vec![QUERY.to_owned()]);
        assert_eq!(
            &log.read(QUERY).await.unwrap().unwrap()[..],
            b"process\na\nb\nc\n"
        );
        let text = log.take(QUERY).await.unwrap().unwrap();
        assert_eq!(&text[..], b"process\na\nb\nc\n");
        assert!(log.take(QUERY).await.unwrap().is_none());
        assert_eq!(log.open().await.unwrap(), [] as [std::string::String; 0]);
    }

    #[tokio::test]
    async fn a_log_refuses_a_name_that_is_not_a_query_id() {
        let data = tempfile::tempdir().unwrap();
        assert!(
            FsLog::new(data.path())
                .append("../x", "p", &[])
                .await
                .is_err()
        );
    }
}
