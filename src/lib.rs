pub mod native;
pub mod schema;

use axum::{
    extract::State,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use schema::GatewayReply;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use tracing::{info, warn};

// --- App state (minimal: only native) ---

pub struct AppState {
    /// WebSocket authentication token (None = no auth, prints warn)
    pub ws_token: Option<String>,
    /// Broadcast channel: gateway → OAB (events from native browser)
    pub event_tx: broadcast::Sender<String>,
    /// Per-connection sender handles for the native adapter
    pub native_senders: native::NativeSenders,
}

// --- WebSocket handler (OAB connects here at /ws) ---

async fn ws_handler(
    State(state): State<Arc<AppState>>,
    query: axum::extract::Query<HashMap<String, String>>,
    ws: axum::extract::WebSocketUpgrade,
) -> axum::response::Response {
    if let Some(ref expected) = state.ws_token {
        let provided = query.get("token").map(|s| s.as_str());
        if provided != Some(expected.as_str()) {
            warn!("WebSocket rejected: invalid or missing token");
            return axum::http::StatusCode::UNAUTHORIZED.into_response();
        }
    }
    ws.on_upgrade(move |socket| handle_oab_connection(state, socket))
}

async fn handle_oab_connection(state: Arc<AppState>, socket: axum::extract::ws::WebSocket) {
    use axum::extract::ws::Message;

    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut event_rx = state.event_tx.subscribe();

    info!("OAB client connected via WebSocket");

    // Forward gateway events → OAB.
    // A broadcast Lagged must NOT tear down the connection: skip the dropped span and keep
    // forwarding. Closed means all senders are gone → end the task cleanly.
    let send_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(event_json) => {
                    if ws_tx.send(Message::Text(event_json.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "event broadcast lagged; dropped messages, continuing");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Receive OAB replies → route to native
    let state_for_recv = state.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            if let Message::Text(text) = msg {
                match serde_json::from_str::<GatewayReply>(&text) {
                    Ok(reply) => {
                        info!(
                            platform = %reply.platform,
                            channel = %reply.channel.id,
                            command = ?reply.command.as_deref(),
                            "OAB → gateway reply"
                        );
                        match reply.platform.as_str() {
                            "native" => {
                                native::dispatch_reply(
                                    &state_for_recv.native_senders,
                                    &reply,
                                )
                                .await;
                            }
                            other => warn!(platform = other, "unknown reply platform"),
                        }
                    }
                    Err(e) => warn!("invalid reply from OAB: {e}"),
                }
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
    info!("OAB client disconnected");
}

async fn health() -> &'static str {
    "ok"
}

/// Build the openabc application.
///
/// Reads `OPENABC_WS_TOKEN` from environment (optional).
/// Mounts /ws, /health, /native, /native/ws.
pub async fn build_app() -> Router {
    let ws_token = std::env::var("OPENABC_WS_TOKEN").ok();

    if ws_token.is_none() {
        warn!("OPENABC_WS_TOKEN not set — WebSocket connections are NOT authenticated (insecure)");
    }

    let (event_tx, _) = broadcast::channel::<String>(256);
    let native_senders: native::NativeSenders = Arc::new(Mutex::new(HashMap::new()));

    let state = Arc::new(AppState {
        ws_token,
        event_tx,
        native_senders,
    });

    let app: Router<Arc<AppState>> = Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(health))
        .merge(native::router());

    app.with_state(state)
}
