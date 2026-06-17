# Multi-Bot Integration Design

## 本輪不改

openabc 本輪不改 schema.rs/dispatch 運作行為。本文件為設計評估書,不含任何 src/schema.rs 或 src/native.rs 的改動。

---

## 章節1 — 四面牆(當前協定障礙)

以下四道牆阻礙多 bot 場景的正確運作:

### wall-reply-no-bot-id

`GatewayReply` 協定不攜帶任何 bot 身分欄位。openab core 送出的 reply 只有 `channel.id`(conn_id)、`platform`、`content` 等欄,沒有 `bot_id`、`agent_id` 或任何 sender 身分識別。瀏覽器收到 push 後無法判斷是哪個 bot 產生的回覆。

### wall-merge-unattributable

多個 bot(多條 OAB `/ws` 連線)對同一 conn_id 各發一則 reply,openabc 的 `dispatch_reply` 將它們合流推送至同一瀏覽器連線。每則 push 的鍵集合為 `{type, op, text}`,不含任何來源識別。合流後不可歸屬——瀏覽器無法分辨哪則訊息來自哪個 bot。

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

- `gateway.rs:699`:receiver_id 在 gateway 邊界丟成 `None`。原始碼註解明確標注 `gateway does not yet resolve receiver identity`——即使 adapter 端已填 receiver_id,在此行被截斷為 None,下游永遠拿不到 bot 身分。
- `gateway.rs:869`:`other_bot_present: false` 硬寫,且有 `TODO multibot detection` 標記——多 bot 偵測尚未實作,無法靠現有邏輯自動處理。
- `gateway.rs:176`:多個 bot 的 `reply_to` 可能撞鍵(同一 request_id 對應多個 bot 的回覆),無 agent 標籤可區分。
- `request_id` 欄位無 agent 標籤,無法從中推斷回覆來自哪個 bot。

零改動方案在當前協定狀態下結構性不可行。

---

### option-receiver-id-optional

標記:`two-way` + `RECOMMENDED`

| 屬性 | 內容 |
|------|------|
| openab 改動量 | 極小:補回已有欄位至 gateway 邊界即可 |
| door | two-way |
| openabc 端工作 | schema.rs additive optional 欄 + dispatch_reply 更新路由鍵 |

**原理**:openab 既有 `SenderContext.receiver_id`(見 `adapter.rs:260`、`slack.rs:1379` 已填值),但在 `gateway.rs:699` 被丟棄為 None。只需補回這段傳遞路徑,`receiver_id` 即可流至 openabc。

此為 two-way 門:`receiver_id` 是 optional 欄位,填與不填均向後相容。若日後決策改變,移除此路徑不破壞任何既有 consumer。

**RECOMMENDED**:改動量最小、可逆性最高、利用現有 openab 基礎設施,為首選方案。

---

### option-dedicated-bot-id

標記:`one-way`

| 屬性 | 內容 |
|------|------|
| openab 改動量 | 最高:新增專屬 bot_id 欄於 GatewayReply,openab core + 所有 adapter 均需更新 |
| door | one-way |
| openabc 端工作 | schema.rs 新增 bot_id 欄 + dispatch_reply 路由鍵 + 瀏覽器端顯示邏輯 |

新增專屬 `bot_id` 欄至 `GatewayReply` 協定。一旦任何下游 consumer 依賴此欄,協定合約即固化——不可在不協調所有 consumer 的情況下移除或重命名,屬 one-way 門。成本最高,作為備案。

---

## 章節4 — 最小改動兩端清單

### openab 側

- **`receiver_id: Option<String>`**:在 `GatewayReply` 或對應的 reply context 中補回此欄傳遞。
- **`send_gateway_reply`**:修改此函式以攜帶 `receiver_id`(目前在 `gateway.rs:699` 丟棄)。
- 引用 `gateway.rs:699`:補回 receiver identity 解析路徑。
- 涉及約 4 檔:`gateway.rs`、`adapter.rs`、相關 context struct 定義、測試。

### openabc 側

- **`schema.rs`**:additive optional 欄——在 `GatewayReply` 加入 `receiver_id: Option<String>`,為 additive 變更,舊 openab 不送則 None,向後相容。
- **`dispatch_reply`**:讀取 `receiver_id`,以路由鍵 `(conn_id, receiver_id)` 取代純 `conn_id` 查表。
- 路由鍵 `(conn_id, receiver_id)`:更新 `NativeSenders` 型態為 `HashMap<(String, Option<String>), mpsc::Sender<String>>`。

### 向後相容論證

`receiver_id` 為 additive optional 欄:

- 舊 openab 不送則 None——openabc fallback 至純 conn_id 路由,行為與現在相同。
- 新 openab 填值——openabc 精確路由至指定 bot 的瀏覽器連線。
- 無 breaking change,任何已部署的 consumer 無需同步升級。

---

## 章節5 — bot↔bot 設計

bot↔bot 訊息**經 core 中轉**,**非另設點對點**通道。

設計原則:

- 所有 bot↔bot 通訊均經 agent core 中轉,不在 openabc 層建立直接的點對點連線。
- openab core 的 `BotTurnTracker` 在中轉路徑上追蹤輪次、防迴圈——偵測到循環即中斷,避免 bot 互相觸發無限迴圈。
- `trusted_bot_ids` 白名單確保只有受信任的 bot 可透過 `is_bot: true` 路徑送出事件,防止偽造。
- 點對點路由(bot A 直接定址 bot B 繞過 core)不在本設計範圍內,原因:繞過 `BotTurnTracker` 防迴圈機制將產生安全風險,且與 openab 架構方向相悖。
