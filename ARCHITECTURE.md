# Agent Hub 架構標準

## 選定模式

本專案採用 **Local-first Hexagonal Workflow Runtime**：UI 與 API 是 adapters；workflow engine 是 application core；每種 node 是 plug-in adapter；SQLite／檔案系統／瀏覽器／Email／Google 是 infrastructure adapters。AI 不是核心真相來源，而是受契約與驗證迴圈約束的規劃／修復器。

這個選擇比「所有邏輯塞在 page route」更適合本產品，因為同一條流程會被手動、排程、資料夾、Email、LINE、Telegram、表單與錯誤備援啟動，但最終必須有完全一致的執行語意。

## 層次與職責

1. **Presentation**：`app/**/page.tsx`、panel、components。只負責白話呈現、使用者意圖與 API 呼叫；不得決定執行真相或直接儲存 workflow。
2. **API adapters**：`app/api/**/route.ts`。驗證輸入、取得最新版、呼叫 application service、回傳人話錯誤；不得複製 engine 或 builder 商業規則。
3. **Application services**：`lib/workflow/{builder,engine,graphRepair,preview,store}.ts`。流程建置、執行、修復、持久化與一致性。
4. **Domain contracts**：`types.ts`、`registry.ts`、`graphLint.ts`、`requirementCheck.ts`、`relativeDate.ts`。所有入口都必須遵守的 workflow 結構與資料規則。
5. **Infrastructure**：DB、檔案、browser、Google、IMAP、通知、模型 client。只做具體 I/O，必須可取消、受限、回報可行證據。

## 不可破壞的架構規則

- 前端不准以舊快照整包 PATCH `nodes`；位置、改名、刪除都必須是 server-side merge。
- 任何異步後保存 workflow 的服務，保存前都要重新取得最新版，只改自己負責的欄位，並以 `saveWorkflow()` 原子保存。
- 模型 JSON 只能用 `extractJsonObject()` 解析；模型 patch 只能合併合法 schema key，不能整包替換。
- 建圖、直接對話修改、點節點修復、自動測試修復必須共用整圖感知與 `applyNodeConfigEdits`，不得退化為只看失敗節點。
- 引擎中間輸出必須保留上游資料；未解析變數要留下可修復證據，分流條件不得默默以字面模板決策。
- 自訂程式碼空殼必須生成可執行程式或誠實失敗，禁止「空殼成功」。
- 所有外部等待皆接 `AbortSignal`；停止鍵必須實際停止 AI、HTTP、browser、mail 與修復迴圈。
- 使用者提供的網址與檔案皆為不可信輸入；URL 要過 SSRF 防護，渲染檔案要斷網。
- Google／Microsoft 不可自動輸入帳密；以手動登入或官方 OAuth 授權處理。

## 白話 UX 標準

- 一般畫面只說「你現在能做什麼、系統正在做什麼、需要你提供什麼」。
- API、JSON、Webhook、模型、token、欄位模板、程式碼只能在明確「進階」或 AI 正在帶領特定外部服務設定時出現。
- 出錯訊息固定回答：**哪一步、實際發生什麼、AI 已嘗試什麼、下一步要不要使用者做、資料是否被改動**。
- 任何安全試跑都要清楚標示讀了什麼、算出什麼、攔住了哪些寫入；不得以模擬結果冒充真實讀取。

## Google Slides 官方整合標準

- 只使用 Google 官方 OAuth 與 Slides API `presentations.get`／`presentations.batchUpdate(refreshSheetsChart)`；不能用瀏覽器點擊冒充簡報更新。
- 設定卡需先儲存安全資料，再用只讀 API 驗證「可讀到目標簡報、確實找到指定試算表的連結圖表」；正式執行才 batch update。
- 授權失敗需回到同一張白話卡，指出目前卡在 Google 哪一步並允許使用者傳截圖；不可叫使用者自行搜尋錯誤碼。

## 建議目錄演進

目前不進行大搬家。新功能依下列方式放置：

- 新 workflow 行為：`lib/workflow/<capability>.ts`，再由 route／UI 呼叫。
- 新節點：`lib/workflow/nodes/<capability>.ts` + registry + contract tests。
- 新外部服務：`lib/<provider>.ts`，不可把 provider 細節埋進 UI 或 engine。
- 新使用者流程：優先擴充 `wfChatStore` 的白話卡與 continuation，而非增加要求使用者自己填內部欄位的設定頁。
