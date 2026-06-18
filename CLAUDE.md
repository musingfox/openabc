# CLAUDE.md

This file gives coding agents the current working contract for this repository.

## What this is

openabc is openab's native interactive UI gateway. It speaks the `openab.gateway` protocol and currently ships a text-first browser UI with multi-channel routing, rich-message rendering, and a local `oab_stub` harness.

This repository is deliberately standalone. It does **not** depend on any openab crate; protocol structs are vendored in `src/schema.rs`. Treat `GatewayEvent`, `GatewayReply`, serde field names, and schema strings as an implicit contract with openab core.

## Commands

```sh
cargo run                                      # start openabc; default 127.0.0.1:8080
cargo run --bin oab_stub                       # local openab-core echo harness
cargo test                                     # all Rust unit + integration tests
cargo test --test native_integration           # native UI/WS integration coverage
cargo test --test oab_stub_harness             # stub harness coverage
cargo test --test agent_routing                # target_agent routing coverage
cargo test --lib w2_senders_keyed_by_conn_only -- --exact
cargo build

cd frontend && bun run build                   # rebuild embedded frontend/dist assets
cd frontend && bun test                        # JS/Svelte helper tests
```

Rust embeds `frontend/dist` with `include_bytes!`; if `frontend/src` changes, rebuild the frontend before relying on `cargo build` or runtime UI behavior.

## Environment variables

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `OPENABC_LISTEN` | server, stub | `127.0.0.1:8080` | Host:port for openabc. |
| `OPENABC_WS_TOKEN` | server, stub | unset | `/ws` token. Unset means `/ws` auth is skipped and a warning is logged. |
| `OAB_STUB_BOTS` | stub only | `2` | Number of persistent stub bot WebSocket sessions. |
| `OAB_STUB_LABEL` | stub only | unset | If set, stub bots only process events whose `target_agent` matches the label; unset keeps legacy broadcast behavior. |

Integration tests clear `OPENABC_WS_TOKEN`, bind `127.0.0.1:0`, and drive a real axum server through `reqwest` and `tokio_tungstenite`. Ephemeral ports allow parallel test execution.

## Architecture

Two WebSocket boundaries are bridged by one broadcast channel and one native sender table:

```text
browser channel ──/native/ws──> [native adapter] ──event_tx(broadcast)──> [/ws handler] ──> openab core/stub
browser channel <─/native/ws── [native adapter] <──native_senders(mpsc)── [/ws handler] <── openab core/stub
```

Key state:

- `event_tx: broadcast::Sender<String>` in `AppState` is inbound browser-to-core transport. Each browser message becomes a `GatewayEvent` JSON frame.
- `native_senders: Arc<Mutex<HashMap<conn_id, mpsc::Sender<String>>>>` routes outbound replies. `GatewayReply.channel.id` must match the browser connection's `conn_id`.
- `GatewayEvent.channel.id`, `GatewayEvent.sender.id`, and `GatewayReply.channel.id` are the same connection id for native channels.
- `GatewayEvent.target_agent` is optional. Frontend channels can send `{ text, agent }`; `oab_stub` uses `OAB_STUB_LABEL` to filter by `target_agent`.
- Outbound browser pushes are intentionally small: message/reaction payloads are shaped in `src/native.rs`; no bot attribution is carried to the browser today.

## File responsibilities

- `src/main.rs` — binary entry point: tracing, `OPENABC_LISTEN`, `build_app()`, `axum::serve`.
- `src/lib.rs` — `AppState`, `/ws` openab-core handler, `/health`, router assembly, and reply dispatch to native platform.
- `src/native.rs` — native adapter routes: `/native`, `/native/ws`, `/assets/*path`; embedded `frontend/dist`; browser connection ids; inbound event construction; outbound reply push.
- `src/schema.rs` — vendored `openab.gateway.event.v1` and `openab.gateway.reply.v1` structs. Keep field names and serde renames aligned with openab core.
- `src/stub_core.rs` — reusable stub sessions for tests and the dev harness; supports legacy broadcast and label-filtered bots.
- `src/bin/oab_stub.rs` — CLI dev harness that opens one or more `/ws` sessions and echoes replies.
- `frontend/src/App.svelte` — Svelte UI: channel sidebar, per-channel WebSockets, optional agent id input, reconnect state, streaming reveal, Mermaid rendering.
- `frontend/src/channels.js` — pure multi-channel store; one channel equals one `/native/ws` connection.
- `frontend/src/avatar.js` — rich text rendering, sanitization, KaTeX/highlight/Mermaid helpers, avatar state helpers.
- `frontend/vite.config.js` — fixed asset names and single JS chunk so Rust's embedded asset whitelist stays valid.
- `tests/native_integration.rs` — full server/browser/core WebSocket integration tests.
- `tests/oab_stub_harness.rs` — stub harness and multi-bot behavior tests.
- `tests/agent_routing.rs` — `target_agent` routing tests.

## Change rules

- Match the existing protocol before inventing fields. Schema drift breaks openab core even when this crate compiles.
- Do not add compatibility shims for renamed protocol fields; update all call sites and tests in one cutover.
- If frontend source changes, rebuild `frontend/dist` and keep Vite output paths compatible with `src/native.rs`.
- If native routing changes, cover it with a real WebSocket integration test, not only a unit test.
- If multi-agent routing changes, update both Rust routing tests and `frontend/src/channels.test.js`.
- Keep the gateway standalone unless the project explicitly decides to import openab crates.
