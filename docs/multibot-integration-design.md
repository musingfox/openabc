# Multi-Bot Integration Design

## 本輪不改

openabc 本輪不改 schema.rs/dispatch 運作行為。本文件為設計評估書,不含任何 src/schema.rs 或 src/native.rs 的改動。

---

## 章節1 — 四面牆(當前協定障礙)

以下四道牆阻礙多 bot 場景的正確運作:

### wall-reply-no-bot-id

`GatewayReply` 協定不攜帶任何 bot 身分欄位。openab core 送出的 reply 只有 `channel.id`(conn_id)、`platform`、`content` 等欄,沒有 `bot_id`、`agent_id` 或任何 sender 身分識別。瀏覽器收到 push 後無法判斷是哪個 bot 產生的回覆。

見 `gateway.rs:77-92`:`GatewayReply` struct 定義無任何來源 bot 欄位(無 `sender`、無 `source`、無 `bot_id`)。

### wall-merge-unattributable

多個 bot(多條 OAB `/ws` 連線)對同一 conn_id 各發一則 reply,openabc 的 `dispatch_reply` 將它們合流推送至同一瀏覽器連線。每則 push 的鍵集合為 `{type, op, text}`,不含任何來源識別。合流後不可歸屬——瀏覽器無法分辨哪則訊息來自哪個 bot。

撞鍵問題:多 bot 回覆同一 event 時,`reply_to`(= `origin_event_id`)共用同值——因為所有 bot 均回應同一原始事件,這是 reply 合流的核心撞鍵點。
(另注:各 adapter 各自生成唯一的 `request_id`,互不相同,不是多 bot 合流的衝突根因。)

### wall-no-bot-to-bot

native adapter 將所有入站訊息標記為 `is_bot: false`,並透過 `event_tx`(broadcast)單一呼叫點送往 openab core。不存在任何 bot 對 bot 的專屬通道——一個 bot 無法透過 native gateway 直接定址另一個 bot。

### wall-conn-id-only-addressing

outbound 路由鍵僅為 `conn_id`(`NativeSenders` 是 `HashMap<String, mpsc::Sender>`)。當多個 bot 回覆同一 conn_id 時,它們共享同一個 `mpsc::Sender`。回程僅 conn_id 定址,無法以 `(conn_id, bot_id)` 複合鍵區分目標,也無法將 reply 路由至指定 bot 的瀏覽器端。

---

## 章節2 — openab prior art

### openab 的設計

openab core 本身已具備部分多 bot 基礎:

- **`trusted_bot_ids`**:inbound 辨識機制。gateway 以 `is_bot` flag 搭配 `trusted_bot_ids` 白名單判斷事件來自 bot 還是真人用戶。
- **`BotTurnTracker`**:防止 bot 對 bot 的迴圈。agent core 中轉 bot↔bot 訊息時,`BotTurnTracker` 追蹤輪次並在偵測到循環時中斷,避免無限迴圈。
- **`platform`**:outbound 路由機制。openab gateway 以 reply 的 `platform` 欄位決定送往哪個 adapter(參考 `openab/gateway/src/main.rs:132`)。

### openab 架構特性

openab 設計為一 process 一 bot 一平台:每個 openab process 代表一個 agent,outbound 靠 platform 路由至對應 adapter,inbound 以 `is_bot + trusted_bot_ids` 辨識來源,bot↔bot 訊息經 agent core 中轉並由 `BotTurnTracker` 防迴圈。

### 為何技巧在 openabc 失效

openabc 單 process 同平台多 bot 故技巧失效:openab 的 `trusted_bot_ids`、`BotTurnTracker`、`platform` 路由等機制均假設單一 bot-per-process 模型。當 openabc 以單 process 同時橋接多個 OAB `/ws` 連線(多 bot)時,這些機制無法區分不同 bot 的 reply,導致上述四道牆的問題。

---

## 章節3 — 三方案(依 openab 改動成本排序)

### option-zero-change

標記:`INFEASIBLE`

**door**: 不適用(不可行)

| 屬性 | 內容 |
|------|------|
| openab 改動量 | 0(零改動假設) |
| door | INFEASIBLE |
| openabc 端工作 | 0 |

**INFEASIBLE 證據**:

- `gateway.rs:77-92`:`GatewayReply` struct 定義無任何來源 bot 欄位——reply 本身不攜帶 sender/source/bot_id,openabc 端無從獲得來源歸屬。
- `gateway.rs:174-188`:`send_gateway_reply` 建構時設 `reply_to=origin_event_id`,無任何來源 bot 標記。多 bot 回同一 event 時,`reply_to` 共用同一 `origin_event_id`——此為 reply 合流的撞鍵根因,無 agent 標籤可區分。
  (建構時亦含 `request_id=req_uuid`,但各 adapter 各自生成唯一值,互不相同,非合流衝突來源。)
- `gateway.rs:869`:`other_bot_present: false` 硬寫,且有 `TODO multibot detection` 標記——多 bot 偵測尚未實作,無法靠現有邏輯自動處理。

零改動方案在當前協定狀態下結構性不可行。

---

### option-receiver-id

標記:`不適用/不可行`

| 屬性 | 內容 |
|------|------|
| openab 改動量 | 不適用——receiver_id 語意不符 |
| door | 不適用 |
| openabc 端工作 | 不適用 |

**誠實說明:receiver_id 是 inbound recipient 語意,不適用於 reply 來源歸屬**

