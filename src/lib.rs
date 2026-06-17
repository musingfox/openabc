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

// ─── w2 / w4 — multibot current-state wall unit witnesses ───────────────────
//
// Placed at the crate root (not inside a named mod) so the lib test binary
// registers them under the bare names w2_..., w4_... — matching the
// exact-name filter the gate uses (cargo test --lib <name> -- --exact).

/// w2 — senders map keyed by conn_id only.
/// Two GatewayReply values share the same channel.id (= conn_id) but differ
/// in text (simulating two different bots). dispatch_reply uses only conn_id
/// to look up the mpsc::Sender — so both pushes land on the same receiver.
/// After both dispatches the senders map still holds exactly 1 entry.
#[cfg(test)]
#[tokio::test]
async fn w2_senders_keyed_by_conn_only() {
    use native::{dispatch_reply, NativeSenders};
    use schema::{Content, GatewayReply, ReplyChannel};
    use std::collections::HashMap;
    use tokio::sync::{mpsc, Mutex};

    let senders: NativeSenders = Arc::new(Mutex::new(HashMap::new()));
    let (push_tx, mut push_rx) = mpsc::channel::<String>(16);

    let conn_id = "test-conn-xyz".to_string();
    senders.lock().await.insert(conn_id.clone(), push_tx);

    let make = |text: &str| GatewayReply {
        schema: "openab.gateway.reply.v1".into(),
        reply_to: "evt".into(),
        platform: "native".into(),
        channel: ReplyChannel { id: conn_id.clone(), thread_id: None },
        content: Content { content_type: "text".into(), text: text.into(), attachments: vec![] },
        command: None,
        request_id: None,
        quote_message_id: None,
    };

    dispatch_reply(&senders, &make("from-bot-a")).await;
    dispatch_reply(&senders, &make("from-bot-b")).await;

    assert_eq!(senders.lock().await.len(), 1, "w2: senders map must have exactly 1 entry");

    let msg1 = push_rx.recv().await.expect("w2: first push missing");
    let msg2 = push_rx.recv().await.expect("w2: second push missing");

    let v1: serde_json::Value = serde_json::from_str(&msg1).unwrap();
    let v2: serde_json::Value = serde_json::from_str(&msg2).unwrap();

    let texts: std::collections::HashSet<String> = [
        v1["text"].as_str().unwrap().to_string(),
        v2["text"].as_str().unwrap().to_string(),
    ].into();
    assert!(texts.contains("from-bot-a"), "w2: first bot's text must be received");
    assert!(texts.contains("from-bot-b"), "w2: second bot's text must be received");
}

/// w4 — AppState has no bot registry; dispatch_reply takes only two args.
/// Structural assertion: constructing AppState exhausts its fields (ws_token +
/// event_tx + native_senders). A closure that calls dispatch_reply with only
/// (&NativeSenders, &GatewayReply) must compile — no registry arg exists.
#[cfg(test)]
#[test]
fn w4_no_bot_registry() {
    use native::NativeSenders;
    use schema::{Content, GatewayReply, ReplyChannel};
    use std::collections::HashMap;
    use tokio::sync::{broadcast, Mutex};

    let (event_tx, _rx) = broadcast::channel::<String>(4);
    let senders: NativeSenders = Arc::new(Mutex::new(HashMap::new()));
    let state = AppState {
        ws_token: None,
        event_tx,
        native_senders: senders.clone(),
    };
    // Exhaustive destructure: if a bot_registry field were added, this would fail to compile.
    let AppState { ws_token: _, event_tx: _, native_senders: _ } = state;

    // Compile-time shape assertion for dispatch_reply signature.
    // The closure wraps the call but is never invoked.
    let senders2: NativeSenders = Arc::new(Mutex::new(HashMap::new()));
    let dummy_reply = GatewayReply {
        schema: "openab.gateway.reply.v1".into(),
        reply_to: "evt".into(),
        platform: "native".into(),
        channel: ReplyChannel { id: "no-conn".into(), thread_id: None },
        content: Content { content_type: "text".into(), text: "x".into(), attachments: vec![] },
        command: None,
        request_id: None,
        quote_message_id: None,
    };
    let _proof = move || async move { native::dispatch_reply(&senders2, &dummy_reply).await; };
    let _ = std::hint::black_box(std::mem::size_of_val(&_proof));

    // Verify the senders map is keyed by conn_id strings only (no bot entries pre-registered).
    // Use blocking_lock since w4 is a sync test.
    let guard = senders.blocking_lock();
    assert!(guard.is_empty(), "w4: fresh senders map must be empty (no bot entries pre-registered)");
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
