use clap::Parser;
use nunatak_server::{Limits, Server, router};
use nunatak_store_fs::{FsLog, FsRecordings};
use std::fmt::Write as _;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Parser)]
#[command(version, about)]
struct Args {
    /// Address to listen on. Only this machine can connect by default.
    #[arg(long, env = "NUNATAK_BIND", default_value = "127.0.0.1:7766")]
    bind: SocketAddr,

    /// Folder for recordings and running queries.
    #[arg(long, env = "NUNATAK_DATA", default_value = "nunatak-data")]
    data: PathBuf,

    /// Token exporters must send. Without one, Nunatak creates one in the data folder.
    #[arg(long, env = "NUNATAK_TOKEN", hide_env_values = true)]
    token: Option<String>,
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
    match run(Args::parse()).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn run(args: Args) -> std::io::Result<()> {
    std::fs::create_dir_all(&args.data)?;
    let token = match args.token {
        Some(token) if !token.is_empty() => token,
        _ => stored_token(&args.data, args.bind)?,
    };
    let app = router(Server {
        token,
        limits: Limits::default(),
        log: Arc::new(FsLog::new(&args.data)),
        recordings: Arc::new(FsRecordings::new(&args.data)),
    });
    let listener = tokio::net::TcpListener::bind(args.bind).await?;
    tracing::info!(address = %args.bind, data = %args.data.display(), "nunatak is listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(stopped())
        .await
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
    let url = format!("http://{bind}");
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