`gateway.rs:699` 出現的 `receiver_id: None` 屬於 `SenderContext`(`openab.sender.v1` schema),位於 inbound 路徑(event → agent dispatcher 的 sender metadata)。其語意為「此 event 的預期接收者(recipient)是誰」,描述的是 inbound event 的目標,而非 outbound reply 的發話來源。

先前分析誤將此欄視為可傳遞至 reply 路徑的 bot 身分識別,根因有二:

1. 混淆了 `openab/gateway/src/main.rs`(openab gateway server binary,處理 platform 路由)與 `openab/src/gateway.rs`(core client 邏輯,建構 GatewayReply)。
2. 把 inbound SenderContext 的 `receiver_id` 當成 outbound GatewayReply 可攜帶的來源欄——但 `GatewayReply`(見 `gateway.rs:77-92`)根本不含此欄,`send_gateway_reply`(見 `gateway.rs:174-188`)建構時亦無填入任何來源標記。

結論:`receiver_id` 是 inbound recipient 語意,【不適用】於 reply 來源歸屬問題。此方向為誤判,降級為不可行。

---

### option-reply-source-field

標記:`one-way` | **事實正解**

| 屬性 | 內容 |
|------|------|
| openab 改動量 | 中:GatewayReply 新增來源欄(sender/source/bot_id),由發話端 adapter 填入,需 openab 兩端協調 |
| door | one-way |
| openabc 端工作 | schema.rs 新增來源欄 + dispatch_reply 更新路由鍵 + 瀏覽器端顯示邏輯 |

**事實正解**:openabc 多 bot 合流要歸屬 reply 來源,唯一路徑是在 GatewayReply 協定新增來源欄(sender 或 source 或 bot_id),由發話端 adapter 填入。

**依據**:

- `gateway.rs:77-92`:現行 `GatewayReply` struct 無任何來源 bot 欄位。要讓 openabc 知道是哪個 bot 發話,協定層必須新增此欄。
- `gateway.rs:174-188`:`send_gateway_reply` 建構時設 `reply_to=origin_event_id`、`request_id=req_uuid`,無來源標記。修正路徑是在此處由發話 adapter 填入來源欄。
- 無相容捷徑:現有協定欄位均不攜帶 bot 身分,無法繞過協定修改解決此問題。

**必要工作**:openab core(`gateway.rs:77-92` struct 定義)新增欄位 + `gateway.rs:174-188` 建構點填入 + openabc `schema.rs` 對應新增 + `dispatch_reply` 路由鍵更新。需 openab 兩端協調,屬 one-way 門——一旦下游 consumer 依賴此欄,協定合約即固化。

---

## 章節4 — 最小改動兩端清單

### openab 側

- **`GatewayReply` 新增來源欄**:在 `GatewayReply` struct(`gateway.rs:77-92`)加入 `source: Option<String>`(或 `sender`/`bot_id`)。
- **`send_gateway_reply`**:修改此函式(`gateway.rs:174-188`)在建構 reply 時填入來源欄(發話 adapter 的 bot 身分)。
- 涉及約 4 檔:`gateway.rs`、相關 adapter、context struct 定義、測試。

### openabc 側

- **`schema.rs`**:additive optional 欄——在 `GatewayReply` 加入 `source: Option<String>`,為 additive 變更,舊端不送則 None,向後相容。
- **`dispatch_reply`**:讀取 `source`,以路由鍵 `(conn_id, source)` 取代純 `conn_id` 查表。
- 路由鍵 `(conn_id, source)`:更新 `NativeSenders` 型態為 `HashMap<(String, Option<String>), mpsc::Sender<String>>`。

### 向後相容論證

`GatewayReply` 來源欄為 additive optional 欄:

- 舊端不送則 None——openabc fallback 至純 conn_id 路由,行為與現在相同。
- 新端填值——openabc 精確路由至指定 bot 的瀏覽器連線。
- additive 變更無 breaking change,任何已部署的 consumer 無需同步升級。

---

## 章節5 — bot↔bot 設計

bot↔bot 訊息**經 core 中轉**,**非另設點對點**通道。

設計原則:

- 所有 bot↔bot 通訊均經 agent core 中轉,不在 openabc 層建立直接的點對點連線。
- **`BotTurnTracker` 防迴圈覆蓋範圍**:`BotTurnTracker` 僅用於 `openab/src/discord.rs` 與 `openab/src/slack.rs` 的 adapter 路徑。`gateway.rs`(openabc 走的 native 路徑)無此機制——native 平台 bot↔bot 中轉存在防迴圈缺口,需在 openabc 或 openab gateway 端另行補充防迴圈邏輯。
- `trusted_bot_ids` 白名單確保只有受信任的 bot 可透過 `is_bot: true` 路徑送出事件,防止偽造。
- 點對點路由(bot A 直接定址 bot B 繞過 core)不在本設計範圍內,原因:繞過防迴圈機制將產生安全風險,且與 openab 架構方向相悖。

---

## 附錄 — back-pressure 考量

多 bot 合流情境下,單一 conn_id 對應的 `mpsc::Sender` 可能接收多個 bot 的並發 push。若 receiver 端(瀏覽器連線)處理速度跟不上,mpsc channel 的 back-pressure 機制將產生背壓至各 bot 的 push 路徑。設計時需評估 channel 容量(`bounded` vs `unbounded`)與超時策略,避免一個慢速 consumer 阻塞所有 bot 的 reply 流量。
