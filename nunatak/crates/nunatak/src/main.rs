use clap::{Parser, Subcommand};
use flate2::read::MultiGzDecoder;
use nunatak_server::{Limits, Pipeline, app_router, ingest_router};
use nunatak_store_fs::{FsLog, FsRecordings};
use nunatak_store_sqlite::SqliteIndex;
use std::fmt::Write as _;
use std::io::Read;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const QUIET: Duration = Duration::from_mins(1);
const SWEEP: Duration = Duration::from_secs(10);

#[derive(Parser)]
#[command(version, about)]
struct Args {
    /// Address to listen on. Only this machine can connect by default.
    #[arg(long, env = "NUNATAK_BIND", default_value = "127.0.0.1:7766")]
    bind: SocketAddr,

    /// Address for receiving events only, when they should arrive elsewhere than the dashboard.
    #[arg(long, env = "NUNATAK_INGEST_BIND")]
    ingest_bind: Option<SocketAddr>,

    /// Folder for the index, recordings and running queries.
    #[arg(
        long,
        env = "NUNATAK_DATA",
        default_value = "nunatak-data",
        global = true
    )]
    data: PathBuf,

    /// Token exporters must send. Without one, Nunatak creates one in the data folder.
    #[arg(long, env = "NUNATAK_TOKEN", hide_env_values = true)]
    token: Option<String>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Add recordings written by `FileEventExporter`, compressed or not.
    Import {
        #[arg(required = true)]
        files: Vec<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("NUNATAK_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let args = Args::parse();
    let outcome = match &args.command {
        Some(Command::Import { files }) => import(&args.data, files).await,
        None => serve(args).await,
    };
    match outcome {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn pipeline(data: &Path) -> std::io::Result<Arc<Pipeline>> {
    std::fs::create_dir_all(data)?;
    let index = SqliteIndex::open(&data.join("index.db")).map_err(std::io::Error::other)?;
    Ok(Arc::new(Pipeline::new(
        "default",
        Arc::new(FsLog::new(data)),
        Arc::new(FsRecordings::new(data)),
        Arc::new(index),
    )))
}

async fn serve(args: Args) -> std::io::Result<()> {
    let pipeline = pipeline(&args.data)?;
    let token = match args.token {
        Some(token) if !token.is_empty() => token,
        _ => stored_token(&args.data, args.ingest_bind.unwrap_or(args.bind))?,
    };
    tokio::spawn(close_silent(Arc::clone(&pipeline)));
    let ingest = ingest_router(Arc::clone(&pipeline), token, Limits::default());
    let app = app_router(pipeline);
    let main = tokio::net::TcpListener::bind(args.bind).await?;
    tracing::info!(address = %args.bind, data = %args.data.display(), "nunatak is listening");
    match args.ingest_bind {
        None => {
            axum::serve(main, app.merge(ingest))
                .with_graceful_shutdown(stopped())
                .await
        }
        Some(address) => {
            let events = tokio::net::TcpListener::bind(address).await?;
            tracing::info!(%address, "receiving events");
            let (a, b) = tokio::join!(
                axum::serve(main, app).with_graceful_shutdown(stopped()),
                axum::serve(events, ingest).with_graceful_shutdown(stopped()),
            );
            a.and(b)
        }
    }
}

async fn close_silent(pipeline: Arc<Pipeline>) {
    let mut every = tokio::time::interval(SWEEP);
    loop {
        every.tick().await;
        match pipeline.close_silent(QUIET).await {
            Ok(closed) => {
                for query in closed {
                    tracing::info!(%query, "closed a query its process stopped reporting");
                }
            }
            Err(error) => tracing::warn!("closing silent queries failed: {error}"),
        }
    }
}

async fn import(data: &Path, files: &[PathBuf]) -> std::io::Result<()> {
    let pipeline = pipeline(data)?;
    let (mut accepted, mut duplicates, mut unfinished) = (0, 0, 0);
    for file in files {
        let bytes = std::fs::read(file)?;
        let mut text = String::new();
        if bytes.starts_with(&[0x1f, 0x8b]) {
            MultiGzDecoder::new(&bytes[..]).read_to_string(&mut text)?;
        } else {
            text = String::from_utf8(bytes).map_err(std::io::Error::other)?;
        }
        let imported = pipeline
            .import(&text)
            .await
            .map_err(|e| std::io::Error::other(format!("{}: {e}", file.display())))?;
        accepted += imported.accepted;
        duplicates += imported.duplicates;
        unfinished += imported.running.len();
    }
    println!(
        "Imported {accepted} events from {} files; {duplicates} were already there, {unfinished} queries had not finished.",
        files.len()
    );
    Ok(())
}

async fn stopped() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("stopping");
}

fn stored_token(data: &Path, bind: SocketAddr) -> std::io::Result<String> {
    let path = data.join("token");
    if let Ok(token) = std::fs::read_to_string(&path) {
        let token = token.trim().to_owned();
        if !token.is_empty() {
            return Ok(token);
        }
    }
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
    let token = bytes.iter().fold(String::new(), |mut hex, b| {
        let _ = write!(hex, "{b:02x}");
        hex
    });
    write_private(&path, &token)?;
    let url = if bind.ip().is_unspecified() {
        format!("http://localhost:{}", bind.port())
    } else {
        format!("http://{bind}")
    };
    let mut out = std::io::stdout().lock();
    writeln!(
        out,
        "Created an ingest token in {}. Send events with:\n",
        path.display()
    )?;
    writeln!(out, "    import polars_telemetry")?;
    writeln!(
        out,
        "    from polars_telemetry.export import HttpEventExporter"
    )?;
    writeln!(
        out,
        "    polars_telemetry.install(exporter=HttpEventExporter({url:?}, token={token:?}))\n"
    )?;
    Ok(token)
}

#[cfg(unix)]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(text.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    std::fs::write(path, text)
}
