# Agent Hub V2 — 白話建構的視覺化 Workflow 平台（企業級，給實作者照做）

> ⚠️ **這是當初的規劃/設計文件，不是即時同步的技術文件。** 專案演進過程中有些設計已改變(例如帳密已改成「依欄位全域共用」而非每個 workflow 各自一份)，實際行為以程式碼與 README.md 為準；這份文件保留是為了保留原始設計脈絡供參考。

> 這份文件**取代** V1 的「腳本啟動器」架構（docs/ARCHITECTURE.md）。V1 的定位錯了：它只是「一堆寫好的 run.ts 腳本 + 執行按鈕」。
> V2 的定位：**像 n8n 一樣的視覺化 workflow 平台**——使用者在畫布上看到一個個節點串成的流程、資料在節點間流動、可排程觸發——但**整個建構與修改都用白話跟 AI 完成，使用者永遠不寫、不看程式碼**。
> 核心矛盾的解法（企業級可靠 vs 使用者只會白話）：**節點採「可靠積木庫 + AI 編排 + 自訂程式碼逃生口」混合制**。AI 從白話挑選「測試過的積木節點」、填參數、串起來；庫裡沒有的特殊需求才生成「自訂程式碼節點」。這樣白話可建、又企業級可靠。

---

## 0. 典範轉移：從「腳本」到「Workflow」

| | V1（錯的） | V2（要做的） |
|---|---|---|
| 基本單位 | 一個 agent = 一支 run.ts 腳本 | 一個 **workflow** = 一張**節點圖** |
| 怎麼建 | 工程師手寫 run.ts | 使用者**白話講**，AI 生成節點圖 |
| 怎麼改 | AI 改整支 run.ts | 使用者**點節點、白話講**，AI 改那個節點 |
| 失敗怎麼辦 | 看 log 手動修 | AI 看錯誤+截圖，**自動提修法**，確認即套用 |
| 使用者看到什麼 | 卡片 + log | **畫布 + 節點 + 節點間資料流** |
| 可靠性來源 | 每支腳本各自寫 | **測試過的積木節點庫**當骨幹 |

**能沿用的既有基礎建設**（不要打掉）：`lib/db.ts`(SQLite/WAL)、`lib/settingsStore.ts`、`lib/modelClient.ts`、`lib/models.ts`、`lib/scheduler.ts`(cron/相對日期觸發)、`lib/relativeDate.ts`、`lib/files.ts`、`lib/textDiff.ts`、`instrumentation.ts`(崩潰復原+排程)、設定頁、草稿/正式概念、匯出/匯入概念、執行引擎的**重試/並發/崩潰復原**模式。

**要重寫的核心**：執行單位從「spawn 一支 run.ts」變成「執行一張節點圖」。Dashboard 從「卡片列表」變成「節點畫布 + AI 對話」。

**新增 npm 套件**：`@xyflow/react`（React Flow，MIT，畫節點圖用）。其餘沿用 playwright/exceljs/openai/better-sqlite3/tsx/zod。

---

## 1. 核心概念

- **Workflow**：一個自動化流程。資料結構 = `{ id, name, status(draft|official), nodes[], edges[], trigger }`，整張圖存成 JSON。
- **Node（節點）**：流程中的一步。`{ id, type, label, config, position:{x,y} }`。`type` 對應**節點庫**裡一種積木（或 `custom-code`）。
- **Edge（連線）**：`{ from: nodeId, to: nodeId, fromPort?, toPort? }`。決定執行順序與資料流向。
- **Trigger（觸發）**：手動、排程（cron+相對日期，沿用 scheduler）。每個 workflow 有一個 trigger 節點當起點。
- **Run（執行）**：一次 workflow 執行。含每個節點的 **node run**（狀態/輸入/輸出/錯誤/debug）。
- **資料流**：每個節點執行後產生 output（JSON），沿 edge 傳給下游節點當 input。節點 config 裡可用 `{{節點id.欄位}}` 或 `{{trigger.date}}` 引用上游資料——**但這種引用由 AI 幫使用者填，使用者不用懂**。
- **共享 Session**：瀏覽器類節點（登入→找信→下載）需要共用**同一個瀏覽器分頁**。所以執行時有一個 `RunContext` 貫穿整張圖，持有共享 browser/page、資料袋、secrets、模型 client、outputDir、debugDir。這是 workflow 引擎跟純 n8n 無狀態節點最大的不同，**務必實作**。

