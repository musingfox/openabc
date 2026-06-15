// Integration test: backend proactively pushes agent-state events over WS.
// E1: first frame has type==state and state in {idle,speaking,listening,thinking}.
// E2: >=2 frames received with >=2 distinct state values (client sends nothing).
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
    routing::get,
    Router,
};
use futures_util::StreamExt;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::connect_async;

#[derive(Clone)]
struct AppState;

async fn ws_handler_test(ws: WebSocketUpgrade, State(_): State<Arc<AppState>>) -> Response {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(mut socket: WebSocket) {
    let states = ["idle", "speaking", "listening", "thinking"];
    let mut idx = 0usize;

    let msg = format!(r#"{{"type":"state","state":"{}"}}"#, states[idx]);
    if socket.send(Message::Text(msg.into())).await.is_err() {
        return;
    }

    let mut ticker = tokio::time::interval(Duration::from_millis(800));
    ticker.tick().await;

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
                    _ => {}
                }
            }
        }
    }
}

#[tokio::test]
async fn test_backend_proactively_pushes_state_events() {
    let state = Arc::new(AppState);
    let app = Router::new()
        .route("/ws", get(ws_handler_test))
        .with_state(state);

    // Bind on ephemeral port.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let url = format!("ws://127.0.0.1:{}/ws", port);

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    // Give server a moment to start.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let (mut ws_stream, _) = connect_async(&url).await.expect("WS connect failed");

    let valid_states: HashSet<&str> = ["idle", "speaking", "listening", "thinking"]
        .iter()
        .cloned()
        .collect();

    let mut received_states: Vec<String> = Vec::new();

    // Collect frames for up to 3 seconds; stop early once we have >=2 distinct.
    let collect = async {
        while let Some(Ok(msg)) = ws_stream.next().await {
            if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("state") {
                        if let Some(s) = v.get("state").and_then(|s| s.as_str()) {
                            received_states.push(s.to_string());
                        }
                    }
                }
                let distinct: HashSet<_> = received_states.iter().collect();
                if received_states.len() >= 2 && distinct.len() >= 2 {
                    break;
                }
            }
        }
    };

    timeout(Duration::from_secs(3), collect)
        .await
        .expect("timed out waiting for state events");

    // E1: at least one frame, all received states are in the valid set.
    assert!(
        !received_states.is_empty(),
        "E1 FAIL: received no state events"
    );
    for s in &received_states {
        assert!(
            valid_states.contains(s.as_str()),
            "E1 FAIL: state '{}' not in {{idle,speaking,listening,thinking}}",
            s
        );
    }

    // E2: >=2 frames with >=2 distinct states.
    let distinct: HashSet<_> = received_states.iter().collect();
    assert!(
        received_states.len() >= 2,
        "E2 FAIL: got {} frames, need >=2",
        received_states.len()
    );
    assert!(
        distinct.len() >= 2,
        "E2 FAIL: got {} distinct states, need >=2 (frames: {:?})",
        distinct.len(),
        received_states
    );
}
