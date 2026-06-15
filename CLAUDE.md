# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

openabc is openab's native interactive UI gateway, speaking the `openab.gateway` protocol. The vision is to present an agent's avatar, voice, text, and image multimedia interaction; the current state is a **text-transport MVP**.

It is deliberately a **standalone single-purpose gateway**: it does not depend on any openab crate; the protocol structs are vendored directly into `src/schema.rs`. When changing the protocol types, be aware this is an implicit contract with openab core — field names (including serde renames) must stay aligned with the openab side.

## Commands

```sh
cargo run                                   # start; defaults to 127.0.0.1:8080
cargo test                                  # all tests (unit + integration)
cargo test --test native_integration        # integration tests only
cargo test inbound_text_produces            # single test (name substring match)
cargo build
```

Integration tests call `std::env::remove_var("OPENABC_WS_TOKEN")`, bind `127.0.0.1:0`, and spin up a real server driven by `reqwest` (HTTP) + `tokio_tungstenite` (WS). Because every test uses an ephemeral port, tests run in parallel.

Environment variables: `OPENABC_LISTEN` (default `127.0.0.1:8080`); `OPENABC_WS_TOKEN` (`/ws` connection token — if unset, auth is skipped and a warn is printed).

## Architecture

Two WebSocket boundaries bridged by a single broadcast channel. This is the core of understanding the whole system:

```
browser ──/native/ws──> [native adapter] ──event_tx(broadcast)──> [/ws handler] ──> openab core
browser <─/native/ws── [native adapter] <──native_senders(mpsc)── [/ws handler] <── openab core
```

- **`event_tx`** (`broadcast::Sender<String>`, held in `AppState`): the inbound direction. The native adapter turns a browser message into `GatewayEvent` JSON and broadcasts it; the `/ws` handler's send_task `subscribe()`s and forwards to openab core.
- **`native_senders`** (`Arc<Mutex<HashMap<conn_id, mpsc::Sender>>>`): the outbound routing table. Each browser connection generates a `conn_id` (uuid) at connect time and registers an mpsc sender. A `GatewayReply` from openab core is routed by `channel.id == conn_id` to the target connection, pushing only to that one tab.

Key invariant: `GatewayEvent.channel.id`, `GatewayEvent.sender.id`, and `GatewayReply.channel.id` are all the same `conn_id`. Outbound routing relies entirely on this id mapping. The integration test `connect_browser_and_get_conn_id` validates the round-trip by reading the conn_id off the OAB-side event.

### File responsibilities

- `src/lib.rs` — `AppState`, the `/ws` handler (openab core connects in), `/health`, and `build_app()` which assembles the router. Replies are dispatched by `platform`; currently only the `"native"` branch exists.
- `src/native.rs` — the native adapter: `/native` (inline HTML UI), `/native/ws` (browser connections), `dispatch_reply` (outbound push), and the `router()` factory. Unit tests live in `mod tests` at the bottom of the file.
- `src/schema.rs` — vendored protocol types: `GatewayEvent` (`openab.gateway.event.v1`), `GatewayReply` (`openab.gateway.reply.v1`), and their nested types.
- `src/main.rs` — entry point: tracing init, read `OPENABC_LISTEN`, `build_app()`, `axum::serve`.

### Adding a platform / media form

To support a new presentation form (voice, image, avatar), the usual path is: extend the `Content`/`Attachment` types in `schema.rs` → add a platform branch in the `lib.rs` reply dispatch, or handle the new content type in the native adapter → update the browser-side JS embedded in `src/native.rs` accordingly. The browser UI is currently hardcoded as a string literal in `ui_handler()`.
