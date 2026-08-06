# 安全政策與威脅模型 / Security Policy

> English summary at the bottom.

這份文件回答資安審查會問的問題：**這個工具的信任邊界在哪、它防什麼、它明確不防什麼、你的資料會流到哪裡。**
安全相關的設計原本散落在 `AGENTS.md`、`proxy.ts` 與 `lib/urlGuard.ts` 的註解裡；這裡把它們集中成一份可以直接交出去的文件。

---

## 1. 這是什麼工具（先講清楚定位）

Agent Hub 是**單人、本機自架**的自動化平台。它只綁 `127.0.0.1`，資料放在 `data/`（目錄 0700、DB 0600），
沒有帳號系統、沒有多租戶、沒有 SSO。

它的核心能力之一是「現成節點做不到的事，讓 AI 寫一段程式碼來做」——這代表**平台設計上就會在你的電腦上執行程式碼**。
這不是漏洞，是它的功能。下面第 4 節說明這件事的邊界在哪。

**適用**：個人與小團隊在自己的機器上自動化自己的工作。
**不適用**：多使用者共用、需要人員層級稽核與 RBAC、資料不得離開內網、或需要「不論電腦是否開機都要準時執行」的場景。

---

## 2. 信任邊界

| 對象 | 信任程度 | 依據 |
|---|---|---|
| 使用者本人（同一個 OS 帳號） | **完全信任** | 他本來就擁有這台機器上的一切 |
| 以同一個 OS 帳號執行的其他程式 | **信任（無法不信任）** | 它讀得到 `.env`、`data/*.db`、瀏覽器 session 檔，不需要經過 Agent Hub |
| 同一台機器的其他 OS 帳號 | **不信任** | `data/` 0700 + 本機存取權杖 |
| 瀏覽器裡的任何網頁 | **不信任** | Host / Origin 檢查 + SameSite=Strict 權杖 cookie |
| 匯入的 workflow 檔案 | **不信任** | 匯入時清空所有 `custom-code` 的程式碼 |
| 使用者提供的網址與檔案 | **不信任** | SSRF 防護、渲染用瀏覽器全封網路、ZIP 路徑淨化 |
| 外部 AI 模型的輸出 | **不信任** | 一律過確定性驗證（結構檢查、語法檢查、選項比對），不靠提示詞自律 |

---

## 3. 已實作的防護

- **跨站與 DNS rebinding**（`proxy.ts`）：所有 `/api` 驗 Host 白名單；非 GET 驗 Origin。
  沒有這一層，任何網頁都能隔空叫本機 API 匯入並執行含 `custom-code` 的流程。
- **本機存取權杖**（`lib/localToken.ts`）：所有 `/api` 需要 `data/local-token`（0600）的權杖，
  瀏覽器透過 httpOnly + SameSite=Strict cookie 自動帶上。白名單只有四條，各自有自己的認證：
  webhook 與 LINE webhook（網址內的 token、常數時間比對、錯誤一律回相同 404）、
  Google OAuth 導回（`state` 參數防 CSRF）、健康檢查（唯讀狀態）。
- **縱深防禦**（`lib/requireLocal.ts`）：帳密、流程增刪改、執行、匯入、開瀏覽器、抓網址這幾支
  在 handler 內再驗一次權杖——proxy 這種「應用程式前面的一層」被整層繞過是真實發生過的漏洞類別。
- **匯入清空程式碼**：`custom-code` 的 `code` 一律清空（含 `repeat-steps` 內嵌步驟，遞迴處理），
  第一次執行時由可信的產碼流程依 intent 重新產生。
- **SSRF**（`lib/urlGuard.ts`）：進門驗主機名，並在瀏覽器內攔截**每一個**子請求與轉址，
  阻擋 loopback、私有網段與雲端 metadata（只驗進門會被 302 或一張 `<img>` 繞過）。
  渲染使用者檔案的瀏覽器全封網路。
- **只讀安全排練的隔離**（`lib/workflow/customCodeProcessSandbox.ts`）：dry-run 的 `custom-code`
  在獨立子程序執行，套用 Node OS 權限白名單、模組白名單、不繼承環境變數、瀏覽器只給唯讀介面。
- **帳密加密與權限**：`data/` 0700、DB 與備份 0600、帳密以 AES-256-GCM 加密後才進 DB；
  明碼還原是獨立的 POST 端點，需要使用者主動點擊，且會寫入稽核軌跡。
- **金鑰不跟密文住在一起**（`lib/keychain.ts` / `lib/secretVault.ts`）：macOS 上金鑰存在
  login Keychain（服務名 `agent-hub-secret-vault`），離線拷走整個 `data/` 只拿得到密文。
  既有安裝啟動時自動遷移（讀回驗證一致才刪舊金鑰檔；Keychain 讀不到時大聲報錯，
  絕不重生金鑰）。跨機還原：`npm run key:export` / `npm run key:import`。非 macOS 退回金鑰檔。
- **備份裡沒有明文登入狀態**（`lib/dataBackup.ts`）：browser-sessions（等同已登入的 cookies）
  加密後才進備份 zip；備份可另設 `backupMirrorDir` 多抄一份到外接碟/iCloud（異地備份）。
- **稽核軌跡**（`lib/auditLog.ts`）：核准／拒絕、流程增刪改、帳密讀寫、手動觸發、設定與排程變更。
- **資料保留期限**（`lib/retention.ts`）：除錯截圖與頁面內容預設 90 天後刪除。
- **相依漏洞閘門**（`scripts/audit-gate.mjs`）：high/critical 一律卡住 CI；例外必須寫理由與到期日。

