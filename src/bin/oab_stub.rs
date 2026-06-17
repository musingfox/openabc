//! oab_stub — minimal openab stub dev-harness.
//!
//! Connects N /ws sessions to openabc, receives GatewayEvent, and echoes
//! GatewayReply back with a per-bot seq prefix.
//!
//! The core logic is in `stub_core::run_stub_session` — directly callable
//! from integration tests without spawning a subprocess.

pub mod stub_core {
    use futures_util::{SinkExt, StreamExt};
    use openabc::schema::{Content, GatewayEvent, GatewayReply, ReplyChannel};
    use tokio_tungstenite::{connect_async, tungstenite::Message as TMsg};

    /// One stub bot session: connect to ws_url, receive one GatewayEvent,
    /// send one GatewayReply, then return the event received and the reply sent.
    ///
    /// `bot_index` drives the distinguishing prefix in reply text.
    /// `reply_text_fn` maps (bot_index, original_event_text) → reply text;
    /// pass `None` to use the default "[botN] <echo>" format.
    pub async fn run_stub_session(
        ws_url: &str,
        bot_index: usize,
        reply_text_fn: Option<&(dyn Fn(usize, &str) -> String + Send + Sync)>,
    ) -> anyhow::Result<(GatewayEvent, GatewayReply)> {
        let (mut ws, _) = connect_async(ws_url)
            .await
            .map_err(|e| anyhow::anyhow!("stub bot{bot_index} connect failed: {e}"))?;

        // Receive until we get a text GatewayEvent.
        let event: GatewayEvent = loop {
            let msg = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                ws.next(),
            )
            .await
            .map_err(|_| anyhow::anyhow!("bot{bot_index}: timeout waiting for GatewayEvent"))?
            .ok_or_else(|| anyhow::anyhow!("bot{bot_index}: ws stream ended before event"))?
            .map_err(|e| anyhow::anyhow!("bot{bot_index}: ws error: {e}"))?;

            if let TMsg::Text(t) = msg {
                let ev: GatewayEvent = serde_json::from_str(&t)
                    .map_err(|e| anyhow::anyhow!("bot{bot_index}: bad event JSON: {e}"))?;
                break ev;
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

        ws.close(None).await.ok();
        Ok((event, reply))
    }

    /// Run N stub sessions concurrently against ws_url.
    /// Each session waits for one GatewayEvent then echoes with "[botN] " prefix.
    /// Returns vec of (event, reply) in bot-index order.
    pub async fn run_multi_bot(
        ws_url: &str,
        n: usize,
    ) -> anyhow::Result<Vec<(GatewayEvent, GatewayReply)>> {
        let mut handles = Vec::with_capacity(n);
        for i in 0..n {
            let url = ws_url.to_string();
            handles.push(tokio::spawn(async move {
                run_stub_session(&url, i, None).await
            }));
        }
        let mut results = Vec::with_capacity(n);
        for h in handles {
            results.push(h.await??);
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

    tracing::info!("oab_stub: connecting {n} bots → {ws_url}");

    // Spawn N concurrent bot sessions; each blocks until one event arrives.
    let mut handles = Vec::with_capacity(n);
    for i in 0..n {
        let url = ws_url.clone();
        handles.push(tokio::spawn(async move {
            match stub_core::run_stub_session(&url, i, None).await {
                Ok((ev, reply)) => {
                    println!(
                        "[bot{i}] received event channel={} text={:?}; replied text={:?}",
                        ev.channel.id, ev.content.text, reply.content.text
                    );
                }
                Err(e) => eprintln!("[bot{i}] error: {e}"),
            }
        }));
    }
    for h in handles {
        h.await.ok();
    }
    Ok(())
}
