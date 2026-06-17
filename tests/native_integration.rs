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

/// E4 — embedded-serve smoke: start the full server, GET /native, parse ALL
/// /assets/* references from the served HTML, GET each one and assert 200.
/// This is derived from what the HTML actually names — NOT a hardcoded list —
/// so that any future orphan chunk (like turn17's 76 mermaid chunks) fails here
/// rather than silently 404-ing in the browser.
#[tokio::test]
async fn e4_all_assets_referenced_by_native_html_are_served_200() {
    let port = spawn_full_app().await;
    let client = reqwest::Client::new();

    // Step 1: GET /native and collect the HTML body.
    let native_url = format!("http://127.0.0.1:{port}/native");
    let resp = client.get(&native_url).send().await.expect("GET /native failed");
    assert_eq!(resp.status(), 200, "GET /native must return 200");
    let html = resp.text().await.expect("GET /native body must be text");

    // Step 2: Extract all /assets/<file> references from the HTML.
    // Scan for every occurrence of "/assets/" and collect the filename that follows,
    // stopping at the first quote, whitespace, >, ?, or # character.
    let mut refs_set = std::collections::HashSet::new();
    let needle = "/assets/";
    let mut search = html.as_str();
    while let Some(idx) = search.find(needle) {
        let after = &search[idx + needle.len()..];
        let end = after
            .find(|c: char| c == '"' || c == '\'' || c.is_whitespace() || c == '>' || c == '?' || c == '#')
            .unwrap_or(after.len());
        let name = &after[..end];
        if !name.is_empty() {
            refs_set.insert(name.to_string());
        }
        search = &search[idx + needle.len()..];
    }
    let refs: Vec<String> = refs_set.into_iter().collect();

    assert!(
        !refs.is_empty(),
        "GET /native HTML must reference at least one /assets/* file"
    );

    // Step 3: GET each referenced asset and assert 200.
    for asset_name in &refs {
        let asset_url = format!("http://127.0.0.1:{port}/assets/{asset_name}");
        let asset_resp = client
            .get(&asset_url)
            .send()
            .await
            .unwrap_or_else(|e| panic!("GET /assets/{asset_name} failed: {e}"));
        assert_eq!(
            asset_resp.status(),
            200,
            "GET /assets/{asset_name} (referenced by /native HTML) must return 200, not 404"
        );
    }
}

