use async_trait::async_trait;
use nunatak_store::{
    Count, Error, Facets, Filter, GroupRun, GroupSummary, Grouping, Index, Page, QuerySummary,
    RecordingKey, Result, Seen, Status, summarize,
};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use rusqlite_migration::{M, Migrations, SchemaVersion};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

const MIGRATIONS: &[&str] = &["
CREATE TABLE queries (
    query_id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    project TEXT NOT NULL,
    service TEXT,
    environment TEXT,
    host TEXT NOT NULL,
    label TEXT,
    fingerprint TEXT,
    status TEXT NOT NULL,
    started_unix_ns INTEGER NOT NULL,
    wall_ms REAL,
    cpu_ms REAL,
    result_rows INTEGER,
    failed TEXT,
    warnings INTEGER NOT NULL,
    recording TEXT
);
CREATE INDEX queries_by_start ON queries (project, started_unix_ns DESC);
CREATE INDEX queries_by_label ON queries (project, label, started_unix_ns DESC);
CREATE INDEX queries_by_shape ON queries (project, fingerprint, started_unix_ns DESC);
CREATE TABLE seen (
    stream_id TEXT PRIMARY KEY,
    through INTEGER NOT NULL,
    above TEXT NOT NULL
);
"];

const COLUMNS: &str = "query_id, stream_id, project, service, environment, host, label, fingerprint, \
    status, started_unix_ns, wall_ms, cpu_ms, result_rows, failed, warnings, recording";

#[derive(Clone)]
pub struct SqliteIndex {
    connection: Arc<Mutex<Connection>>,
}

impl SqliteIndex {
    pub fn open(path: &Path) -> Result<Self> {
        let mut connection = Connection::open(path).map_err(backend)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(backend)?;
        migrate(&mut connection, Some(path), MIGRATIONS)?;
        Ok(Self::with(connection))
    }

    pub fn in_memory() -> Result<Self> {
        let mut connection = Connection::open_in_memory().map_err(backend)?;
        migrate(&mut connection, None, MIGRATIONS)?;
        Ok(Self::with(connection))
    }

    fn with(connection: Connection) -> Self {
        Self {
            connection: Arc::new(Mutex::new(connection)),
        }
    }

    async fn run<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let connection = Arc::clone(&self.connection);
        tokio::task::spawn_blocking(move || {
            let connection = connection
                .lock()
                .map_err(|_| Error::Backend("index lock poisoned".into()))?;
            work(&connection).map_err(backend)
        })
        .await
        .map_err(|e| Error::Backend(e.to_string()))?
    }
}

fn migrate(connection: &mut Connection, path: Option<&Path>, steps: &[&str]) -> Result<()> {
    connection
        .pragma_update(None, "busy_timeout", 5_000)
        .map_err(backend)?;
    let migrations = Migrations::new(steps.iter().map(|step| M::up(step)).collect());
    let known = steps.len();
    match migrations.current_version(connection).map_err(backend)? {
        SchemaVersion::Outside(current) => {
            let name = path.map_or_else(|| "the index".into(), |p| p.display().to_string());
            return Err(Error::Backend(format!(
                "{name} is schema {current}; this nunatak knows schemas up to {known}. Use a newer nunatak."
            )));
        }
        SchemaVersion::Inside(current) if usize::from(current) < known => {
            if let Some(path) = path {
                let backup = path.with_extension(format!("db.v{current}.bak"));
                let _ = std::fs::remove_file(&backup);
                connection
                    .execute("VACUUM INTO ?1", [backup.to_string_lossy()])
                    .map_err(backend)?;
            }
        }
        _ => {}
    }
    migrations.to_latest(connection).map_err(backend)
}

