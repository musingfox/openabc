# openabc

openabc 是 openab 的原生互動 UI gateway。願景是支援虛擬形象、語音與富媒體;目前是文字傳輸 MVP。

## 架構

openabc 是一個獨立的單一用途 gateway,走 openab.gateway 協定:

- `/ws` — openab core 連進來,收 `openab.gateway.event.v1` 事件、送 `openab.gateway.reply.v1` 回覆
- `/native` — 瀏覽器 UI(HTML)
- `/native/ws` — 瀏覽器 WebSocket 連線
- `/health` — 健康檢查

openabc 完全獨立,不依賴 openab 的任何 crate;協定 struct 直接 vendored 進來。

## 執行

```sh
cargo run
```

預設監聽 `127.0.0.1:8080`。瀏覽器開 `http://127.0.0.1:8080/native` 即可使用。

## 環境變數

| 變數 | 說明 | 預設 |
|------|------|------|
| `OPENABC_LISTEN` | 監聽位址 | `127.0.0.1:8080` |
| `OPENABC_WS_TOKEN` | `/ws` 連線 token(未設則免驗證,印 warn) | 無 |
