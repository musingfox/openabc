//! Integration tests for the native adapter wired into the full app.
//!
//! Drive the real app over real sockets:
//!   - built via `openabc::build_app()`,
//!   - served on `127.0.0.1:0` with `axum::serve`,
//!   - exercised with `reqwest` (HTTP) and `tokio_tungstenite` (WS).

use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::Message as TMsg};
use futures_util::{SinkExt, StreamExt};

/// Build the full app and serve it on an ephemeral port; return the port.
/// Clears auth env so the OAB-side `/ws` accepts connections without a token.
async fn spawn_full_app() -> u16 {
    std::env::remove_var("OPENABC_WS_TOKEN");
    let app = openabc::build_app().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    // brief moment for the listener task to be scheduled
    tokio::time::sleep(Duration::from_millis(50)).await;
    port
}

/// Connect a browser WS to /native/ws, send one message, and harvest the
/// connection id (the GatewayEvent.channel.id) by reading it off the OAB side.
/// Returns (browser_ws, oab_ws, conn_id).
async fn connect_browser_and_get_conn_id(
    port: u16,
) -> (
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
) {
    // OAB side first so it is subscribed before the event is broadcast.
    let oab_url = format!("ws://127.0.0.1:{port}/ws");
    let (mut oab_ws, _) = connect_async(&oab_url).await.expect("OAB /ws connect failed");
    tokio::time::sleep(Duration::from_millis(50)).await;

    let browser_url = format!("ws://127.0.0.1:{port}/native/ws");
    let (mut browser_ws, _) = connect_async(&browser_url)
        .await
        .expect("browser /native/ws connect failed");

    browser_ws
        .send(TMsg::Text(r#"{"text":"hello from browser"}"#.to_string().into()))
        .await
        .unwrap();

    // The OAB side should receive the GatewayEvent; extract channel.id.
    let raw = loop {
        let msg = tokio::time::timeout(Duration::from_secs(3), oab_ws.next())
            .await
            .expect("timeout waiting for event on OAB /ws")
            .expect("OAB ws stream ended")
            .expect("OAB ws error");
        if let TMsg::Text(t) = msg {
            break t.to_string();
        }
    };
    let v: serde_json::Value = serde_json::from_str(&raw).expect("event must be JSON");
    assert_eq!(v["platform"], "native", "event platform must be native");
    let conn_id = v["channel"]["id"]
        .as_str()
        .expect("channel.id must be a string")
        .to_string();
    (browser_ws, oab_ws, conn_id)
}

/// E1 — native router merged into the main app: the FULL app (via build_app)
/// serves GET /native with 200 and body containing the real sprite avatar UI
/// (stateToSrc mapping referencing idle/speaking/listening/thinking states via /assets/).
/// Also asserts /native/ws is referenced and the WS connection is established.
#[tokio::test]
async fn e1_full_app_serves_native_ui() {
    let port = spawn_full_app().await;
    let url = format!("http://127.0.0.1:{port}/native");
    let resp = reqwest::get(&url).await.expect("GET /native failed");
    assert_eq!(resp.status(), 200, "GET /native must return 200");
    let body = resp.text().await.unwrap();

    // The embedded page loads the built JS bundle which contains stateToSrc + replyToState.
    // The HTML references /assets/ for the bundle.
    assert!(
        body.contains("/assets/"),
        "GET /native body must reference /assets/ (embedded sprite UI)"
    );

    // The HTML must be a valid document with a script tag loading the avatar bundle.
    assert!(
        body.contains("<script"),
        "GET /native body must contain a <script> tag loading the avatar bundle"
    );

    // The JS bundle (served at /assets/index.js) must contain the sprite state machine.
    // We verify this by fetching the JS asset and asserting it references all four states.
    let js_url = format!("http://127.0.0.1:{port}/assets/index.js");
    let js_resp = reqwest::get(&js_url).await.expect("GET /assets/index.js failed");
    assert_eq!(js_resp.status(), 200, "GET /assets/index.js must return 200");
    let js_body = js_resp.text().await.unwrap();

    // The built JS must contain stateToSrc (sprite state->src mapping) and all four states.
    assert!(js_body.contains("idle"), "JS bundle must reference 'idle' state");
    assert!(js_body.contains("speaking"), "JS bundle must reference 'speaking' state");
    assert!(js_body.contains("listening"), "JS bundle must reference 'listening' state");
    assert!(js_body.contains("thinking"), "JS bundle must reference 'thinking' state");

    // The JS must reference /native/ws for the WebSocket connection.
    assert!(
        js_body.contains("/native/ws"),
        "JS bundle must reference /native/ws for the WebSocket connection"
    );

    // The JS must also contain new WebSocket construction.
    assert!(
        js_body.contains("WebSocket"),
        "JS bundle must contain WebSocket (new WebSocket)"
    );
}

/// E2 — embedded asset serving: GET /assets/idle.png returns 200 with image/png.
/// Verifies all four sprite states are served as embedded PNG assets.
#[tokio::test]
async fn e2_embedded_sprite_assets_served() {
    let port = spawn_full_app().await;

    for state in &["idle", "speaking", "listening", "thinking"] {
        let url = format!("http://127.0.0.1:{port}/assets/{state}.png");
        let resp = reqwest::get(&url).await.unwrap_or_else(|e| panic!("GET /assets/{state}.png failed: {e}"));
        assert_eq!(resp.status(), 200, "GET /assets/{state}.png must return 200");
        let ct = resp.headers()
            .get("content-type")
            .expect("content-type header must be present")
            .to_str()
            .unwrap();
        assert!(ct.contains("image/png"), "content-type must be image/png for {state}.png, got {ct}");
    }
}

/// E3 / E4 — an outbound platform=native GatewayReply, sent on the OAB-side
/// `/ws`, traverses the main reply loop's native branch and is pushed to the
/// matching browser WS. The browser receives {"type":"message","text":"pong-from-oab"}.
#[tokio::test]
async fn e2_e3_native_reply_round_trips_through_full_app() {
    let port = spawn_full_app().await;
    let (mut browser_ws, mut oab_ws, conn_id) = connect_browser_and_get_conn_id(port).await;

    // OAB sends a GatewayReply targeting that conn_id over the SAME /ws socket.
    // platform=native triggers the native branch in build_app's reply loop.
    let reply = serde_json::json!({
        "schema": "openab.gateway.reply.v1",
        "reply_to": "evt_x",
        "platform": "native",
        "channel": { "id": conn_id, "thread_id": null },
        "content": { "type": "text", "text": "pong-from-oab", "attachments": [] },
        "command": null,
        "request_id": null,
        "quote_message_id": null
    });
    oab_ws
        .send(TMsg::Text(reply.to_string().into()))
        .await
        .unwrap();

    // The browser WS must receive {"type":"message","text":"pong-from-oab"}.
    let pushed = loop {
        let msg = tokio::time::timeout(Duration::from_secs(3), browser_ws.next())
            .await
            .expect("timeout waiting for push to browser (native branch did not deliver)")
            .expect("browser ws stream ended")
            .expect("browser ws error");
        if let TMsg::Text(t) = msg {
            break t.to_string();
        }
    };
    let v: serde_json::Value = serde_json::from_str(&pushed).expect("push must be JSON");
    assert_eq!(v["type"], "message", "push type must be `message`");
    assert_eq!(
        v["text"], "pong-from-oab",
        "browser must receive the reply text routed via the native branch"
    );

    browser_ws.close(None).await.ok();
    oab_ws.close(None).await.ok();
}

/// E-R1 — reaction round-trip via build_app real socket:
/// OAB /ws sends GatewayReply command=add_reaction + content.text=👀 targeting the browser
/// conn_id; the browser WS must receive JSON with type=="reaction", op=="add", text=="👀".
#[tokio::test]
async fn e_r1_reaction_add_round_trips_to_browser_ws() {
    let port = spawn_full_app().await;
    let (mut browser_ws, mut oab_ws, conn_id) = connect_browser_and_get_conn_id(port).await;

    let reply = serde_json::json!({
        "schema": "openab.gateway.reply.v1",
        "reply_to": "evt_reaction",
        "platform": "native",
        "channel": { "id": conn_id, "thread_id": null },
        "content": { "type": "text", "text": "👀", "attachments": [] },
        "command": "add_reaction",
        "request_id": null,
        "quote_message_id": null
    });
    oab_ws
        .send(TMsg::Text(reply.to_string().into()))
        .await
        .unwrap();

    let pushed = loop {
        let msg = tokio::time::timeout(Duration::from_secs(3), browser_ws.next())
            .await
            .expect("timeout waiting for reaction push to browser")
            .expect("browser ws stream ended")
            .expect("browser ws error");
        if let TMsg::Text(t) = msg {
            break t.to_string();
        }
    };
    let v: serde_json::Value = serde_json::from_str(&pushed).expect("push must be JSON");
    assert_eq!(v["type"], "reaction", "E-R1: push type must be `reaction`");
    assert_eq!(v["op"], "add", "E-R1: op must be `add`");
    assert_eq!(v["text"], "👀", "E-R1: text must be the emoji 👀");

    browser_ws.close(None).await.ok();
    oab_ws.close(None).await.ok();
}

/// E-R2 — message round-trip via build_app real socket:
/// OAB /ws sends GatewayReply command=null + content.text="hello"; the browser WS must
/// receive JSON with type=="message", text=="hello", and no op field (or op null).
#[tokio::test]
async fn e_r2_message_round_trips_with_no_op() {
    let port = spawn_full_app().await;
    let (mut browser_ws, mut oab_ws, conn_id) = connect_browser_and_get_conn_id(port).await;

    let reply = serde_json::json!({
        "schema": "openab.gateway.reply.v1",
        "reply_to": "evt_msg",
        "platform": "native",
        "channel": { "id": conn_id, "thread_id": null },
        "content": { "type": "text", "text": "hello", "attachments": [] },
        "command": null,
        "request_id": null,
        "quote_message_id": null
    });
    oab_ws
        .send(TMsg::Text(reply.to_string().into()))
        .await
        .unwrap();

    let pushed = loop {
        let msg = tokio::time::timeout(Duration::from_secs(3), browser_ws.next())
            .await
            .expect("timeout waiting for message push to browser")
            .expect("browser ws stream ended")
            .expect("browser ws error");
        if let TMsg::Text(t) = msg {
            break t.to_string();
        }
    };
    let v: serde_json::Value = serde_json::from_str(&pushed).expect("push must be JSON");
    assert_eq!(v["type"], "message", "E-R2: push type must be `message`");
    assert_eq!(v["text"], "hello", "E-R2: text must be `hello`");
    assert!(
        v.get("op").is_none() || v["op"].is_null(),
        "E-R2: op must be absent or null for a plain message push"
    );

    browser_ws.close(None).await.ok();
    oab_ws.close(None).await.ok();
}

/// E-LAG — a broadcast `Lagged` must NOT tear down the OAB `/ws` connection.
/// Flood well past the 256-slot broadcast buffer WITHOUT draining the OAB side, so the
/// send_task's next `recv()` observes `RecvError::Lagged`. A final sentinel event must
/// still arrive on OAB `/ws` afterwards — proving the send_task skipped the lag instead
/// of dying. The pre-fix single-branch `select!` panicked here, killing the connection.
#[tokio::test]
async fn e_lag_does_not_kill_oab_connection() {
    let port = spawn_full_app().await;

    let oab_url = format!("ws://127.0.0.1:{port}/ws");
    let (mut oab_ws, _) = connect_async(&oab_url).await.expect("OAB /ws connect failed");
    tokio::time::sleep(Duration::from_millis(50)).await;

    let browser_url = format!("ws://127.0.0.1:{port}/native/ws");
    let (mut browser_ws, _) = connect_async(&browser_url)
        .await
        .expect("browser /native/ws connect failed");

    // Flood far past the 256-slot broadcast buffer while the OAB side is NOT being read,
    // so the buffer overflows and the next OAB-side recv() returns Lagged.
    for i in 0..600 {
        browser_ws
            .send(TMsg::Text(format!(r#"{{"text":"flood-{i}"}}"#).into()))
            .await
            .unwrap();
    }
    // A distinguishable final message that must still get through after the lag.
    browser_ws
        .send(TMsg::Text(r#"{"text":"SENTINEL-after-lag"}"#.to_string().into()))
        .await
        .unwrap();

    // Let the broadcast overflow and mark the lag before we start draining.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Drain the OAB side: the sentinel event must eventually arrive.
    let found = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match oab_ws.next().await {
                Some(Ok(TMsg::Text(t))) => {
                    if t.contains("SENTINEL-after-lag") {
                        break true;
                    }
                }
                Some(Ok(_)) => continue,
                _ => break false, // stream ended / error → connection died on the lag (the bug)
            }
        }
    })
    .await
    .expect("timed out waiting for sentinel — OAB connection likely died on lag");
    assert!(found, "OAB /ws stream ended before the post-lag sentinel arrived");

    browser_ws.close(None).await.ok();
    oab_ws.close(None).await.ok();
}