fn count(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn backend(error: impl std::fmt::Display) -> Error {
    Error::Backend(error.to_string())
}

fn summary(row: &Row<'_>) -> rusqlite::Result<QuerySummary> {
    let status: String = row.get(8)?;
    Ok(QuerySummary {
        query_id: row.get(0)?,
        stream_id: row.get(1)?,
        project: row.get(2)?,
        service: row.get(3)?,
        environment: row.get(4)?,
        host: row.get(5)?,
        label: row.get(6)?,
        fingerprint: row.get(7)?,
        status: Status::parse(&status).unwrap_or(Status::Unfinished),
        started_unix_ns: row.get(9)?,
        wall_ms: row.get(10)?,
        cpu_ms: row.get(11)?,
        result_rows: row.get(12)?,
        failed: row.get(13)?,
        warnings: row.get(14)?,
        recording: row.get::<_, Option<String>>(15)?.map(RecordingKey),
    })
}

fn conditions(filter: &Filter) -> (String, Vec<Value>) {
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    let text = [
        ("project", &filter.project),
        ("label", &filter.label),
        ("fingerprint", &filter.fingerprint),
        ("service", &filter.service),
        ("environment", &filter.environment),
        ("host", &filter.host),
    ];
    for (column, value) in text {
        if let Some(value) = value {
            clauses.push(format!("{column} = ?"));
            values.push(Value::Text(value.clone()));
        }
    }
    if let Some(status) = filter.status {
        clauses.push("status = ?".into());
        values.push(Value::Text(status.as_str().into()));
    }
    if let Some(since) = filter.since_unix_ns {
        clauses.push("started_unix_ns >= ?".into());
        values.push(Value::Integer(since));
    }
    if let Some(until) = filter.until_unix_ns {
        clauses.push("started_unix_ns <= ?".into());
        values.push(Value::Integer(until));
    }
    let clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    (clause, values)
}

#[async_trait]
impl Index for SqliteIndex {
    async fn put_query(&self, query: &QuerySummary) -> Result<()> {
        let q = query.clone();
        self.run(move |c| {
            c.execute(
                &format!("INSERT OR REPLACE INTO queries ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"),
                params![
                    q.query_id, q.stream_id, q.project, q.service, q.environment, q.host, q.label,
                    q.fingerprint, q.status.as_str(), q.started_unix_ns, q.wall_ms, q.cpu_ms,
                    q.result_rows, q.failed, q.warnings, q.recording.map(|k| k.0),
                ],
            )
            .map(|_| ())
        })
        .await
    }

    async fn query(&self, query_id: &str) -> Result<Option<QuerySummary>> {
        let id = query_id.to_owned();
        self.run(move |c| {
            c.query_row(
                &format!("SELECT {COLUMNS} FROM queries WHERE query_id = ?1"),
                [id],
                summary,
            )
            .optional()
        })
        .await
    }

    async fn list(&self, filter: &Filter, page: Page) -> Result<Vec<QuerySummary>> {
        let (clause, mut values) = conditions(filter);
        values.push(Value::Integer(i64::from(page.limit)));
        values.push(Value::Integer(i64::from(page.offset)));
        self.run(move |c| {
            let sql = format!(
                "SELECT {COLUMNS} FROM queries {clause} ORDER BY started_unix_ns DESC, query_id LIMIT ? OFFSET ?"
            );
            c.prepare(&sql)?.query_map(params_from_iter(values), summary)?.collect()
        })
        .await
    }

    async fn groups(&self, filter: &Filter, by: Grouping) -> Result<Vec<GroupSummary>> {
        let column = match by {
            Grouping::Label => "label",
            Grouping::Fingerprint => "fingerprint",
        };
        let (clause, values) = conditions(filter);
        let rows = self
            .run(move |c| {
                let sql = format!(
                    "SELECT {column}, status, started_unix_ns, wall_ms, fingerprint, warnings FROM queries {clause}"
                );
                c.prepare(&sql)?
                    .query_map(params_from_iter(values), |row| {
                        let status: String = row.get(1)?;
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            GroupRun {
                                status: Status::parse(&status).unwrap_or(Status::Unfinished),
                                started_unix_ns: row.get(2)?,
                                wall_ms: row.get(3)?,
                                fingerprint: row.get(4)?,
                                warnings: row.get(5)?,
                            },
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .await?;
        let mut by_key: BTreeMap<Option<String>, Vec<GroupRun>> = BTreeMap::new();
        for (key, run) in rows {
            by_key.entry(key).or_default().push(run);
        }
        let mut groups: Vec<GroupSummary> = by_key
            .into_iter()
            .map(|(key, runs)| summarize(key, &runs))
            .collect();
        groups.sort_by_key(|group| std::cmp::Reverse(group.last_started_unix_ns));
        Ok(groups)
    }

    async fn facets(&self, filter: &Filter) -> Result<Facets> {
        let (clause, values) = conditions(filter);
        self.run(move |c| {
            let by = |column: &str| -> rusqlite::Result<Vec<Count>> {
                let sql = format!(
                    "SELECT {column}, COUNT(*) FROM queries {clause} GROUP BY {column} ORDER BY COUNT(*) DESC, {column}"
                );
                c.prepare(&sql)?
                    .query_map(params_from_iter(values.iter()), |row| {
                        Ok(Count {
                            value: row.get(0)?,
                            runs: count(row.get(1)?),
                        })
                    })?
                    .collect()
            };
            Ok(Facets {
                service: by("service")?,
                environment: by("environment")?,
                host: by("host")?,
                status: by("status")?,
            })
        })
        .await
    }

    async fn seen(&self, stream_id: &str) -> Result<Seen> {
        let id = stream_id.to_owned();
        self.run(move |c| {
            let row: Option<(i64, String)> = c
                .query_row(
                    "SELECT through, above FROM seen WHERE stream_id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            Ok(row.map_or_else(Seen::default, |(through, above)| Seen {
                through: count(through),
                above: above.split(',').filter_map(|n| n.parse().ok()).collect(),
            }))
        })
        .await
    }

    async fn set_seen(&self, stream_id: &str, seen: &Seen) -> Result<()> {
        let id = stream_id.to_owned();
        let through = i64::try_from(seen.through).unwrap_or(i64::MAX);
        let above = seen
            .above
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        self.run(move |c| {
            c.execute(
                "INSERT OR REPLACE INTO seen (stream_id, through, above) VALUES (?1, ?2, ?3)",
                params![id, through, above],
            )
            .map(|_| ())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    nunatak_store::conformance!(SqliteIndex::in_memory().unwrap());

    fn version(path: &Path) -> i64 {
        Connection::open(path)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn the_migrations_are_valid() {
        let migrations = Migrations::new(MIGRATIONS.iter().map(|step| M::up(step)).collect());
        migrations.validate().unwrap();
    }

    #[test]
    fn a_new_index_starts_at_the_latest_schema() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("index.db");
        SqliteIndex::open(&path).unwrap();
        assert_eq!(version(&path), i64::try_from(MIGRATIONS.len()).unwrap());
    }

    #[tokio::test]
    async fn an_older_index_is_backed_up_then_migrated_keeping_its_rows() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("index.db");
        let written = nunatak_store::conformance::query(7, "nightly", 5);
        SqliteIndex::open(&path)
            .unwrap()
            .put_query(&written)
            .await
            .unwrap();
        let next = [MIGRATIONS[0], "ALTER TABLE queries ADD COLUMN note TEXT;"];
        let mut connection = Connection::open(&path).unwrap();
        migrate(&mut connection, Some(&path), &next).unwrap();
        drop(connection);
        assert_eq!(version(&path), 2);
        assert_eq!(version(&folder.path().join("index.db.v1.bak")), 1);
        let reopened = SqliteIndex::with(Connection::open(&path).unwrap());
        assert_eq!(
            reopened.query(&written.query_id).await.unwrap(),
            Some(written)
        );
    }

    #[test]
    fn an_index_newer_than_this_nunatak_is_refused() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("index.db");
        SqliteIndex::open(&path).unwrap();
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", 99)
            .unwrap();
        let Err(error) = SqliteIndex::open(&path) else {
            panic!("a newer schema must be refused");
        };
        assert!(error.to_string().contains("is schema 99"));
    }

    #[test]
    fn a_failed_migration_leaves_the_index_as_it_was() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("index.db");
        SqliteIndex::open(&path).unwrap();
        let broken = [
            MIGRATIONS[0],
            "ALTER TABLE queries ADD COLUMN a TEXT; NOT SQL;",
        ];
        let mut connection = Connection::open(&path).unwrap();
        assert!(migrate(&mut connection, Some(&path), &broken).is_err());
        assert_eq!(version(&path), 1);
    }

    #[tokio::test]
    async fn an_index_on_disk_keeps_its_queries() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("index.db");
        let written = nunatak_store::conformance::query(7, "nightly", 5);
        SqliteIndex::open(&path)
            .unwrap()
            .put_query(&written)
            .await
            .unwrap();
        let reopened = SqliteIndex::open(&path).unwrap();
        assert_eq!(
            reopened.query(&written.query_id).await.unwrap(),
            Some(written)
        );
    }
}
