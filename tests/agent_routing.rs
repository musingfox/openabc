//! agent_routing — committed integration tests that pin the label-routing behavior
//! introduced in turn-34/35 into the SHIPPING test suite.
//!
//! E-RT-A-ONLY: browser sends {text,agent:"A"} → only A-stub receives+replies (B silent).
//! E-LBL-FOREVER: None-mode labeled bots survive a real 7s idle gap; each round is
//!                delivered to only the named agent.

use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::Message as TMsg};
use futures_util::{SinkExt, StreamExt};
use openabc::stub_core;

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

/// E-RT-A-ONLY: browser sends {text:"only-A",agent:"A"}.
/// A-stub (max_turns=Some(1)) receives+replies; B-stub (max_turns=Some(1)) stays silent.
/// Browser receives exactly ONE push (timeout on next is_err).
/// A pairs.len()==1 with text containing "[A]" and "only-A".
/// B pairs.is_empty().
#[tokio::test]
async fn e_rt_a_only() {
    let port = spawn_full_app().await;
    let ws_url = format!("ws://127.0.0.1:{port}/ws");
    let browser_url = format!("ws://127.0.0.1:{port}/native/ws");

    // Spawn stub A (max_turns=Some(1) → exits after receiving 1 qualifying event).
    let a_handle = tokio::spawn({
        let url = ws_url.clone();
        async move { stub_core::run_stub_labeled(&url, "A", Some(1)).await }
    });

    // Spawn stub B (max_turns=Some(1) → will timeout on 3s because nothing for B arrives).
    let b_handle = tokio::spawn({
        let url = ws_url.clone();
        async move { stub_core::run_stub_labeled(&url, "B", Some(1)).await }
    });

    // Brief settle so both stubs are subscribed before browser fires.
    tokio::time::sleep(Duration::from_millis(80)).await;

    // Browser connects and sends one message addressed only to agent A.
    let (mut browser_ws, _) = connect_async(&browser_url)
        .await
        .expect("e-rt-a-only: browser /native/ws connect failed");
    browser_ws
        .send(TMsg::Text(
            r#"{"text":"only-A","agent":"A"}"#.to_string().into(),
        ))
        .await
        .unwrap();

    // Browser must receive exactly ONE push.
    let first_push = loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), browser_ws.next())
            .await
            .expect("e-rt-a-only: timeout waiting for first push")
            .expect("e-rt-a-only: browser ws stream ended")
            .expect("e-rt-a-only: browser ws error");
        if let TMsg::Text(t) = msg {
            break t.to_string();
        }
    };

    // No second push should arrive within 800ms.
    let no_second = tokio::time::timeout(
        Duration::from_millis(800),
        async {
            loop {
                let msg = browser_ws.next().await;
                match msg {
                    Some(Ok(TMsg::Text(_))) => return true,
                    None => return false,
                    _ => continue,
                }
            }
        },
    )
    .await;
    assert!(
        no_second.is_err(),
        "e-rt-a-only: browser received a second push — B-stub must not reply to agent:A messages"
    );

    // First push must contain "only-A" and "[A]".
    let v: serde_json::Value =
        serde_json::from_str(&first_push).expect("e-rt-a-only: first push must be JSON");
    let text = v["text"].as_str().unwrap_or("");
    assert!(
        text.contains("only-A"),
        "e-rt-a-only: push text must contain 'only-A'; got {text:?}"
    );
    assert!(
        text.contains("[A]"),
        "e-rt-a-only: push text must contain '[A]' prefix; got {text:?}"
    );

    // A stub: must have exactly 1 pair.
    let a_pairs = tokio::time::timeout(Duration::from_secs(8), a_handle)
        .await
        .expect("e-rt-a-only: timeout waiting for A stub")
        .expect("e-rt-a-only: A stub task panicked")
        .expect("e-rt-a-only: A stub returned error");
    assert_eq!(
        a_pairs.len(),
        1,
        "e-rt-a-only: A-stub must record exactly 1 pair; got {}",
        a_pairs.len()
    );

    // B stub: must have 0 pairs (timed out waiting, returned empty).
    let b_pairs = tokio::time::timeout(Duration::from_secs(8), b_handle)
        .await
        .expect("e-rt-a-only: timeout waiting for B stub")
        .expect("e-rt-a-only: B stub task panicked")
        .expect("e-rt-a-only: B stub returned error");
    assert!(
        b_pairs.is_empty(),
        "e-rt-a-only: B-stub must record 0 pairs (B should not match agent:A); got {}",
        b_pairs.len()
    );

    browser_ws.close(None).await.ok();
}

