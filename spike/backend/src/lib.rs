// openabc-ws-spike lib: WS state-push logic shared by bin + integration tests.
use axum::extract::ws::{Message, WebSocket};
use tokio::time::{interval, Duration};

/// Carousel interval in milliseconds — single source of truth for bin and tests.
pub const CYCLE_MS: u64 = 1000;

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

/// On connect: immediately push idle, then cycle through states every CYCLE_MS ms.
pub async fn handle_socket(mut socket: WebSocket) {
    let states = ["idle", "speaking", "listening", "thinking"];
    let mut idx = 0usize;

    // Send first state immediately.
    let msg = format!(r#"{{"type":"state","state":"{}"}}"#, states[idx]);
    if socket.send(Message::Text(msg.into())).await.is_err() {
        return;
    }

    let mut ticker = interval(Duration::from_millis(CYCLE_MS));
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
