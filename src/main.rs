use tokio::net::TcpListener;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let listen_addr = std::env::var("OPENABC_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:8080".to_string());

    let app = openabc::build_app().await;

    let listener = TcpListener::bind(&listen_addr).await?;
    info!(addr = %listen_addr, "openabc listening");

    axum::serve(listener, app).await?;
    Ok(())
}
