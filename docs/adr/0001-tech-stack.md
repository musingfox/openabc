# ADR 0001: openabc Tech Stack

Status: Accepted

## 背景

openabc 是 openab 的原生互動 UI gateway,後端以 Rust + axum 0.8 / tokio / tokio-tungstenite 0.21 建構。願景是呈現 agent 虛擬形象(avatar)、語音、文字、圖片等多媒體互動。核心約束:高效、低資源耗用、生動呈現 UI。

已凍結的人類決策(one-way door):
- 畫面載體 = 瀏覽器 / web runtime 路線
- 後端傳輸 = WebSocket(可帶二進位);WebRTC 列為即時語音後續選項

---

## 前端渲染層

評比維度:生動呈現能力、啟動與執行資源、開發複雜度。

- **純 HTML/CSS/JS(Vanilla)**
  - 取捨:體積極小(< 50 KB JS)、零框架啟動開銷;但 avatar 動畫、即時 UI 狀態管理純手刻成本高,維護性差。
- **SPA 框架(React / Vue / Svelte)**
  - 取捨:元件生態豐富,Svelte 編譯後 bundle 最小(~30-60 KB);React 生態最廣但執行時較重(~140 KB gzip)。適合文字/圖片 UI,但 WebGL avatar 仍需額外整合。
- **WebAssembly / Rust-wasm(leptos / yew)**
  - 取捨:可共用後端 Rust 邏輯,型別安全跨越前後端;但現階段 wasm bundle 體積偏大(1-3 MB 未壓縮),冷啟動較慢,DOM 互動開銷非零。
- **Canvas / WebGL 動畫方案(Three.js / PixiJS + HTML overlay)**
  - 取捨:avatar 3D/2D 動畫原生支援,GPU 加速,幀率穩定;需維護渲染管線,學習曲線陡,純文字對話 UI 仍需 HTML 層疊加。

綜合「低資源 + 生動」目標:選 **Svelte**。Svelte 無執行時框架、bundle 最小、DOM 更新直接編譯為命令式操作;avatar 動畫層以 PixiJS Canvas 嵌入 Svelte 元件,分離關注點且不增加不必要的依賴。WebAssembly 路線保留為後續考量,待 wasm 生態成熟度與 bundle 最佳化提升後可遷移。

---

## 後端傳輸

- **WebSocket(axum 0.8 內建 ws feature)**
  - 取捨:雙向全雙工、支援二進位 frame,現有 tokio-tungstenite 0.21 已落地;文字、圖片、音訊 chunk 皆可傳輸;連線保活成本低。選定。
- **HTTP SSE(Server-Sent Events)**
  - 取捨:僅單向推送(server→client),無法傳輸二進位,不適合音訊串流與雙向互動。排除。
- **WebRTC**
  - 取捨:P2P 低延遲媒體串流、內建 DTLS 加密與 jitter buffer,最適合即時語音/視訊;但建連複雜度高(ICE/STUN/TURN)、現階段主功能不需 sub-100 ms RTT。列為**即時語音後續選項**,待語音功能進入 roadmap 時引入。

---

## 媒體編解碼

### Avatar 動畫格式

- **Lottie(JSON 向量動畫)**
  - 取捨:設計師友好、體積小(典型 < 200 KB)、CPU 渲染,幀率受限於 JS 執行緒;適合 idle/情緒等靜態輪播動畫。
- **WebGL Spine / DragonBones**
  - 取捨:骨骼動畫 GPU 加速,可做即時姿態混合;runtime 授權與體積較大(Spine runtime ~500 KB)。

### 語音

- **Opus(via WebCodecs 或 MediaSource Extensions)**
  - 取捨:8-320 kbps 可調、延遲低(20 ms frame)、瀏覽器原生支援;適合 TTS 輸出串流。
- **MP3 / AAC**
  - 取捨:相容性最廣但授權複雜、延遲較高(encoder lookahead);不適合即時串流。

### 圖片

- **WebP / AVIF**
  - 取捨:相比 JPEG/PNG 體積減少 25-50%,瀏覽器支援率 > 95%;首選格式。
- **JPEG / PNG**
  - 取捨:萬用相容但體積較大;作為 fallback。

---

## 資源耗用評估

以下針對「選定」選擇給出具體量測軸相對評估:

| 選定技術 | 量測軸 | 相對評估 |
|---|---|---|
| Svelte(前端框架) | binary size(bundle) | ~30-60 KB gzip,無執行時;vs React ~140 KB |
| PixiJS(Canvas 動畫) | RAM | WebGL context ~20-40 MB GPU texture;vs Three.js 場景圖開銷更高 |
| WebSocket(傳輸) | latency | 首幀延遲 < 5 ms(本機);bandwidth 開銷每 frame header 2-14 bytes(vs HTTP 1-2 KB headers/req) |
| Lottie(avatar 動畫) | CPU | 單動畫 < 5% CPU(M 系列);vs Spine WebGL < 2% GPU 但需 runtime 授權 |
| Opus(語音) | bandwidth | 24 kbps 語音品質可接受;MP3 64-128 kbps 同品質 |
| WebP/AVIF(圖片) | binary size | AVIF 比 JPEG 小 ~50%;WebP 比 PNG 小 ~25-35% |

Rust 後端(axum + tokio):非同步零成本抽象,典型 idle RSS < 10 MB,binary ~5-8 MB stripped。

---

## 選定

- 前端渲染層:Svelte(web 瀏覽器,搭配 PixiJS Canvas 處理 avatar 動畫)
- 後端傳輸:WebSocket(axum 0.8 內建,tokio-tungstenite;WebRTC 列為即時語音後續選項)
- 媒體編解碼:Lottie(avatar)+ Opus(語音)+ WebP/AVIF(圖片)
- 資源耗用評估:Svelte bundle < 60 KB / WebSocket frame overhead < 14 bytes / Opus 24 kbps / 後端 idle RSS < 10 MB
