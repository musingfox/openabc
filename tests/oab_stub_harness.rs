//! Behavioral end-to-end harness for the oab_stub dev-harness.
//!
//! Spins up a real openabc server (same pattern as native_integration.rs),
//! then calls stub_core functions directly — no subprocess spawning.

use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::Message as TMsg};
use futures_util::{SinkExt, StreamExt};

// Re-use the stub core via the binary module.
// We reference the file directly so the harness can call run_stub_session.
// The bin crate is compiled as part of the workspace, so we include the
// module inline via path attribute.
#[path = "../src/bin/oab_stub.rs"]
mod oab_stub;

use oab_stub::stub_core;

/// Start a real openabc server on an ephemeral port; return the port.
async fn spawn_full_app() -> u16 {
    std::env::remove_var("OPENABC_WS_TOKEN");
    let app = openabc::build_app().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    port
}

/// S2 — stub connects /ws, browser /native/ws sends {text}, stub receives
/// platform==native GatewayEvent with non-empty channel.id.
#[tokio::test]
async fn s2_stub_connects_and_receives_event() {
    let port = spawn_full_app().await;
    let ws_url = format!("ws://127.0.0.1:{port}/ws");
    let browser_url = format!("ws://127.0.0.1:{port}/native/ws");

    // Stub connects first so it is subscribed before the browser event fires.
    // We spawn the stub session as a background task.
    let stub_handle = tokio::spawn({
        let url = ws_url.clone();
        async move { stub_core::run_stub_session(&url, 0, None).await }
    });

    // Brief settle time.
    tokio::time::sleep(Duration::from_millis(60)).await;

    // Browser connects and sends a message.
    let (mut browser_ws, _) = connect_async(&browser_url)
        .await
        .expect("browser /native/ws connect failed");
    browser_ws
        .send(TMsg::Text(r#"{"text":"s2-probe"}"#.to_string().into()))
        .await
        .unwrap();

    // Wait for stub to finish (it receives the event, replies, done).
    let (event, _reply) = tokio::time::timeout(
        Duration::from_secs(5),
        stub_handle,
    )
    .await
    .expect("s2: timeout waiting for stub")
    .expect("s2: stub task panicked")
    .expect("s2: stub returned error");

    assert_eq!(event.platform, "native", "s2: event platform must be native");
    assert!(!event.channel.id.is_empty(), "s2: channel.id must be non-empty");

    browser_ws.close(None).await.ok();
}

/// S3 — stub receives GatewayEvent and echoes GatewayReply; browser receives
/// a push with type==message and text containing the echo.
#[tokio::test]
async fn s3_stub_echo_reply_round_trips() {
    let port = spawn_full_app().await;
    let ws_url = format!("ws://127.0.0.1:{port}/ws");
    let browser_url = format!("ws://127.0.0.1:{port}/native/ws");

    let stub_handle = tokio::spawn({
        let url = ws_url.clone();
        async move { stub_core::run_stub_session(&url, 0, None).await }
    });

    tokio::time::sleep(Duration::from_millis(60)).await;

    let (mut browser_ws, _) = connect_async(&browser_url)
        .await
        .expect("browser /native/ws connect failed");
    browser_ws
        .send(TMsg::Text(r#"{"text":"hello-s3"}"#.to_string().into()))
        .await
        .unwrap();

    // Wait for stub to finish replying.
    let (_event, reply) = tokio::time::timeout(
        Duration::from_secs(5),
        stub_handle,
    )
    .await
    .expect("s3: timeout waiting for stub")
    .expect("s3: stub task panicked")
    .expect("s3: stub returned error");

    // Confirm the reply text has the echo prefix.
    assert!(
        reply.content.text.contains("hello-s3"),
        "s3: reply text must echo original text; got {:?}",
        reply.content.text
    );
    assert!(
        reply.content.text.contains("[bot0]"),
        "s3: reply text must have bot prefix; got {:?}",
        reply.content.text
    );

    // Browser must receive the push delivered by openabc.
    let pushed = loop {
        let msg = tokio::time::timeout(Duration::from_secs(3), browser_ws.next())
            .await
            .expect("s3: timeout waiting for push to browser")
            .expect("s3: browser ws stream ended")
            .expect("s3: browser ws error");
        if let TMsg::Text(t) = msg {
            break t.to_string();
        }
    };

    let v: serde_json::Value = serde_json::from_str(&pushed).expect("s3: push must be JSON");
    assert_eq!(v["type"], "message", "s3: push type must be `message`");
    let text = v["text"].as_str().unwrap_or("");
    assert!(text.contains("hello-s3"), "s3: browser push text must contain original echo");

    browser_ws.close(None).await.ok();
}

/// S4 + S5 — N>=2 stub bots each connect /ws and reply to the same conn_id;
/// browser receives N pushes, each with keys ⊆ {type,op,text}, texts mutually
/// distinct (per-bot seq prefix).
#[tokio::test]
async fn s4_s5_multi_bot_distinguishable() {
    const N: usize = 2;
    let port = spawn_full_app().await;
    let ws_url = format!("ws://127.0.0.1:{port}/ws");
    let browser_url = format!("ws://127.0.0.1:{port}/native/ws");

    // Spawn N stub bots — they all subscribe before the browser fires.
    let mut stub_handles = Vec::with_capacity(N);
    for i in 0..N {
        let url = ws_url.clone();
        stub_handles.push(tokio::spawn(async move {
            stub_core::run_stub_session(&url, i, None).await
        }));
    }

    tokio::time::sleep(Duration::from_millis(80)).await;

    // Browser connects and sends ONE message — all N bots receive it (broadcast).
    let (mut browser_ws, _) = connect_async(&browser_url)
        .await
        .expect("browser /native/ws connect failed");
    browser_ws
        .send(TMsg::Text(r#"{"text":"s4-probe"}"#.to_string().into()))
        .await
        .unwrap();

    // Wait for all stubs to finish.
    for (i, h) in stub_handles.into_iter().enumerate() {
        tokio::time::timeout(Duration::from_secs(5), h)
            .await
            .unwrap_or_else(|_| panic!("s4: timeout waiting for stub bot{i}"))
            .unwrap_or_else(|_| panic!("s4: stub bot{i} task panicked"))
            .unwrap_or_else(|e| panic!("s4: stub bot{i} error: {e}"));
    }

    // Collect N text pushes from the browser side.
    let mut pushes: Vec<serde_json::Value> = Vec::new();
    while pushes.len() < N {
        let msg = tokio::time::timeout(Duration::from_secs(4), browser_ws.next())
            .await
            .expect("s4: timeout waiting for push to browser")
            .expect("s4: browser ws stream ended")
            .expect("s4: browser ws error");
        if let TMsg::Text(t) = msg {
            let v: serde_json::Value = serde_json::from_str(&t).expect("s4: push must be JSON");
            pushes.push(v);
        }
    }

    // S4: every push must have keys ⊆ {type, op, text}.
    let allowed: std::collections::HashSet<&str> = ["type", "op", "text"].iter().copied().collect();
    for (i, push) in pushes.iter().enumerate() {
        let push_keys: std::collections::HashSet<&str> = push
            .as_object()
            .expect("s4: push must be a JSON object")
            .keys()
            .map(|k| k.as_str())
            .collect();
        let extra: Vec<&&str> = push_keys.difference(&allowed).collect();
        assert!(
            extra.is_empty(),
            "s4: push[{i}] has unexpected keys {extra:?} — must be ⊆ {{type,op,text}}"
        );
    }

    // S5: per-bot texts must be mutually distinct.
    let texts: Vec<&str> = pushes
        .iter()
        .map(|v| v["text"].as_str().unwrap_or(""))
        .collect();
    let unique: std::collections::HashSet<&&str> = texts.iter().collect();
    assert_eq!(
        unique.len(),
        N,
        "s5: reply texts must be mutually distinct (got: {texts:?})"
    );

    browser_ws.close(None).await.ok();
}
