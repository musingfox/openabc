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
//! | Variable           | Default           | Description                                                  |
//! |--------------------|-------------------|--------------------------------------------------------------|
//! | `OAB_STUB_BOTS`    | `2`               | Number of persistent bot connections to open.                |
//! | `OAB_STUB_LABEL`   | *(unset)*         | If set, each spawned bot runs as a labeled agent (e.g. "A"); |
//! |                    |                   | routes only events where target_agent == label. Unset →      |
//! |                    |                   | legacy run_stub_session (processes all events).              |
//! | `OPENABC_LISTEN`   | `127.0.0.1:8080`  | Host:port of the running openabc instance.                   |
//! | `OPENABC_WS_TOKEN` | *(unset)*         | If set, appended as `?token=<value>` on `/ws`.               |
//!
//! The core logic lives in `openabc::stub_core::run_stub_session` and
//! `openabc::stub_core::run_stub_labeled` — directly callable from integration
//! tests without spawning a subprocess.

use openabc::stub_core;

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

    let label = std::env::var("OAB_STUB_LABEL").ok();

    match &label {
        Some(lbl) => tracing::info!("oab_stub: connecting {n} persistent labeled bots (label={lbl:?}) → {ws_url}"),
        None => tracing::info!("oab_stub: connecting {n} persistent bots → {ws_url}"),
    }

    let mut join_set = tokio::task::JoinSet::new();

    for i in 0..n {
        let url = ws_url.clone();
        let bot_label = label.clone();
        join_set.spawn(async move {
            let result = if let Some(lbl) = bot_label {
                stub_core::run_stub_labeled(&url, &lbl, None)
                    .await
                    .map(|pairs| (i, pairs))
            } else {
                stub_core::run_stub_session(&url, i, None, None)
                    .await
                    .map(|pairs| (i, pairs))
            };
            result
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
                    Some(Ok(Ok((i, pairs)))) => {
                        tracing::warn!("bot{i} disconnected after {} turns", pairs.len());
                    }
                    Some(Ok(Err(e))) => {
                        tracing::error!("bot disconnected with error: {e}");
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