/// E-LBL-FOREVER: A-stub and B-stub run in None mode (forever).
/// Round-A: send {text:"round-A",agent:"A"} → exactly 1 push ([A]/round-A), B silent.
/// Sleep 7s to cross the 5s idle threshold.
/// Both handles still alive.
/// Round-B: same connection sends {text:"round-B",agent:"B"} → exactly 1 push ([B]/round-B), A silent.
#[tokio::test]
async fn e_lbl_forever() {
    let port = spawn_full_app().await;
    let ws_url = format!("ws://127.0.0.1:{port}/ws");
    let browser_url = format!("ws://127.0.0.1:{port}/native/ws");

    // Spawn A and B in None mode (forever).
    let a_handle = tokio::spawn({
        let url = ws_url.clone();
        async move { stub_core::run_stub_labeled(&url, "A", None).await }
    });
    let b_handle = tokio::spawn({
        let url = ws_url.clone();
        async move { stub_core::run_stub_labeled(&url, "B", None).await }
    });

    tokio::time::sleep(Duration::from_millis(80)).await;

    // Browser connects once; keep the connection open across both rounds.
    let (mut browser_ws, _) = connect_async(&browser_url)
        .await
        .expect("e-lbl-forever: browser /native/ws connect failed");

    // ── Round A ──
    browser_ws
        .send(TMsg::Text(
            r#"{"text":"round-A","agent":"A"}"#.to_string().into(),
        ))
        .await
        .unwrap();

    // Exactly 1 push for round-A.
    let push_a = loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), browser_ws.next())
            .await
            .expect("e-lbl-forever: timeout waiting for round-A push")
            .expect("e-lbl-forever: browser ws stream ended during round-A")
            .expect("e-lbl-forever: browser ws error during round-A");
        if let TMsg::Text(t) = msg {
            break t.to_string();
        }
    };

    // B must not answer round-A.
    let no_b_for_a = tokio::time::timeout(
        Duration::from_millis(800),
        async {
            loop {
                let msg = browser_ws.next().await;
                match msg {
                    Some(Ok(TMsg::Text(_))) => return true,
                    None => return false,
                    _ => continue,
                }
            }
        },
    )
    .await;
    assert!(
        no_b_for_a.is_err(),
        "e-lbl-forever: B answered round-A — only A should reply to agent:A"
    );

    let v_a: serde_json::Value =
        serde_json::from_str(&push_a).expect("e-lbl-forever: round-A push must be JSON");
    let text_a = v_a["text"].as_str().unwrap_or("");
    assert!(
        text_a.contains("[A]"),
        "e-lbl-forever: round-A push must have [A] prefix; got {text_a:?}"
    );
    assert!(
        text_a.contains("round-A"),
        "e-lbl-forever: round-A push text must contain 'round-A'; got {text_a:?}"
    );

    // ── Idle gap: cross the 5s idle threshold ──
    tokio::time::sleep(Duration::from_secs(7)).await;

    // Both handles must still be alive.
    assert!(
        !a_handle.is_finished(),
        "e-lbl-forever: A-stub finished during 7s idle gap — None-mode must not exit on idle"
    );
    assert!(
        !b_handle.is_finished(),
        "e-lbl-forever: B-stub finished during 7s idle gap — None-mode must not exit on idle"
    );

    // ── Round B ──
    browser_ws
        .send(TMsg::Text(
            r#"{"text":"round-B","agent":"B"}"#.to_string().into(),
        ))
        .await
        .expect("e-lbl-forever: failed to send round-B on existing connection");

    // Exactly 1 push for round-B.
    let push_b = loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), browser_ws.next())
            .await
            .expect("e-lbl-forever: timeout waiting for round-B push")
            .expect("e-lbl-forever: browser ws stream ended during round-B")
            .expect("e-lbl-forever: browser ws error during round-B");
        if let TMsg::Text(t) = msg {
            break t.to_string();
        }
    };

    // A must not answer round-B.
    let no_a_for_b = tokio::time::timeout(
        Duration::from_millis(800),
        async {
            loop {
                let msg = browser_ws.next().await;
                match msg {
                    Some(Ok(TMsg::Text(_))) => return true,
                    None => return false,
                    _ => continue,
                }
            }
        },
    )
    .await;
    assert!(
        no_a_for_b.is_err(),
        "e-lbl-forever: A answered round-B — only B should reply to agent:B"
    );

    let v_b: serde_json::Value =
        serde_json::from_str(&push_b).expect("e-lbl-forever: round-B push must be JSON");
    let text_b = v_b["text"].as_str().unwrap_or("");
    assert!(
        text_b.contains("[B]"),
        "e-lbl-forever: round-B push must have [B] prefix; got {text_b:?}"
    );
    assert!(
        text_b.contains("round-B"),
        "e-lbl-forever: round-B push text must contain 'round-B'; got {text_b:?}"
    );
    assert!(
        !text_b.contains("round-A"),
        "e-lbl-forever: round-B push must NOT contain 'round-A'; got {text_b:?}"
    );

    // Clean up.
    a_handle.abort();
    b_handle.abort();
    browser_ws.close(None).await.ok();
}
