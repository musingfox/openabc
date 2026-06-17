//! Core logic for the `oab_stub` dev-harness: one persistent stub bot session.
//!
//! Lives in the library (not inside `src/bin/oab_stub.rs`) so both the binary
//! and the integration tests consume it from `openabc::stub_core` — no
//! `#[path]` include of the binary (which would drag `fn main` into the test
//! crate and warn).

use crate::schema::{Content, GatewayEvent, GatewayReply, ReplyChannel};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message as TMsg};

/// One stub bot session: connect to ws_url, process GatewayEvents and echo
/// GatewayReply back for each one.
///
/// - `max_turns`: `None` = loop forever; on an idle timeout (no frame for 5s)
///   the loop continues waiting for the next frame. The session only ends when
///   the connection is closed by the peer (`Ok(None)`) or a connection error
///   occurs. `Some(k)` = process exactly k events then close and return; a
///   timeout while waiting for the k-th event is treated as an error.
///
/// Returns a `Vec<(GatewayEvent, GatewayReply)>` of all event/reply pairs
/// recorded during the session (in order).
///
/// `bot_index` drives the distinguishing prefix in reply text.
/// `reply_text_fn` maps (bot_index, original_event_text) → reply text;
/// pass `None` to use the default "[botN] <echo>" format.
pub async fn run_stub_session(
    ws_url: &str,
    bot_index: usize,
    max_turns: Option<usize>,
    reply_text_fn: Option<&(dyn Fn(usize, &str) -> String + Send + Sync)>,
) -> anyhow::Result<Vec<(GatewayEvent, GatewayReply)>> {
    let (mut ws, _) = connect_async(ws_url)
        .await
        .map_err(|e| anyhow::anyhow!("stub bot{bot_index} connect failed: {e}"))?;

    let mut results = Vec::new();

    loop {
        if let Some(k) = max_turns {
            if results.len() >= k {
                break;
            }
        }

        // Receive until we get a text GatewayEvent.
        let event: GatewayEvent = loop {
            let next = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                ws.next(),
            )
            .await;

            match next {
                Err(_elapsed) => {
                    // Idle timeout waiting for next frame.
                    if max_turns.is_none() {
                        // In forever mode, an idle timeout is normal — keep waiting.
                        continue;
                    } else {
                        return Err(anyhow::anyhow!(
                            "bot{bot_index}: timeout waiting for GatewayEvent (turn {})",
                            results.len() + 1
                        ));
                    }
                }
                Ok(None) => {
                    // Connection closed by peer.
                    return Ok(results);
                }
                Ok(Some(Err(e))) => {
                    if max_turns.is_none() {
                        // Forever mode: connection error = session done.
                        return Ok(results);
                    } else {
                        return Err(anyhow::anyhow!("bot{bot_index}: ws error: {e}"));
                    }
                }
                Ok(Some(Ok(TMsg::Text(t)))) => {
                    let ev: GatewayEvent = serde_json::from_str(&t)
                        .map_err(|e| anyhow::anyhow!("bot{bot_index}: bad event JSON: {e}"))?;
                    break ev;
                }
                Ok(Some(Ok(_other))) => {
                    // Non-text frame; ignore and keep reading.
                    continue;
                }
            }
        };

        let conn_id = event.channel.id.clone();
        let echo_text = match reply_text_fn {
            Some(f) => f(bot_index, &event.content.text),
            None => format!("[bot{bot_index}] {}", event.content.text),
        };

        let reply = GatewayReply {
            schema: "openab.gateway.reply.v1".into(),
            reply_to: event.event_id.clone(),
            platform: "native".into(),
            channel: ReplyChannel { id: conn_id, thread_id: None },
            content: Content {
                content_type: "text".into(),
                text: echo_text,
                attachments: vec![],
            },
            command: None,
            request_id: None,
            quote_message_id: None,
        };

        ws.send(TMsg::Text(serde_json::to_string(&reply)?.into()))
            .await
            .map_err(|e| anyhow::anyhow!("bot{bot_index}: send reply failed: {e}"))?;

        results.push((event, reply));
    }

    ws.close(None).await.ok();
    Ok(results)
}