---

## 4. 已接受的殘餘風險（不假裝解決了）

### 4.1 正式執行的 `custom-code` 在主程序內以完整權限執行

`lib/workflow/nodes/customCode.ts`：只有 `ctx.dryRun` 走子程序沙箱，**正式執行走 `new AsyncFunction`**，
在 Next.js 主程序內執行，可存取整個檔案系統、`process.env`、任意網路與整個 `data/`。

這是刻意的取捨，因為正式執行必須共用同一個瀏覽器 session、寫入產出檔、動態載入套件——
把它移進沙箱會讓「登入一次接著做十件事」這類流程無法運作。

**風險邊界**：能觸發執行的人 = 使用者本人（或以他的 OS 身分執行的程式）。前者本來就有完整權限；
後者也本來就有完整權限（它可以直接讀 `.env` 與 DB，不需要經過這個平台）。
本機存取權杖擋的是「其他 OS 帳號」與「瀏覽器裡的網頁」，**不是**同帳號的惡意程式——
在那個情境下，繞過 Agent Hub 反而比利用它容易。

**若你的環境不接受這個假設**（多人共用主機、公司機器上跑著大量不可控的內部工具），
這個工具就不適合在那台機器上執行；這不是設定可以調的事。

### 4.2 執行現場資料會送到外部 AI API

README 的訴求是 local-first，這一項必須明確揭露：以下情況會把資料送到 `AGENT_HUB_BASE_URL` 指向的模型 API
（預設 `https://api.openai.com/v1`，可改成任何 OpenAI 相容端點，包含地端模型）：

| 什麼時候 | 送出什麼 |
|---|---|
| 用白話建立／修改流程 | 你打的需求、目前流程結構、附加的檔案內容 |
| 產生 `custom-code` | 節點的 intent（白話說明） |
| 「讓 AI 修」／自動測到會跑 | 失敗節點實際收到的 input、頁面 HTML、失敗截圖 |
| `llm-decide` 節點 | 該節點收到的資料與你設定的提示詞 |
| 語意驗收 | 節點意圖與實際輸出的摘要 |

也就是說：**流程「自己跑」時資料留在本機，但只要 AI 參與判斷或修復，執行現場的資料就會離開這台電腦。**
不希望資料離開的話，把 `AGENT_HUB_BASE_URL` 指向地端模型（任何 OpenAI 相容的本機服務都可以）。

### 4.3 沒有人員層級的身分與授權

沒有使用者、沒有 RBAC、沒有 SSO/SCIM。稽核軌跡記到「管道」等級（本機瀏覽器／腳本／Telegram／簽核連結），
回答得了「這件事從哪個入口發生」，回答不了「是哪一個人」。

### 4.4 排程受限於本機

電腦關機或睡眠時排程不會執行。這是 local-first 的先天限制，不是 bug。

### 4.5 `xlsx` 從官方 CDN 安裝，不走 npm registry

`package.json` 的 `xlsx` 指向 `https://cdn.sheetjs.com/...`——這是 SheetJS 官方目前的發布方式（他們已退出 npm registry）。
影響：`npm audit` 掃不到這個套件、離線／私有 registry 環境無法安裝、SBOM 產出時這筆相依缺來源資訊。

---

## 5. 通報漏洞

請**不要**開公開 issue。用 GitHub 的 Security Advisory（repo → Security → Report a vulnerability），
或透過 repo 首頁的聯絡方式私下回報。

請附上：影響版本（`/api/health` 的 `version`）、重現步驟、以及你認為的影響範圍。

**回應時間**：這是一個維護者的專案（bus factor = 1），沒有 SLA。
會盡量在 7 天內回覆確認，並在確認為漏洞後於下一個版本修補。

**什麼算漏洞、什麼是已知取捨**：第 4 節列的都是已接受的取捨，不算漏洞。
以下算：任何讓「網頁／其他 OS 帳號／外部服務」繞過第 3 節防護的方法；
`proxy.ts` 或本機權杖的繞過；SSRF 防護的繞過；匯入清空程式碼的繞過；帳密在非預期路徑外洩。

## 6. 支援版本

只維護 `main` 上的最新版本。修補會發成新的 patch/minor 版本並打 tag，不回溯支援舊版本。

---

## English summary

Agent Hub is a **single-user, self-hosted, local-first** automation tool bound to `127.0.0.1`.
It has no user accounts, no RBAC and no SSO, and it **executes AI-generated code on your machine by design**.

- **Defended**: cross-site requests and DNS rebinding (Host/Origin checks plus a SameSite=Strict local token),
  other OS accounts on the same host (0700 data dir + 0600 token file), imported workflows
  (all `custom-code` is stripped on import), SSRF on user-supplied URLs, and untrusted model output
  (always validated deterministically).
- **Accepted residual risk**: in production runs, `custom-code` executes in the main process with full user
  privileges — a deliberate trade-off (shared browser session, file output, dynamic imports). The local token
  does **not** protect against malware running as the same OS user; such code already has full access to
  `.env` and the database without going through this app. Do not run this tool on a shared or untrusted host.
- **Data flow**: workflow execution is local, but whenever AI is involved (building, fixing, `llm-decide`,
  semantic checks) the relevant runtime data — node inputs, page HTML, failure screenshots — is sent to the
  model endpoint configured in `AGENT_HUB_BASE_URL`. Point it at a local model if data must not leave the machine.
- **Reporting**: use GitHub Security Advisories, not public issues. Single maintainer, no SLA; best effort
  acknowledgement within 7 days.
