# Agent Hub 影響地圖

本文件的目的不是取代程式碼，而是讓任何 AI／開發者在改動前知道「一個看似小的改動會影響哪條產品承諾」。測試檔一律是同名實作檔的契約證明；新增或改動實作時必須一併更新對應測試。

## 一級資料流

`使用者對話／檔案／網址` → `wfChatStore` → `build route` → `builder` → `graphLint + requirementCheck` → `store` → `engine` → `node registry` → `node_runs / logs / files` → `repairContext` → `graphRepair / builder edits` → `store`。

所有外部寫入皆經 `dryRun / preview / confirm`；所有 workflow 寫回皆經 `saveWorkflow`；所有 AI 建圖、直接修改、AI 修復都必須走相同的結構驗證與版本保護。

## 模組責任與連鎖影響

| 區域／檔案群 | 業務責任 | 改動時必查 |
|---|---|---|
| `app/workflows/[id]/page.tsx`, `NodePanel`, `RunForm`, `ChatInputCard` | 新手的建立、對話、執行、授權、單步修復入口 | `wfChatStore`、所有 workflow API、畫布讀取／重載、可及性與窄螢幕 |
| `SchedulePanel`, `TriggerSections`, `app/schedules`, `app/form` | 排程、資料夾、表單、收信、LINE、Telegram 自動開始 | `scheduler`, `watchers`, `mailWatcher`, `telegramPoller`, `webhookStore`, `lineHook`, `engine.TriggerSource` |
| `app/api/workflows/[id]/build`, `builder.ts` | 從零建圖、澄清、既有圖編輯 | `registry`, `graphLint`, `requirementCheck`, `codegen`, `chatHistory`, `communityIndex`, `store` |
| `wfChatStore.ts`, `chatStateStore.ts`, `chatAttachments.ts`, `chatHistory.ts` | 對話狀態、附件保存、執行／預覽／授權卡接續 | workflow 刪除／複製、附件容量、取消訊號、reload token、持久化相容性 |
| `engine.ts`, `runState`, `partialRun`, `missingRunInput`, `dryRun`, `preview` | 真實執行、佇列、取消、重跑、部分執行、只讀安全試跑 | node contract、DB schema、run API、HistoryPanel、autorun／autofix |
| `registry.ts`, `types.ts`, `nodes/*.ts`, `nodeHelpers.ts` | 節點型別、設定 schema、秘密欄位與實際 side effect | builder prompt、graph lint、node visuals、plain-language explain、dry-run 清單、secret 需求推導 |
| `graphRepair.ts`, `repairContext.ts`, `selectorProbe.ts`, `nodeEditor.ts` | 整圖失敗診斷、證據收集、修復套用與選擇器實測 | engine node_runs／截圖、builder edits、版本備份、oscillation guard、autorun／autofix |
| `store.ts`, `db.ts`, `settingsStore.ts`, `secretVault.ts` | 流程、版本、SQLite、設定與秘密資料的一致性 | 所有 route、並發寫入、copy/import/export、遷移與備份 |
| `googleSlidesApi.ts`, `nodes/googleSlidesRefresh.ts`, `SlidesOAuthSetupCard.tsx` | Google Slides 官方 OAuth 與圖表刷新 | `wfChatStore` 授權卡、Google API 錯誤翻譯、dry-run 不寫入、Google Sheets 對應驗證 |
| `googleExport.ts`, `googleSheetScriptTemplate.ts`, `nodes/googleSheet.ts` | Google 文件讀取與 Sheets 更新 | URL guard、設定卡、dry-run 計畫、節點摘要、Apps Script／Google 授權邊界 |
| `textExtract.ts`, `pdfRender.ts`, `docxRender.ts`, `pptxRender.ts`, `xlsxRender.ts`, `embeddedImages.ts` | 讓 AI 真正理解上傳資料，不只看檔名 | `extract-text route`、附件預算、render page、視覺模型、ZIP/XML 上限 |
| `urlGuard.ts`, `fetch-url route`, `renderPage.ts`, `urlContent.ts` | 外部網址讀取與 SSRF 防護 | 每個新增的網址／瀏覽器入口、redirect、私網開關、截圖與取消 |
| `mailClient.ts`, `mailWatcher.ts`, `nodes/findEmail`, `downloadAttachment`, `emailRead` | 手動與自動收信、附件處理 | 秘密欄位、取消、靜默初始掃描、信件去重、run input 傳遞 |
| `aiRetry.ts`, `modelClient.ts`, `models.ts`, `claudeCodeClient.ts` | 模型選擇、取消、退避與本機備援 | builder、repair、codegen、vision；模型名稱大小寫與視覺能力實測 |
| `proxy.ts`, import/export routes, `exportSanitizer.ts`, `preflight.ts` | 本機 API 防跨站、匯入信任、秘密去除、外部前檢 | 所有新 state-changing route、custom code、檔案／網址外送能力 |
| `instrumentation.ts`, `systemHealth.ts`, `dataBackup.ts`, `doctor.ts`, daemon scripts | 啟動、健康、備份與首次安裝 | 新背景服務、資料權限、daemon 與 production build |

## API 地圖

- `/api/workflows*`：workflow 生命週期、建圖、執行、修復、版本、觸發。變更需驗證 `proxy.ts`、`store.ts`、`graphLint.ts`、對應 UI。
- `/api/runs*`：歷史、進度、取消、續跑。變更需驗證 `engine.ts` 的 run state 與 UI polling。
- `/api/secrets`, `/api/settings`, `/api/notify-test`：本機秘密與服務連線。變更需驗證遮罩、撤銷、`deriveRequiresSecrets`。
- `/api/extract-text`, `/api/fetch-url`：不可信輸入入口。變更需驗證大小限制、取消與 URL／檔案安全。
- `/api/hooks`, `/api/line-hooks`, `/form`：無人值守入口。變更需驗證 token、簽名、正式流程限制與桌面通知。

## 高風險變更矩陣

| 若改動 | 必須連帶檢查 |
|---|---|
| 節點 schema／新增節點 | registry、builder prompt、graphLint、dryRun、nodeVisuals、explain、requiresSecrets、測試 |
| workflow 保存或 PATCH | store merge、版本備份、最新檔重讀、並發、copy/import/export |
| AI prompt／JSON 解析 | builder／repair／codegen 三路、`extractJsonObject`、lint 回饋重試、語意驗收 |
| 執行／重試／取消 | AbortSignal 從 route → engine → node → fetch／AI／browser，run 最終狀態與 UI |
| 修復邏輯 | 完整圖＋失敗輸入＋頁面證據、上游修改、無效修改止損、selector 重播閘門、版本 |
| Google Slides | OAuth card、驗證只讀、chart matching、batch atomicity、錯誤重導回同一卡 |
| 附件或 URL | 真實內容、快取／容量、私網防護、消失附件的誠實訊息、對話脈絡 |
| 排程／監聽 | 草稿不得背景執行、initial seed、去重、多進程、非手動通知 |

## 殘留／需治理項目

- `docs/ARCHITECTURE_V2.md` 明示部分過時；它只能作歷史背景，不能當規格。
- `lib/workflow/repair.ts` 已刪除；任何外部文件或舊分支若仍引用它，應改指向 `graphRepair.ts`。
- `public/{next,vercel,globe,window,file}.svg` 為初始模板資產；目前非產品功能引用，確認無引用後可在獨立清理變更移除。
- `community/blueprints/*` 是 builder 的範例知識庫；不是每條都等同平台已驗證的企業能力，新增或調整時需加入可重現驗收案例。
