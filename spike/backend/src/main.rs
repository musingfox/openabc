// Spike: minimal WebSocket echo server (axum 0.8 + tokio)
// Demonstrates the real backend stack; gate checks for echo behavior.
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
    routing::get,
    Router,
};
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

    let addr = "127.0.0.1:9001";
    let listener = TcpListener::bind(addr).await.unwrap();
    tracing::info!("spike WS echo listening on {}", addr);
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade, State(_state): State<Arc<AppState>>) -> Response {
    ws.on_upgrade(handle_socket)
}

/// WebSocket echo: every message received is echoed back unchanged.
async fn handle_socket(mut socket: WebSocket) {
    while let Some(Ok(msg)) = socket.recv().await {
        match msg {
            Message::Text(text) => {
                tracing::info!("echo text: {}", text);
                if socket.send(Message::Text(text)).await.is_err() {
                    break;
                }
            }
            Message::Binary(data) => {
                if socket.send(Message::Binary(data)).await.is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}
