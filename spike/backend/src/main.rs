// Spike: WebSocket server that proactively pushes agent state events (axum 0.8 + tokio)
// Bind address configurable via BIND_ADDR or PORT env vars; default 127.0.0.1:9001.
use axum::{
    extract::{
        ws::{WebSocketUpgrade},
        State,
    },
    response::Response,
    routing::get,
    Router,
};
use openabc_ws_spike::{bind_addr, handle_socket};
use std::sync::Arc;
use tokio::net::TcpListener;

#[derive(Clone)]
struct AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let state = Arc::new(AppState);
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state);

    let addr = bind_addr();
    let listener = TcpListener::bind(&addr).await.unwrap();
    tracing::info!("spike WS state-push listening on {}", addr);
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade, State(_state): State<Arc<AppState>>) -> Response {
    ws.on_upgrade(handle_socket)
}
