mod api;
mod auth;
mod backup;
mod compact;
mod config;
mod db;
mod gps;
mod ingest;
mod parquet;
mod storage;

use std::sync::Arc;

use tokio::sync::RwLock;
use tracing_subscriber::EnvFilter;

use crate::config::Settings;
use crate::db::Db;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let command = std::env::args().nth(1);
    if matches!(command.as_deref(), Some("-h" | "--help")) {
        println!("usage: acta [serve|restore [--force]]");
        return Ok(());
    }

    let settings = Settings::from_env().map_err(std::io::Error::other)?;

    match command.as_deref() {
        None | Some("serve") => serve(settings).await,
        Some("restore") => {
            let force = std::env::args().any(|arg| arg == "--force");
            backup::restore(&settings.db.data_dir, &settings.backup, force)
                .await
                .map_err(std::io::Error::other)?;
            Ok(())
        }
        Some(other) => Err(std::io::Error::other(format!("unknown command: {other}")).into()),
    }
}

async fn serve(settings: Settings) -> Result<(), Box<dyn std::error::Error>> {
    // Make sure the data directory exists and the read view can bind, before any
    // connection is opened over it.
    ingest::prepare(&settings.db.data_dir)
        .await
        .map_err(std::io::Error::other)?;

    let db = Db::open(settings.db.clone()).map_err(std::io::Error::other)?;
    let data_lock = Arc::new(RwLock::new(()));
    let ingest = ingest::start(
        db.data_dir().to_path_buf(),
        settings.write.clone(),
        Arc::clone(&data_lock),
    );

    if settings.backup.enabled {
        tokio::spawn(backup::run(
            db.data_dir().to_path_buf(),
            settings.backup.clone(),
        ));
    }

    tracing::info!(
        addr = %settings.addr,
        data_dir = %db.data_dir().display(),
        tiles_dir = %settings.tiles_dir.display(),
        pool = settings.db.pool_size,
        flush_ms = settings.write.flush_interval.as_millis(),
        auth = settings.auth.enabled(),
        backup = settings.backup.enabled,
        "acta service starting"
    );

    let state = api::AppState {
        db: Arc::new(db),
        ingest: ingest.handle(),
        data_lock,
        ingest_max_batch: settings.write.ingest_max_batch,
        ingest_max_body_bytes: settings.write.ingest_max_body_bytes,
    };
    let app = api::router(state, settings.ui_dir, settings.tiles_dir, settings.auth);

    let listener = tokio::net::TcpListener::bind(settings.addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    // Flush whatever is still buffered before exiting.
    ingest.shutdown().await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