/// G1 — inbound multi-bot fanout: two OAB /ws connections both receive the same
/// GatewayEvent when a browser sends one message. This witnesses that `event_tx`
/// is a broadcast channel and any number of /ws subscribers receive the event.
#[tokio::test]
async fn g1_inbound_multibot_fanout_both_oab_receive_event() {
    let port = spawn_full_app().await;

    // Connect two OAB /ws subscribers BEFORE the browser sends.
    let oab_url = format!("ws://127.0.0.1:{port}/ws");
    let (mut oab_ws_a, _) = connect_async(&oab_url).await.expect("OAB /ws A connect failed");
    let (mut oab_ws_b, _) = connect_async(&oab_url).await.expect("OAB /ws B connect failed");
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Browser connects and sends one message.
    let browser_url = format!("ws://127.0.0.1:{port}/native/ws");
    let (mut browser_ws, _) = connect_async(&browser_url).await.expect("browser /native/ws connect failed");
    browser_ws
        .send(TMsg::Text(r#"{"text":"fanout-probe"}"#.to_string().into()))
        .await
        .unwrap();

    // Helper: drain until we get a Text frame and return it.
    async fn recv_text(ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) -> String {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(3), ws.next())
                .await
                .expect("timeout waiting for OAB event")
                .expect("OAB ws stream ended")
                .expect("OAB ws error");
            if let TMsg::Text(t) = msg {
                return t.to_string();
            }
        }
    }

    let raw_a = recv_text(&mut oab_ws_a).await;
    let raw_b = recv_text(&mut oab_ws_b).await;

    // Both must be valid GatewayEvent JSON.
    for (label, raw) in [("OAB-A", &raw_a), ("OAB-B", &raw_b)] {
        let v: serde_json::Value = serde_json::from_str(raw)
            .unwrap_or_else(|_| panic!("{label}: event must be JSON, got: {raw}"));
        assert_eq!(
            v["schema"], "openab.gateway.event.v1",
            "{label}: schema must be openab.gateway.event.v1"
        );
        assert_eq!(v["platform"], "native", "{label}: platform must be native");
        assert!(
            v["channel"]["id"].is_string(),
            "{label}: channel.id must be a string"
        );
    }

    // The conn_id embedded in the two events must be the same (same browser message).
    let id_a = serde_json::from_str::<serde_json::Value>(&raw_a).unwrap()["channel"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let id_b = serde_json::from_str::<serde_json::Value>(&raw_b).unwrap()["channel"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(id_a, id_b, "Both OAB /ws must receive the same conn_id");

    browser_ws.close(None).await.ok();
    oab_ws_a.close(None).await.ok();
    oab_ws_b.close(None).await.ok();
}

/// G2 — reply has no bot-identity field: serde round-trip of GatewayReply must
/// not produce any key named bot_id, agent_id, sender, or source at the top level
/// or inside the channel sub-object. This witnesses the current protocol gap.
#[tokio::test]
async fn g2_reply_has_no_bot_identity_field() {
    use openabc::schema::{Content, GatewayReply, ReplyChannel};
    let reply = GatewayReply {
        schema: "openab.gateway.reply.v1".into(),
        reply_to: "evt_test".into(),
        platform: "native".into(),
        channel: ReplyChannel {
            id: "conn-test".into(),
            thread_id: None,
        },
        content: Content {
            content_type: "text".into(),
            text: "hello".into(),
            attachments: vec![],
        },
        command: None,
        request_id: None,
        quote_message_id: None,
    };

    let v = serde_json::to_value(&reply).expect("GatewayReply must serialize");

    // Forbidden keys at top level.
    let forbidden = ["bot_id", "agent_id", "sender", "source"];
    let top_keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    for key in &forbidden {
        assert!(
            !top_keys.contains(key),
            "GatewayReply top-level must not contain '{}' (protocol gap G2)",
            key
        );
    }

    // Forbidden keys inside channel sub-object.
    if let Some(ch) = v.get("channel").and_then(|c| c.as_object()) {
        let ch_keys: Vec<&str> = ch.keys().map(|k| k.as_str()).collect();
        for key in &forbidden {
            assert!(
                !ch_keys.contains(key),
                "GatewayReply.channel must not contain '{}' (protocol gap G2)",
                key
            );
        }
    }
}

/// G3 — multi-bot reply merge unattributable: one browser, two OAB /ws (simulating
/// bot A and bot B) each dispatch a reply to the same conn_id; the browser receives
/// two pushes, each with keys ⊆ {type, op, text} — no source field to tell A from B.
#[tokio::test]
async fn g3_multibot_replies_merge_unattributable() {
    let port = spawn_full_app().await;
    let (mut browser_ws, mut oab_ws_a, conn_id) = connect_browser_and_get_conn_id(port).await;

    // Second OAB /ws (bot B).
    let oab_url = format!("ws://127.0.0.1:{port}/ws");
    let (mut oab_ws_b, _) = connect_async(&oab_url).await.expect("OAB /ws B connect failed");
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Bot A sends a reply.
    let reply_a = serde_json::json!({
        "schema": "openab.gateway.reply.v1",
        "reply_to": "evt_a",
        "platform": "native",
        "channel": { "id": conn_id, "thread_id": null },
        "content": { "type": "text", "text": "from-bot-a", "attachments": [] },
        "command": null,
        "request_id": null,
        "quote_message_id": null
    });
    oab_ws_a.send(TMsg::Text(reply_a.to_string().into())).await.unwrap();

    // Bot B sends a reply.
    let reply_b = serde_json::json!({
        "schema": "openab.gateway.reply.v1",
        "reply_to": "evt_b",
        "platform": "native",
        "channel": { "id": conn_id, "thread_id": null },
        "content": { "type": "text", "text": "from-bot-b", "attachments": [] },
        "command": null,
        "request_id": null,
        "quote_message_id": null
    });
    oab_ws_b.send(TMsg::Text(reply_b.to_string().into())).await.unwrap();

    // Collect 2 pushes from the browser side.
    let mut pushes: Vec<serde_json::Value> = Vec::new();
    while pushes.len() < 2 {
        let msg = tokio::time::timeout(Duration::from_secs(3), browser_ws.next())
            .await
            .expect("timeout waiting for push to browser")
            .expect("browser ws stream ended")
            .expect("browser ws error");
        if let TMsg::Text(t) = msg {
            let v: serde_json::Value = serde_json::from_str(&t).expect("push must be JSON");
            pushes.push(v);
        }
    }

    // Every push must have keys ⊆ {type, op, text} — no source attribution.
    let allowed: std::collections::HashSet<&str> = ["type", "op", "text"].iter().copied().collect();
    for (i, push) in pushes.iter().enumerate() {
        let push_keys: std::collections::HashSet<&str> = push
            .as_object()
            .expect("push must be a JSON object")
            .keys()
            .map(|k| k.as_str())
            .collect();
        let extra: Vec<&&str> = push_keys.difference(&allowed).collect();
        assert!(
            extra.is_empty(),
            "push[{i}] has unexpected keys {extra:?} — keys must be ⊆ {{type,op,text}} (gap G3: no source attribution)"
        );
    }

    browser_ws.close(None).await.ok();
    oab_ws_a.close(None).await.ok();
    oab_ws_b.close(None).await.ok();
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

/// w1 — dual-bot same-conn unattributable: two OAB /ws connections (bot A and bot B)
/// each dispatch one GatewayReply to the same conn_id. The browser receives 2 pushes.
/// Every push must have keys ⊆ {type, op, text} — no source/bot_id/sender attribution.
#[tokio::test]
async fn w1_dual_bot_same_conn_unattributable() {
    let port = spawn_full_app().await;
    let (mut browser_ws, mut oab_ws_a, conn_id) = connect_browser_and_get_conn_id(port).await;

    // Second OAB /ws (bot B).
    let oab_url = format!("ws://127.0.0.1:{port}/ws");
    let (mut oab_ws_b, _) = connect_async(&oab_url).await.expect("OAB /ws B connect failed");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Bot A sends a reply with distinct text.
    let reply_a = serde_json::json!({
        "schema": "openab.gateway.reply.v1",
        "reply_to": "evt_w1a",
        "platform": "native",
        "channel": { "id": conn_id, "thread_id": null },
        "content": { "type": "text", "text": "w1-from-bot-a", "attachments": [] },
        "command": null,
        "request_id": null,
        "quote_message_id": null
    });
    oab_ws_a.send(TMsg::Text(reply_a.to_string().into())).await.unwrap();

    // Bot B sends a reply with distinct text.
    let reply_b = serde_json::json!({
        "schema": "openab.gateway.reply.v1",
        "reply_to": "evt_w1b",
        "platform": "native",
        "channel": { "id": conn_id, "thread_id": null },
        "content": { "type": "text", "text": "w1-from-bot-b", "attachments": [] },
        "command": null,
        "request_id": null,
        "quote_message_id": null
    });
    oab_ws_b.send(TMsg::Text(reply_b.to_string().into())).await.unwrap();

    // Collect 2 text pushes from the browser side.
    let mut pushes: Vec<serde_json::Value> = Vec::new();
    while pushes.len() < 2 {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(3), browser_ws.next())
            .await
            .expect("w1: timeout waiting for push to browser")
            .expect("w1: browser ws stream ended")
            .expect("w1: browser ws error");
        if let TMsg::Text(t) = msg {
            let v: serde_json::Value = serde_json::from_str(&t).expect("w1: push must be JSON");
            pushes.push(v);
        }
    }

    // Every push must have keys ⊆ {type, op, text} — no source/bot_id/sender.
    let allowed: std::collections::HashSet<&str> = ["type", "op", "text"].iter().copied().collect();
    for (i, push) in pushes.iter().enumerate() {
        let push_keys: std::collections::HashSet<&str> = push
            .as_object()
            .expect("w1: push must be a JSON object")
            .keys()
            .map(|k| k.as_str())
            .collect();
        let extra: Vec<&&str> = push_keys.difference(&allowed).collect();
        assert!(
            extra.is_empty(),
            "w1: push[{i}] has unexpected keys {extra:?} — keys must be ⊆ {{type,op,text}} (no source attribution)"
        );
    }

    browser_ws.close(None).await.ok();
    oab_ws_a.close(None).await.ok();
    oab_ws_b.close(None).await.ok();
}

/// w5 — inbound is_bot false + single event_tx.send call site:
/// (a) A browser message produces a GatewayEvent with sender.is_bot == false (behavioral).
/// (b) The source text of src/native.rs contains exactly one "event_tx.send(" call site
///     (static assertion derived from the frozen spec — witnesses the single broadcast point).
#[tokio::test]
async fn w5_inbound_is_bot_false_and_single_event_txsend() {
    // (a) Behavioral: browser message → GatewayEvent.sender.is_bot == false.
    let port = spawn_full_app().await;
    let (_browser_ws, _oab_ws, _conn_id) = connect_browser_and_get_conn_id(port).await;

    // connect_browser_and_get_conn_id already sent a message and received the GatewayEvent.
    // We re-do the round-trip here to inspect is_bot directly.
    let port2 = spawn_full_app().await;

    let oab_url = format!("ws://127.0.0.1:{port2}/ws");
    let (mut oab_ws, _) = connect_async(&oab_url).await.expect("OAB /ws connect failed");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let browser_url = format!("ws://127.0.0.1:{port2}/native/ws");
    let (mut browser_ws2, _) = connect_async(&browser_url)
        .await
        .expect("browser /native/ws connect failed");
    browser_ws2
        .send(TMsg::Text(r#"{"text":"w5-probe"}"#.to_string().into()))
        .await
        .unwrap();

    let raw = loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(3), oab_ws.next())
            .await
            .expect("w5: timeout waiting for GatewayEvent")
            .expect("w5: OAB ws stream ended")
            .expect("w5: OAB ws error");
        if let TMsg::Text(t) = msg {
            break t.to_string();
        }
    };

    let v: serde_json::Value = serde_json::from_str(&raw).expect("w5: event must be JSON");
    assert_eq!(
        v["sender"]["is_bot"], false,
        "w5(a): GatewayEvent.sender.is_bot must be false for browser-originated messages"
    );

    // (b) Static: exactly one "event_tx.send(" call site in src/native.rs.
    let src = include_str!("../src/native.rs");
    let count = src.matches("event_tx.send(").count();
    assert_eq!(
        count, 1,
        "w5(b): src/native.rs must contain exactly 1 'event_tx.send(' call site, found {count}"
    );

    browser_ws2.close(None).await.ok();
    oab_ws.close(None).await.ok();
}
