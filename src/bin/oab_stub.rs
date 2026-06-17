//! oab_stub — minimal openab stub dev-harness.
//!
//! Connects N `/ws` sessions to openabc, receives GatewayEvent, and echoes
//! GatewayReply back with a per-bot seq prefix.
//!
//! # Startup order
//!
//! 1. Start openabc first: `cargo run` (listens on `OPENABC_LISTEN`, default
//!    `127.0.0.1:8080`).
//! 2. Then run the stub: `cargo run --bin oab_stub`.
//!
//! # Environment variables
//!
//! | Variable           | Default           | Description                                      |
//! |--------------------|-------------------|--------------------------------------------------|
//! | `OAB_STUB_BOTS`    | `2`               | Number of persistent bot connections to open.    |
//! | `OPENABC_LISTEN`   | `127.0.0.1:8080`  | Host:port of the running openabc instance.       |
//! | `OPENABC_WS_TOKEN` | *(unset)*         | If set, appended as `?token=<value>` on `/ws`.   |
//!
//! The core logic is in `stub_core::run_stub_session` — directly callable
//! from integration tests without spawning a subprocess.

pub mod stub_core {
    use futures_util::{SinkExt, StreamExt};
    use openabc::schema::{Content, GatewayEvent, GatewayReply, ReplyChannel};
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

    /// Run N stub sessions concurrently against ws_url.
    /// Each session processes one GatewayEvent then echoes with "[botN] " prefix.
    /// Returns vec of (event, reply) per bot (first turn only).
    pub async fn run_multi_bot(
        ws_url: &str,
        n: usize,
    ) -> anyhow::Result<Vec<(GatewayEvent, GatewayReply)>> {
        let mut handles = Vec::with_capacity(n);
        for i in 0..n {
            let url = ws_url.to_string();
            handles.push(tokio::spawn(async move {
                run_stub_session(&url, i, Some(1), None).await
            }));
        }
        let mut results = Vec::with_capacity(n);
        for h in handles {
            let pairs = h.await??;
            let first = pairs.into_iter().next()
                .ok_or_else(|| anyhow::anyhow!("run_multi_bot: bot got no events"))?;
            results.push(first);
        }
        Ok(results)
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let listen = std::env::var("OPENABC_LISTEN").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let token = std::env::var("OPENABC_WS_TOKEN").ok();
    let ws_url = match &token {
        Some(t) => format!("ws://{listen}/ws?token={t}"),
        None => format!("ws://{listen}/ws"),
    };

    let n: usize = std::env::var("OAB_STUB_BOTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2);

    tracing::info!("oab_stub: connecting {n} persistent bots → {ws_url}");

    let mut join_set = tokio::task::JoinSet::new();

    for i in 0..n {
        let url = ws_url.clone();
        join_set.spawn(async move {
            let result = stub_core::run_stub_session(&url, i, None, None).await;
            (i, result)
        });
    }

    // Drain all bot handles; log each disconnection as it happens.
    // Also allow Ctrl-C to trigger a clean shutdown.
    loop {
        tokio::select! {
            maybe = join_set.join_next() => {
                match maybe {
                    None => {
                        // All bots done.
                        break;
                    }
                    Some(Ok((i, Ok(pairs)))) => {
                        tracing::warn!("bot{i} disconnected after {} turns", pairs.len());
                    }
                    Some(Ok((i, Err(e)))) => {
                        tracing::error!("bot{i} disconnected with error: {e}");
                    }
                    Some(Err(e)) => {
                        tracing::error!("bot task panicked: {e}");
                    }
                }
                if join_set.is_empty() {
                    break;
                }
            }
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("oab_stub: received ctrl_c, shutting down");
                join_set.abort_all();
                break;
            }
        }
    }

    tracing::warn!("all bots disconnected");
    std::process::exit(1);
}
