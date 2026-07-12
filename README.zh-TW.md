# Agent Hub 🤖

[![CI](https://github.com/owen4sure/agent-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/owen4sure/agent-hub/actions/workflows/ci.yml)

**繁體中文** | [English](./README.md)

企業級的視覺化 workflow 自動化平台——**像 n8n 一樣**在畫布上把一件事拆成一個個節點串成流程，但**整個建構與修改都用白話跟 AI 完成，你永遠不寫、不看程式碼**。

![動態展示：流程逐節點執行，跑到哪一步就亮到哪一步，右邊是白話 AI 對話](docs/screenshots/demo.gif)

## 核心概念

- **Workflow = 一張節點圖**：畫布上看得到每一步(登入→找信→下載→處理→存檔)，資料在節點間流動。
- **用白話建**：右側 AI 對話框，你描述需求 → AI 先問清楚細節 → 幫你畫出節點圖。
- **可靠積木 + 逃生口**：登入、找信、下載、Excel、打 API、條件判斷、AI 判斷… 都是測試過的積木；庫裡沒有的才由 AI 寫「自訂節點」，你不用看程式碼。
- **每人本機自架**：clone 下來自己跑，帳密/API key 只存在你自己電腦的 `data/`(gitignore)。

## 快速開始

```bash
npm install          # 會自動一併安裝 Playwright 的 Chromium(postinstall)
npm run doctor        # 健康檢查：確認 Node 版本/瀏覽器/資料夾權限都沒問題，有問題會告訴你怎麼修
npm run dev
```

開啟 http://127.0.0.1:3000（只綁本機，別的裝置連不到）。

> 用 Claude Code 之類的 AI 編碼工具？直接把這個 repo 網址貼給它，它會照 `AGENTS.md` 的指示自動幫你裝好環境、跑健康檢查、確認網頁能開——不用自己打指令。

1. 「設定」頁：填入你的模型 **API Key / Base URL**（OpenAI 相容即可），或設環境變數 `AGENT_HUB_API_KEY`／`AGENT_HUB_BASE_URL`（見 `.env.example`）。workflow 需要的帳密(如 webmail)也在設定頁下方填。
   - **自動備援**：如果這台機器有裝並登入過 Claude Code(`claude` 指令能跑)，主力模型(通常是免費/共用 API)重試多次還是失敗時，會**自動**改叫本機的 Claude Code CLI(用你的 Claude 訂閱)頂上，不用手動切換——免費服務不穩定時，流程也不會整個失敗。想直接固定用 Claude Code(不繞經免費 API)，也可以在模型選單直接選「claude-code(本機訂閱)」當主力。
2. 首頁按「＋ 新建 workflow」進畫布，右側跟 AI 講你要什麼。
3. AI 會先問細節、確認清楚才畫節點圖 → 你按「套用」→ 畫布長出流程。
4. 按「▶ 執行」，畫布上每個節點即時上色(跑到哪一步)。點節點可看流過的資料、用白話微調、失敗時「讓 AI 修」。

![工作流程畫布：左邊是節點圖，右邊用白話跟 AI 對話](docs/screenshots/canvas.png)

## 怎麼用白話建流程

- **建**：右側對話框描述需求(可上傳截圖/文件幫 AI 理解)。AI 沒搞懂會先反問，確認所有細節才出圖 → 你確認套用。
- **手動也一樣一流**：工具列「＋ 加步驟」打開節點庫抽屜挑積木、連線中點的「＋」直接在兩步之間插一步、點節點直接改欄位值(網址/關鍵字/檔名不用求 AI)、Cmd/Ctrl-Z 一鍵復原誤刪誤改。AI 與手動雙模式並行,各取所長。
- **微調某一步**：點畫布上的節點 → 用白話講「改成抓 XX 那封信」→ AI 只改那個節點;卡片上直接顯示每步的關鍵設定(抓哪個網址/分幾類/存什麼檔名),不用點開猜。
- **失敗自修**：節點變紅 → 點「🔧 讓 AI 修這一步」→ AI 看錯誤+截圖提修法。
- **加/刪步驟**：跟 AI 講「再加一步寄 email」或「把通知那步拿掉」。
- **固定偏好**：在設定頁用白話寫一次你的習慣(「檔名一律加日期」「通知一律用 Telegram」)，之後 AI 建的每條流程都會遵守，不用每次重講。

![節點失敗變紅：錯誤訊息說人話，一鍵「讓 AI 修這一步」](docs/screenshots/ai-fix.png)

![執行前選期間：篩選起訖、報表日期、輸出檔名全部自動算好](docs/screenshots/run-form.png)

## AI 大腦內建 2,000+ 條真實工作流的功夫

介面上永遠只有你自己的流程(看著簡單);厲害的藏在 AI 大腦裡:

- **58 條完整藍圖**——從 n8n 社群工作流庫(Zie619/n8n-workflows)忠實移植、轉成本產品節點格式、每條都過 CI 品質閘門。你用白話描述需求,AI 先檢索出最像的完整藍圖照著做(結構仿作、內容換成你的)——「收款自動對單,對不上通知我」這種一句話,它直接建出含多路分流的七節點正確結構。
- **2,061 條全庫索引**——整個社群庫的名稱/節點組合/觸發方式蒸餾成本地索引,AI 建圖時自動比對,任何常見自動化它手上都有真實世界的做法可對照。

流程多了之後:首頁可搜尋、可分群組(工作/私人…)分區顯示;「☰ 執行紀錄」一頁看完所有流程的歷史執行。

## 節點庫(可持續擴充)

觸發、瀏覽器(登入/找信/下載附件)、資料(Excel/組字串/PDF讀取/zip解壓縮)、檔案(讀檔案成文字——PDF/Word/Excel/PPT 自動抽取——/寫文字檔)、整合(打API/抓網頁內容/讀RSS/**用IMAP直接讀信箱(免開瀏覽器)**/讀連結分享的Google試算表免授權/寫入試算表走3分鐘Apps Script部署免OAuth/寄Email可帶附件/Telegram/LINE/Slack/桌面通知)、邏輯(條件判斷/**多路分流**/**等人簽核**/重複執行清單每一項/等待/執行子流程/變數)、AI(判斷·產生/看圖片)、自訂程式碼。每種節點是一個 `lib/workflow/nodes/*.ts` 檔，加一個檔 AI 立刻就會用。上傳給 AI 的檔案(PDF、Word `.docx/.doc`、Excel `.xlsx/.xls`、PowerPoint `.pptx`、RTF、純文字家族)會在伺服器端直接抽成文字讓 AI 讀懂(`lib/textExtract.ts`)；圖片/截圖走視覺模型。

## 等人簽核 / 失敗分支 / 從失敗那步續跑

- **等人簽核**：流程可以中途暫停等真人決定——「主管核准才放行」「發出前先給我確認」這種關卡放一顆「等人簽核」節點：跑到那裡就停下,把要問的內容發到你的 Telegram(訊息帶「✅核准/❌拒絕」按鈕,手機直接按)、Email(附簽核連結)或桌面通知,首頁也會出現簽核卡。核准走「核准」分支、拒絕走「拒絕」分支,可以等數小時到數天,逾時自動停止並通知。
- **失敗分支(Plan B)**：任何一步都可以接一條「出錯時走這邊」的紅色虛線——那步失敗不會讓整條流程倒下,改走你畫好的備案(改抓備用來源、發告警訊息…),備案裡可用 `{{error}}`/`{{errorStep}}` 拿到錯誤現場。也可以在 ⚡ 觸發面板設定「這條流程失敗時自動執行另一條流程」做全域備援。
- **從失敗那步續跑**：長流程跑到一半失敗,修好之後不用整條從頭來——執行紀錄上按「▶ 從失敗那步續跑」,前面成功的步驟直接沿用上次結果,只重跑失敗那步和它之後的部分(需要登入狀態的部分會誠實地一併重跑)。

![一條申請流程:AI 分類 → 多路分流 → 等主管簽核(核准/拒絕兩條分支) → 各自落檔,還掛了一條紅色虛線的「出錯時」備案](docs/screenshots/approval-flow.png)

![簽核頁:看完申請內容,填備註,按核准或拒絕,流程就繼續跑](docs/screenshots/approval-page.png)

## 觸發：排程 / 資料夾監聽 / Webhook / 收信 / Telegram / LINE

除了手動按 ▶ 執行，每條流程的 ⚡ 觸發面板有六種自動觸發方式：

- **排程**：每天/每月/每季 1,4,7,10 月/每週/cron，時間到自動觸發整張圖(headless)，「上一個期間」的日期自動算好。
- **資料夾監聽**：指定一個資料夾，有新檔案丟進來幾秒內就自動跑，檔案路徑/檔名以 `{{filePath}}`／`{{fileName}}` 流進下游節點——「把報表丟進收件匣，它自己處理」。啟用當下已存在的檔案不會觸發，只認之後新進來的；而且只對「正式」流程生效，還在邊改邊測的草稿不會在背景亂跑。
- **網頁表單**：啟用 Webhook 同時會拿到一個「表單網址」——把網址給同事,打開就是一張現成表單(欄位=流程的觸發參數),填完送出即觸發。Webhook 的人類版。
- **Webhook**：啟用後拿到一個專屬網址(網址裡的隨機 token 就是鑰匙)。手機捷徑(經由你的 Mac)、腳本、其他程式對它 POST 一個 JSON，欄位直接變成流程裡的 `{{欄位}}`。網址外流就按「重新產生」，舊網址立刻失效。
- **收信觸發(IMAP)**：「收到這種 email 就自動處理」——引擎每分鐘用 IMAP 掃一次信箱(免開瀏覽器、免驗證碼)，符合主旨/寄件人篩選的新信就觸發，下游拿 `{{from}}`／`{{subject}}`／`{{body}}`，附件自動存檔變成 `{{filePath}}`。啟用當下信箱裡已有的信不會觸發；只對正式流程生效。IMAP 帳密在設定頁填，有「測試連線」一鍵驗證(Gmail 用 `imap.gmail.com` + 跟 SMTP 同一組應用程式密碼)。另外也有一顆獨立的**讀取信箱節點**，流程中途可以直接抓一封符合條件的信。
- **Telegram 訊息**：傳訊息給你的 bot 就自動跑，下游拿 `{{message}}`——可加關鍵字篩選(如「記帳…」)讓多條流程共用同一個 bot。只認設定頁綁定的 Chat ID，陌生人搜到 bot 也觸發不了。只對正式流程生效。
- **LINE 訊息**：傳訊息給你的 LINE 官方帳號就自動跑(`{{message}}`／`{{userId}}`／`{{replyToken}}`)。雙重鎖：webhook 網址裡的隨機 token + 對 Channel Secret 的 `X-Line-Signature` 簽章驗證。要注意：LINE 平台只能打公網 HTTPS，內建的安全對外模式還沒做好前，需要先用 `cloudflared`／`ngrok` 等隧道開出去(面板有教學)。

無人值守的執行(每種觸發都是)成功/失敗都會發桌面通知——不用開網頁也知道有沒有跑成。

排程與監聽需要引擎常駐，建議裝成 daemon(重開機也在)：

```bash
scripts/install-daemon.sh     # launchd 常駐，開機自動啟動
scripts/uninstall-daemon.sh
```

![觸發面板：排程白話顯示「每季（1、4、7、10 月）1 號 早上 9:00」、資料夾監聽含「只對正式流程生效」的誠實提示、Webhook 一鍵啟用](docs/screenshots/triggers.png)

**電腦關機/睡眠時排程不會觸發**(本機常駐的本質限制)。

**排程跑失敗會自己想好修法**：正式流程排程執行失敗時，桌面跳通知，AI 也在背景先想好怎麼修。打開首頁看到「AI 已經想好怎麼修」那條，按「✅ 套用並重跑」確認即可，不用自己找問題。套用會先自動備份，隨時可在流程頁「版本」還原。

## 匯出/匯入(分享給同事)

workflow 匯出成一個 `.agenthub-workflow.json`(不含帳密)，同事匯入即成草稿，填自己的帳密即可用。

## 目錄結構

```
app/workflows/[id]/     ★ 畫布 + AI 對話(主畫面)
app/{,drafts,files,settings,schedules}/
lib/workflow/
  types.ts registry.ts        節點契約 + 節點庫註冊
  engine.ts                    執行引擎(拓樸執行/共享瀏覽器/重試/崩潰復原)
  builder.ts nodeEditor.ts     AI 建圖(clarify-first) / AI 改節點
  repair.ts                    autofix(單節點)/autorun(草稿全自動測到會跑)共用的修復邏輯
  fixProposals.ts              正式流程排程失敗時，AI 背景先想好的「修法提案」(首頁一鍵套用並重跑)
  learnedFixes.ts              修好過的問題記下來，之後遇到類似錯誤直接套
  explain.ts                   把整張流程圖翻成白話步驟說明
  store.ts                     workflow 存 data/workflows/*.json，含版本備份/還原(history/)
  nodes/*.ts                   每種積木節點
lib/aiRetry.ts                 模型呼叫重試(退避+空回應視為失敗)＋Claude Code 備援
lib/claudeCodeClient.ts        主力免費模型全掛時，自動改用本機 claude CLI 頂上
lib/textExtract.ts             上傳檔案(Excel/PDF/Word/RTF)伺服器端抽文字
lib/scheduler.ts               排程(cron 比對/next_run_at/補跑)
lib/watchers.ts                資料夾監聽觸發(10 秒掃描、DB 搶佔去重、既有檔案靜默登記)
lib/webhookStore.ts            webhook token 管理(常數時間比對)；觸發端點在 app/api/hooks/
lib/mailClient.ts               IMAP 共用層(imapflow+mailparser):帳密/篩選/抓信解析
lib/mailWatcher.ts              收信觸發(60 秒 IMAP 輪詢,同一套搶佔去重+靜默登記紀律)
lib/telegramPoller.ts          Telegram 唯一 getUpdates 消費者:簽核按鈕+訊息觸發
lib/lineHook.ts                 LINE webhook token + X-Line-Signature 簽章驗證;端點在 app/api/line-hooks/
lib/notify.ts                  排程完成/失敗的桌面通知(macOS)
data/                          本機狀態(gitignore)：DB、workflow、debug截圖、產出檔
docs/ARCHITECTURE_V2.md        當初的設計規劃文件(部分已過時，程式碼與本 README 為準)
```

## 開發

```bash
npm run test    # 跑核心邏輯的單元測試(相對日期解析、節點圖檢查、JSON 抽取、cron、資料夾監聽規則等純函式)
npm run lint    # ESLint
node scripts/regression.mjs [起 訖]   # 複雜需求回歸庫:代表性白話需求真的讓 AI 建圖並驗結構(吃模型額度,發版前手動跑)
```

## 安全性

- **金鑰不寫在程式碼裡**：從 `.env`（`AGENT_HUB_API_KEY`，已 gitignore）或設定頁讀取，不會進版控。
- `data/` 全 gitignore；帳密明碼存本機 SQLite(等同瀏覽器記密碼)，勿同步雲端。
- AI 建圖/改節點前會先讓你預覽確認，並自動備份可還原。
- **這是單人本機工具，預設就只綁 `127.0.0.1`**(`npm run dev`/`npm run start` 都帶 `-H 127.0.0.1`，別的裝置連不到)。**不要自己改成 `-H 0.0.0.0` 或架到公開網路**——`custom-code`(AI 依需求寫的自訂步驟)與 `http-request` 節點會在本機執行程式碼/連任意網址，對外開放等同 RCE/SSRF 風險。
- **內建跨站防護**(`proxy.ts`)：只綁 127.0.0.1 擋不住「瀏覽器幫惡意網頁發請求到 localhost」——你一邊開著 Agent Hub、一邊瀏覽惡意網頁時，該網頁可以隔空對本機 API 塞入並執行流程。所以所有 `/api` 請求都會驗證 Host(擋 DNS rebinding)，非 GET 請求另外驗證 Origin 必須是本機來源，外部網站的跨站請求一律 403。
- **`custom-code` 節點會以你的使用者權限在本機執行 AI 產生的程式碼**——這是「AI 幫你寫自訂步驟」功能的本質。程式碼在套用前看得到、可以先讀過再執行；不放心的流程就不要用 custom-code 節點。
- **Webhook 網址就是鑰匙**：路徑裡的隨機 token 用常數時間比對，token 錯誤跟流程不存在回一模一樣的 404(無法探測)。伺服器只聽 127.0.0.1，本來就只有這台電腦上的程式打得到。
- **模型備援**：主力用你設定的免費 API；整串重試都失敗時，若本機裝了 Claude Code CLI 會自動頂上一次(見 `lib/aiRetry.ts`)，不是每次都打、不會產生額外花費。
- 授權：MIT（見 `LICENSE`）。
