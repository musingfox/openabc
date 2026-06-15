// Spike: WebSocket server that proactively pushes agent state events (axum 0.8 + tokio)
// Bind address configurable via BIND_ADDR or PORT env vars; default 127.0.0.1:9001.
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
use tokio::time::{interval, Duration};

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

/// Resolve bind address from environment: BIND_ADDR > PORT > default.
pub fn bind_addr() -> String {
    if let Ok(v) = std::env::var("BIND_ADDR") {
        if !v.is_empty() {
            return v;
        }
    }
    if let Ok(p) = std::env::var("PORT") {
        if !p.is_empty() {
            return format!("127.0.0.1:{}", p);
        }
    }
    "127.0.0.1:9001".to_string()
}

async fn ws_handler(ws: WebSocketUpgrade, State(_state): State<Arc<AppState>>) -> Response {
    ws.on_upgrade(handle_socket)
}

/// On connect: immediately push idle, then cycle through states every ~1 second.
async fn handle_socket(mut socket: WebSocket) {
    let states = ["idle", "speaking", "listening", "thinking"];
    let mut idx = 0usize;

    // Send first state immediately.
    let msg = format!(r#"{{"type":"state","state":"{}"}}"#, states[idx]);
    if socket.send(Message::Text(msg.into())).await.is_err() {
        return;
    }

    let mut ticker = interval(Duration::from_millis(1000));
    ticker.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                idx = (idx + 1) % states.len();
                let msg = format!(r#"{{"type":"state","state":"{}"}}"#, states[idx]);
                if socket.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {} // ignore other client messages
                }
            }
        }
    }
}
