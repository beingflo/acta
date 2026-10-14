mod api;
mod config;
mod db;

use std::sync::Arc;

use tracing_subscriber::EnvFilter;

use crate::config::Settings;
use crate::db::Db;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let settings = Settings::from_env().map_err(std::io::Error::other)?;
    let db = Db::open(settings.db.clone()).map_err(std::io::Error::other)?;

    tracing::info!(
        addr = %settings.addr,
        data_dir = %settings.db.data_dir.display(),
        pool = settings.db.pool_size,
        "acta service starting"
    );

    let state = api::AppState { db: Arc::new(db) };
    let app = api::router(state, settings.ui_dir);

    let listener = tokio::net::TcpListener::bind(settings.addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