---

## 2. 技術棧與專案結構

```
agent-hub/
  docs/ARCHITECTURE_V2.md                本文件（權威）
  app/
    page.tsx                             Workflow 清單（正式）+ 總覽
    drafts/page.tsx                      草稿 workflow
    workflows/[id]/page.tsx              ★ 主畫面：節點畫布 + AI 對話 + 執行/排程
    files/page.tsx  settings/page.tsx
    api/…                                見 §12
  lib/
    db.ts settingsStore.ts models.ts modelClient.ts relativeDate.ts files.ts textDiff.ts scheduler.ts   [沿用/微調]
    workflow/
      types.ts            Workflow/Node/Edge/RunContext 型別
      registry.ts         節點庫註冊表（所有節點型別的 schema + execute）
      engine.ts           ★ 執行引擎：拓樸執行、共享 session、資料傳遞、per-node 重試/debug
      nodes/              ★ 每種積木節點一個檔（見 §5）
        trigger.ts browser-login.ts find-email.ts download-attachment.ts
        excel-process.ts http-request.ts send-email.ts if-condition.ts
        loop.ts llm-decide.ts read-captcha.ts set-variable.ts custom-code.ts …
      builder.ts          ★ AI 建圖：白話 → workflow JSON（結構化輸出 + zod 驗證）
      node-editor.ts      ★ AI 改單一節點 config / custom-code
      repair.ts           ★ AI 看失敗節點的錯誤+截圖 → 提修法
      store.ts            workflow CRUD（存 data/workflows/<id>.json）
  data/
    agent-hub.db
    workflows/<id>.json          使用者的 workflow（gitignore）
    runs/<runId>/                per-node debug 截圖/html/資料快照
    outputs/<runId>/<file>       產出檔
  agents/  →  改名為 examples/    內建範例 workflow（唯讀，進 git；invoice-excel 改寫成範例 workflow JSON）
```

---

## 3. 資料模型（SQLite）

沿用 §V1 的 settings/secrets/schedules 概念，執行相關改成 workflow/node 粒度。用 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` 無痛升級。

```sql
-- workflow 的「定義」存檔案(data/workflows/<id>.json)，DB 只存執行狀態與索引
CREATE TABLE workflows_meta (        -- 供列表/總覽快速查詢，真正定義在 json 檔
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,   -- draft|official
  builtin INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);

CREATE TABLE secrets (               -- 每 workflow 的帳密(明碼本機，匯出排除)
  workflow_id TEXT, key TEXT, value TEXT, PRIMARY KEY(workflow_id,key)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- queued|running|success|failed|cancelled
  trigger_type TEXT NOT NULL,        -- manual|schedule
  headed INTEGER NOT NULL DEFAULT 0,
  trigger_params_json TEXT,          -- 觸發參數(相對日期已解析)
  error TEXT, started_at TEXT NOT NULL, finished_at TEXT
);

CREATE TABLE node_runs (             -- ★ 每個節點一列，畫布靠它上色+顯示資料
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, node_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- pending|running|success|failed|skipped
  input_json TEXT, output_json TEXT, error TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT, finished_at TEXT
);
CREATE INDEX idx_node_runs ON node_runs(run_id);

