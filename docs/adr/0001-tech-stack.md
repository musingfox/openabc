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

綜合「低資源 + 生動」目標:選 **Svelte**。Svelte 無執行時框架、bundle 最小、DOM 更新直接編譯為命令式操作;avatar 本輪以 sprite/圖片狀態實作,由 Svelte 元件直接切換 `<img>` src,不引入額外畫布 runtime。WebAssembly 路線保留為後續考量,待 wasm 生態成熟度與 bundle 最佳化提升後可遷移。

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

三類候選,依最終選定(sprite/圖片狀態)→ 已評估替代 → 未來升級路徑排列:

- **sprite/圖片狀態(選定)**
  - 取捨:以一組靜態圖片(WebP/PNG)代表人物不同狀態,runtime 為純 DOM `<img>` 切換或 CSS background-position,無額外 JS runtime、零 WebGL context 開銷;實作最簡單,資源耗用最低。代價是無法做骨骼插值或連續幀動畫,情緒表達粒度較粗。適合早期 RPG 式呈現,本輪選定。
- **Lottie(JSON 向量動畫)(已評估替代方案,未來升級路徑)**
  - 取捨:設計師友好、體積小(典型 < 200 KB JSON)、CPU 渲染,可做情緒插值與關鍵幀動畫;幀率受限於 JS 執行緒,需引入 lottie-web (~70 KB) runtime。適合呈現細膩表情動畫,待動畫需求提升時可替換 sprite。
- **PixiJS/Spine 骨骼動畫(已評估替代方案,未來升級路徑)**
  - 取捨:骨骼動畫 GPU 加速、即時姿態混合;PixiJS runtime ~280 KB + Spine runtime ~500 KB,需 WebGL context(~20-40 MB GPU texture)。適合高生動度 avatar,待硬體需求明確且動畫需求複雜化後引入。

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
| Svelte(前端框架) | bundle gzip 體積(JS+CSS) | 13 KB gzip(spike 實測)(實測);vs React ~140 KB(估計);無執行時 |
| sprite/圖片狀態(avatar) | bundle 額外體積 / RAM | 僅 PNG/WebP 圖片,無 JS runtime 額外開銷(實測);向量動畫替代方案需 +70 KB runtime(估計),骨骼動畫替代方案需 +280 KB 以上(估計) |
| WebSocket(傳輸) | index.html TTFB(本機) | < 5 ms(本機實測)(實測);frame header 2-14 bytes(vs HTTP 1-2 KB headers/req)(估計) |
| Opus(語音) | bandwidth | 24 kbps 語音品質可接受(估計);MP3 64-128 kbps 同品質(估計) |
| WebP/AVIF(圖片) | binary size | AVIF 比 JPEG 小 ~50%(估計);WebP 比 PNG 小 ~25-35%(估計) |

Rust 後端(axum + tokio):非同步零成本抽象,idle RSS 3 MB(spike 實測)(實測),binary ~5-8 MB stripped(估計)。

---

## 選定

- 前端渲染層:Svelte(web 瀏覽器,avatar 由 Svelte 元件直接切換 `<img>` sprite)
- 後端傳輸:WebSocket(axum 0.8 內建,tokio-tungstenite;WebRTC 列為即時語音後續選項)
- 媒體編解碼:sprite/圖片狀態(avatar,純 DOM `<img>`/CSS,無額外 runtime)+ Opus(語音)+ WebP/AVIF(圖片)
- 資源耗用評估:Svelte bundle 13 KB gzip(spike 實測)/ WebSocket frame overhead < 14 bytes / Opus 24 kbps / 後端 idle RSS 3 MB(spike 實測)