CREATE TABLE run_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, node_id TEXT, ts TEXT, line TEXT);
CREATE TABLE run_files (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, workflow_id TEXT, filename TEXT, path TEXT, mime TEXT, size INTEGER, created_at TEXT);
CREATE TABLE schedules (id TEXT PRIMARY KEY, workflow_id TEXT, enabled INTEGER, cron TEXT, params_json TEXT, last_fired_minute TEXT, next_run_at TEXT, created_at TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Workflow 定義存成 `data/workflows/<id>.json`：
```json
{
  "id": "inventory-excel",
  "name": "庫存 Excel 月結整理",
  "status": "official",
  "trigger": { "type": "schedule-or-manual" },
  "nodes": [
    { "id": "n1", "type": "trigger", "label": "開始", "config": {"targetDate":"{{yesterday}}"}, "position": {"x":0,"y":0} },
    { "id": "n2", "type": "browser-login", "label": "登入 webmail", "config": {"urlSecret":"webmailUrl","accountSecret":"webmailAccount","passwordSecret":"webmailPassword","captchaModel":"minimax-m3"}, "position": {"x":0,"y":120} },
    { "id": "n3", "type": "find-email", "label": "找信", "config": {"dateFrom":"{{n1.targetDate}}","subjectContains":"每日庫存報表"}, "position": {"x":0,"y":240} },
    { "id": "n4", "type": "download-attachment", "label": "下載附件", "config": {"nameContains":"每日庫存報表"}, "position": {"x":0,"y":360} },
    { "id": "n5", "type": "excel-process", "label": "篩選+highlight", "config": {"sheet":"工作表1","dateColumn":1,"filterStart":"{{last-quarter-start}}","filterEnd":"{{last-quarter-end}}","highlight":"FFA500","outputName":"庫存報表第二季"}, "position": {"x":0,"y":480} }
  ],
  "edges": [
    {"from":"n1","to":"n2"},{"from":"n2","to":"n3"},{"from":"n3","to":"n4"},{"from":"n4","to":"n5"}
  ]
}
```
> invoice-excel 從「一支 run.ts」拆成「5 個積木節點」，這就是給使用者看的範例：他能看懂每一步、能點任一步叫 AI 微調。

---

## 4. 節點契約（節點庫的心臟，`lib/workflow/types.ts` + `registry.ts`）

每種節點型別是一個**手寫、測試過**的 TypeScript 模組，實作統一介面：

```ts
export interface NodeContext {
  runId: string; nodeId: string;
  input: Record<string, unknown>;        // 上游節點的 output（多個上游會 merge）
  config: Record<string, unknown>;       // 這個節點的設定（{{...}}已解析成實際值）
  secrets: Record<string, string>;
  vars: Record<string, unknown>;         // 跨節點共享變數袋
  model: string; baseUrl: string; apiKey: string; headed: boolean;
  outputDir: string; debugDir: string;   // debug 存 debugDir/<nodeId>/
  session: RunSession;                   // ★ 共享瀏覽器等長生資源
  log(msg: string): void;
}
export interface RunSession {            // 貫穿整張圖，節點間共用
  getPage(): Promise<import("playwright").Page>;  // 首次呼叫才開瀏覽器(headless=!headed)
  close(): Promise<void>;
}
export interface NodeDefinition {
  type: string;
  category: "trigger"|"browser"|"data"|"integration"|"logic"|"ai"|"custom";
  label: string;                         // 顯示名
  description: string;                   // 給 AI 看的用途說明
  configSchema: ParamField[];            // 產生設定表單 + 給 AI 知道有哪些參數
  retryable: boolean;                    // 失敗預設可不可重試
  execute(ctx: NodeContext): Promise<Record<string, unknown>>;  // 回傳 output
}
```

- `registry.ts` 匯出 `NODE_DEFS: Record<type, NodeDefinition>` 與 `listNodeDefs()`。
- **AI 建圖時**把 `listNodeDefs()`（type/description/configSchema）餵給模型，模型只能用庫裡的型別（+ custom-code），並照 configSchema 填參數。這是「白話可建又可靠」的關鍵：模型不是憑空寫程式，是在**已知、測試過的積木**上做組裝。
- 節點若拋錯，engine 依 `retryable` + 錯誤型別決定重試（沿用 V1：`RetryableError` vs `PermanentError`）。

---

## 5. 內建節點庫（第一版就要有這些）

**Trigger**
- `trigger`：流程起點。config：可宣告觸發參數（如 targetDate，支援相對日期 token），output 給下游引用。

**Browser（共用 session.getPage()）**
- `browser-login`：開瀏覽器→填帳密→**vision 讀驗證碼**(config 選模型，預設 minimax-m3，失敗刷新重試≤3)→送出→驗證登入成功。config：urlSecret/accountSecret/passwordSecret/captchaModel/選擇器覆寫。帳密明確錯誤→PermanentError。
- `find-email`：在已登入頁用「日期＋標題關鍵字」精準搜信、開啟。config：dateFrom、subjectContains、senderContains。output：找到幾封、開啟哪封。（沿用 V1 實測：`td.ML_Subject` 點擊、日期+報表名稱精準比對）
- `download-attachment`：下載符合檔名關鍵字的附件到暫存。config：nameContains。output：附件路徑。（沿用 V1 實測：`.AttBlock[title*=...]` + downfile href）
- `navigate`/`click`/`fill`/`screenshot`：通用瀏覽器動作（給非 webmail 的網站用）。
- `read-captcha`：獨立的 vision 讀圖節點（可被別的流程重用）。

**Data / File**
- `excel-process`：讀附件→選分頁→依日期區間篩→整列 highlight→存新檔到 outputDir（印 FILE_OUTPUT + 桌面備份）。config：sheet/dateColumn/filterStart/filterEnd/highlight/outputName。（沿用 V1 實測邏輯）
- `excel-read`：讀 Excel 成 JSON 給下游用。
- `save-file`/`read-file`。

**Integration**
- `http-request`：打任意 API。config：method/url/headers/body。output：回應。
- `send-email`：寄信（SMTP 設定在 settings，可選；未設定則此節點提示需設定）。

**Logic / Control**
- `if-condition`：依條件走不同分支（兩個 output port：true/false）。
- `loop`：對一組資料逐項跑下游。
- `set-variable`：設共享變數。
- `llm-decide`：問模型一個問題（可帶上游資料/截圖），依回答決定分支或產生值。這是「智慧判斷」節點，讓流程能處理模糊情況。

**更多內建節點（第一版就要夠多，避免「需求沒對應節點」）**
- 瀏覽器補強：`extract-text`(抓網頁文字/表格)、`wait-for`(等元素/等秒數)、`select-option`、`upload-file`、`switch-tab`/`iframe`、`press-key`。
- 資料補強：`csv-read`/`csv-write`、`json-transform`(挑欄位/改結構)、`filter-rows`、`merge-data`、`template-text`(用上游資料組字串/檔名)、`pdf-extract`(抽 PDF 文字)、`ocr-image`(vision 讀圖成文字)。
- 檔案補強：`zip`/`unzip`、`move-file`、`list-files`。
- 整合補強：`webhook-in`(被外部呼叫觸發)、`google-sheets`(讀寫，需 OAuth/service account，設定頁填)、`line-notify`、`slack-message`、`telegram-message`、`download-url`(直接抓網址檔案)。
- 邏輯補強：`switch`(多分支)、`try-catch`(某步失敗走備援)、`delay`、`dedupe`、`aggregate`(加總/計數)、`sort`。
- AI 補強：`llm-extract`(從一段文字/截圖抽結構化資料)、`llm-classify`(分類)、`llm-summarize`、`llm-generate`(產生文字/信件內容)。

**Custom（逃生口）**
- `custom-code`：以上都沒有的特殊需求。**AI 依白話寫這個節點的 JS**（實作 execute 契約），存在 workflow json 的 node.config.code 裡。執行時 engine 用受限方式跑（見 §6）。使用者永遠不看這段碼；壞了就叫 AI 再修。

> 節點庫**設計成可持續擴充**——每種節點就是一個 NodeDefinition 檔，加一個檔 AI 立刻就會用。第一版至少涵蓋上面所有型別，讓「常見自動化需求都有現成積木」，真的沒有才落到 custom-code。

---

## 6. 執行引擎（`lib/workflow/engine.ts`）

沿用 V1 的可靠性骨架（佇列/並發上限/同 workflow 不並發/崩潰復原/超時），執行單位改成「跑一張圖」：

1. `enqueueRun(workflowId, triggerParams, {trigger, headed})`：解析相對日期→建 run + 每節點 node_runs(pending)→入佇列。
2. worker 取出→建 `RunContext`（含 `RunSession`：lazy 開瀏覽器）。
3. **拓樸排序**節點；依序執行（有分支/loop 時依 edge 與 if/loop 節點的 output 決定走向）。
4. 每個節點：node_run→running（畫布即時變色）→ `def.execute(ctx)`：
   - input = 上游節點 outputs merge；config 的 `{{...}}` 先解析（相對日期、`{{nodeId.field}}` 引用）。
   - 成功：output 存 node_runs.output_json（**畫布可點節點看流過的資料**，像 n8n）。
   - 失敗：依 retryable + 錯誤型別重試（指數退避≤3）；仍失敗→node_run failed、整個 run failed、停止；存該節點 debug（截圖+html+input 快照）到 `data/runs/<runId>/<nodeId>/`。
5. `custom-code` 節點：把 node.config.code 包成一個模組，用 `tsx` 或 `vm`/`worker_threads` 執行，注入 NodeContext（同契約）。**逃生口的碼在受控環境跑**，語法先 check。
6. 結束關閉 session（瀏覽器）。產出檔登記 run_files。
7. 崩潰復原：engine 啟動時把殭屍 running/queued run 與 node_runs 標 failed。

**headed**：草稿測試 = 有頭瀏覽器（看得到每個節點在做什麼）；正式/排程 = headless。

---

## 7. AI 建圖：白話 → workflow（`lib/workflow/builder.ts`）

主畫面右側是**AI 對話框**（支援上傳檔案/截圖）。使用者打白話，AI 產生/修改整張節點圖。

**★ 釐清優先（clarify-first）——不要沒搞懂就亂建、做到一半才失敗**
- 建圖是**兩階段**：先「釐清問答」，全部細節確認完，才「生成節點圖」。
- 使用者第一次描述需求後，builder 先進入 **planning 模式**：模型的任務不是馬上出圖，而是**判斷資訊夠不夠**。system prompt 明令：「若有任何不確定（要登入哪個系統？帳號哪來？信件怎麼認？日期區間怎麼算？產出檔名規則？要不要通知？），先**一次問一組具體問題**（用選項或範例），不要臆測、不要出圖。全部釐清且你有把握每一步都能用現有節點完成，才輸出 `READY` + workflow JSON。」
- 對話框逐輪問答，直到模型回 `READY`。使用者可**上傳截圖/文件**（例：webmail 畫面、Excel 範例、範例信件）幫模型搞懂——截圖轉 base64 當 image_url，文字/檔案內容附進對話。
- 模型自評「這步我沒把握用現有節點做到」時，要在問答階段就講明、提出用 custom-code 或請使用者補資訊，**絕不硬做**。
- **從零建**：釐清完 → 結構化輸出 `{nodes, edges}`（zod 驗證：type 在庫裡、config 符合 schema、無環）→ 畫布渲染 → 使用者確認。
- **增量改**：「再加一步寄 email」→ 同樣先確認細節（寄給誰、內容）→ 回傳更新後的圖 → 確認才存。
- **驗證失敗**（模型亂填）→ 自動回饋錯誤重試；仍失敗就轉 custom-code 並告知使用者。
- 使用者永遠只看到**畫布 + 對話**，看不到 JSON/程式碼。

> API：`/api/workflows/[id]/build` 回傳 `{ phase: "clarify", questions: [...] }` 或 `{ phase: "ready", nodes, edges, summary }`。前端依 phase 顯示「繼續問答」或「預覽並套用」。對話歷史(含上傳)存 session 供多輪。

---

## 8. AI 改單一節點 & 失敗自修（vibe coding 迴圈）

**點節點 → 白話微調**（`lib/workflow/node-editor.ts`）
- 點畫布上任一節點 → 側邊開該節點面板（顯示 label + 目前設定的**白話摘要**，不是 raw JSON）→ 使用者打「這個要改成抓『每週業績追蹤』那封信」→ 模型依該節點的 configSchema 回傳新 config（library 節點）或新 code（custom-code 節點）→ 顯示「改了什麼」（config 用人話 diff、code 用行級 diff）→ 確認套用。
- 也提供**表單微調**：configSchema 產生的欄位讓使用者直接改（進階/精確調整）。兩條路都在。

**失敗 → AI 修**（`lib/workflow/repair.ts`）
- 某節點 failed，畫布該節點變紅、可點「🔧 讓 AI 修這一步」→ repair 把 **節點型別、目前 config、錯誤訊息、該節點 debug 截圖(image_url)、input 資料快照** 餵給模型 → 模型判斷是 config 問題（改參數/選擇器）還是 custom-code 問題（改碼）或需要加一個前置節點 → 回傳修法 → 顯示變更 → 使用者確認 → 套用 → **可從該節點重跑**（不用整條重來）。
- 這正是使用者說的「失敗了也要能支援 AI 直接修改」。

**刪節點**：畫布選節點按刪除→同時清掉相關 edges→AI 對話也能「把寄 email 那步拿掉」。

**所有 AI 動作**：一律**先預覽變更、使用者確認才落地**（企業級：不讓 AI 默默改動正式在跑的流程）；改動存版本歷史可還原。

---

## 9. 視覺畫布（`app/workflows/[id]/page.tsx`，React Flow）

- 用 `@xyflow/react` 畫節點圖：節點是卡片（icon＋label＋狀態點），edge 是箭頭，可縮放/拖動。
- **即時狀態**：執行時輪詢 node_runs，節點依 pending/running/success/failed 上色（跑到哪一步一目了然）。
- **點節點**：看該節點設定摘要 + 上次流過的資料（input/output）+ 白話微調 + 表單微調 + debug 截圖 + 「讓 AI 修」。
- **右側 AI 對話**：建圖/改圖/加步驟/刪步驟。
- 頂部：▶ 執行（草稿=有頭）、排程、設為正式、匯出、改名。
- 手動拖節點/連線也允許（進階），但**主要靠 AI**——使用者不需要會拉線。

---

## 10. 沿用並調整的功能

- **草稿/正式**：workflow 有 status。複製→草稿；「設為正式」→上首頁。內建範例(examples/)唯讀，改要先複製。
- **排程**（sched	uler.ts 幾乎不動）：schedule 綁 workflow_id，觸發整張圖，headless，日期參數走相對日期 token。已驗證的 cron/idempotent/next_run_at 照用。
- **檔案管理**：run 產出檔進 run_files，/files 頁下載/刪除/**拖到 Finder**。
- **匯出/匯入**：匯出 = workflow json（含 custom-code 節點的碼）＋所需 secret 欄位清單，**不含帳密**；匯入→強制草稿。
- **設定/模型**：baseUrl/apiKey（預設帶 https://api.openai.com/v1，可換成任何 OpenAI 相容服務）、12 模型、vision 用途預設 minimax-m3；每 workflow 帳密。
- **相對日期**、**崩潰復原**、**重試/並發**、**textDiff**：照用。

---

## 11. Dashboard 頁面 & API

**頁面**：`/`(正式 workflow 清單+總覽)、`/drafts`、`/workflows/[id]`(★畫布+對話+執行+排程+檔案)、`/files`、`/settings`。

**API（新/改）**
```
GET/POST   /api/workflows                     列出/新建(空白或AI建)
GET/PATCH/DELETE /api/workflows/[id]          讀/改名改status/刪
POST       /api/workflows/[id]/copy           複製成草稿
POST       /api/workflows/[id]/build          AI 建/改圖(body: instruction) → {nodes,edges,summary}
POST       /api/workflows/[id]/apply-graph    確認套用新圖(先驗證zod+備份版本)
POST       /api/workflows/[id]/nodes/[nid]/edit    AI 改單一節點 → 變更預覽
POST       /api/workflows/[id]/nodes/[nid]/apply   套用節點變更
POST       /api/workflows/[id]/run            執行(body: params, headed?)
GET        /api/runs/[runId]                  run + node_runs + logs(增量)
POST       /api/runs/[runId]/nodes/[nid]/repair    AI 修失敗節點 → 修法預覽
POST       /api/runs/[runId]/rerun-from/[nid] 從某節點重跑
GET        /api/node-defs                     節點庫(給前端顯示可用積木)
… schedules / files / settings / export / import 沿用
```

---

## 12. 可靠性與安全（企業級要點）

- **節點庫是可靠性來源**：標準操作用測試過的積木，不是每次讓 AI 寫碼 → 可預測、可除錯、可重用。
- **AI 只組裝、不亂寫**：建圖限定在庫裡的型別 + zod 驗證；custom-code 是明確、隔離、需確認的逃生口。
- **一切變更先預覽再套用**，改動有版本備份可還原（正式流程不被默默改壞）。
- **失敗留完整證據**：per-node 截圖/html/input 快照，AI 修復與人工除錯都靠它。
- **重試分級**：暫時性(網路/timeout/驗證碼)自動重試；永久性(帳密錯/找不到資料)不重試、清楚報錯。
- **帳密**只在本機、匯出排除、log 遮罩。
- **崩潰復原**：殭屍 run/node 標 failed 不卡佇列。
- **custom-code 隔離執行**、語法先 check。

---

## 13. 從 V1 遷移

- V1 的 `agents/invoice-excel/run.ts` 的**實測知識全部保留**，但拆進對應節點：登入邏輯→`browser-login`、搜信→`find-email`、下載→`download-attachment`、Excel→`excel-process`。這些節點第一版就內建、測試過。
- V1 的 `agents/invoice-excel/` → 改成 `examples/invoice-excel.json`（一張範例 workflow），當作使用者的參考範本與「複製來改」的起點。
- V1 的執行引擎重試/並發/崩潰復原、scheduler、relativeDate、files、settings、modelClient、db → 沿用/小改。
- V1 的「AI 改整支 run.ts」→ 進化成「AI 改節點 config / custom-code」。

---

## 14. 實作順序（Sonnet 照這順序，每階段可獨立驗收）

1. **型別與節點契約**：`workflow/types.ts`(Workflow/Node/Edge/NodeContext/RunSession)、`registry.ts`。
2. **節點庫第一版**：trigger、browser-login、find-email、download-attachment、excel-process（把 V1 實測邏輯搬進來，各自可單元測試）。＋ http-request、if-condition、set-variable、llm-decide、custom-code。
3. **執行引擎**：拓樸執行、共享 RunSession（瀏覽器）、資料傳遞、per-node 狀態/重試/debug、崩潰復原。DB schema(runs/node_runs/…)。
4. **workflow store + CRUD API** + examples/invoice-excel.json。
5. **視覺畫布**（React Flow）：渲染 nodes/edges、即時狀態上色、點節點看資料/設定、手動刪節點。
6. **AI 建圖**（builder）：白話→結構化 workflow→zod 驗證→畫布；增量改。
7. **AI 改節點 + 表單微調**（node-editor）：預覽→套用→版本備份。
8. **AI 失敗自修**（repair）：錯誤+截圖→修法→從節點重跑。
9. **草稿/正式、排程、檔案、匯出入、設定**：接上 workflow 粒度。
10. **總覽 + UI 收尾 + 常駐 daemon + README 改寫**。

## 15. 驗收標準（都要真的驗過）
- 使用者對 AI 打一句白話，畫布上長出一條可執行的 workflow（節點+連線正確）。
- 點任一節點用白話微調，AI 只改那個節點、預覽後套用。
- inventory-excel（改成節點圖）真的跑成功：登入(vision讀驗證碼含重試)→精準找信→下載→Excel highlight→存檔，畫布每節點即時上色、可點看流過的資料、產出檔可下載/拖到桌面。
- 故意讓某節點失敗（如選擇器過期）→ 點「讓 AI 修」→ AI 看截圖提修法→套用→從該節點重跑成功。
- 刪一個節點、加一個節點（寄 email）都能白話完成。
- 排每季 cron，觸發整張圖 headless，相對日期正確；關瀏覽器後常駐仍觸發；引擎重啟殭屍 run 標 failed。
- 匯出 workflow→刪→匯入回來(草稿、不含帳密)。
- 庫裡沒有的需求→AI 用 custom-code 節點做出來，使用者全程沒看到程式碼。
```
```
