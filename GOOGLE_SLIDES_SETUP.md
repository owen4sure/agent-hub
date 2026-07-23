# 讓 Agent Hub 更新 Google 簡報圖表

這份設定只做一件事：讓 workflow **直接用 Google 官方的 Slides API**，更新 Google 簡報中「連結到 Google 試算表」的圖表。

你不需要知道 API、OAuth 或 MCP 是什麼。Agent Hub 會在安全試跑時先確認它看得到正確的簡報與圖表，**不會改動簡報**；只有你正式執行時才會更新。

> MCP 不是這條 workflow 的必要設定。它是某些外部 AI 產品用來讀資料的連接方式，不能讓 Agent Hub 自動取得權限，也不能取代正式執行所需的 Google 授權。為避免使用者設定一堆卻仍然跑不動，這個產品的正式執行只依賴官方 Slides API。

## 第一次設定（約 10–15 分鐘）

### 1. 建立一個 Google Cloud 專案

1. 開啟 [Google Cloud Console](https://console.cloud.google.com)，用**擁有該簡報權限**的 Google 帳號登入。
2. 頁面上方按「選取專案」→「新增專案」。
3. 名稱可填 `Agent Hub`，按「建立」，等待上方切換到新專案。

### 2. 打開簡報功能

1. 左上角「≡」→「API 和服務」→「已啟用的 API 和服務」。
2. 按「+ 啟用 API 和服務」，搜尋 **Google Slides API**。
3. 點進去按「啟用」。

### 3. 告訴 Google 這是你自己的小工具

1. 在「API 和服務」點「OAuth 同意畫面」。
2. 使用者類型選「外部」，應用程式名稱填 `Agent Hub`，聯絡信箱填你自己。
3. 一路按「儲存並繼續」。出現「測試使用者」時，務必把你自己的 Google 帳號加進去。

### 4. 建立三串一次性設定代碼

1. 到「API 和服務」→「憑證」→「+ 建立憑證」→「OAuth 用戶端 ID」。
2. 應用程式類型選「電腦版應用程式」，按「建立」。
3. 記下畫面上的 **Client ID** 與 **Client Secret**。
4. 開啟 [Google OAuth Playground](https://developers.google.com/oauthplayground)，右上角齒輪勾選「Use your own OAuth credentials」，貼上剛剛兩串代碼。
5. 左側輸入並加入這一行：`https://www.googleapis.com/auth/presentations`
6. 按「Authorize APIs」，登入同一個 Google 帳號並同意授權。若看到「未經驗證的應用程式」，這是你剛建立、只供自己使用的工具；確認名稱正確後按「進階」繼續即可。
7. 回到 Playground，按「Exchange authorization code for tokens」，複製 **Refresh token**。

### 5. 回到 Agent Hub，不必自己找欄位

建立含「重新整理 Google 簡報圖表」的流程後，對話會直接出現三個安全輸入欄位。依序貼入 Client ID、Client Secret、Refresh Token 後，再按「測到會跑」。

## 很重要：避免每週都要重新授權

若 OAuth 同意畫面仍是「測試中」，Google 對一般資料存取權限發出的 refresh token 可能在 **7 天後失效**。在你確認流程可用、要拿來排程前，回到「OAuth 同意畫面」把發布狀態改為「發布到正式環境」；Google 仍可能顯示未驗證提醒，這是私人自建工具常見情況。若你的公司帳號被組織政策限制，請請管理員允許這個 Cloud 專案或改用公司核准的帳號。

## 安全試跑會檢查什麼

- Google 授權是否有效。
- 這個帳號是否看得到指定簡報。
- 簡報中是否真的存在連結到指定試算表的圖表。

安全試跑不會更新圖表；正式執行才會更新。Google 官方將更新圖表定義為 `RefreshSheetsChartRequest`，經由 `presentations.batchUpdate` 執行；Agent Hub 正是走這個官方路徑。[Google 官方說明](https://developers.google.com/workspace/slides/api/samples/elements)

卡住時直接把畫面截圖貼進 workflow 對話即可；不要貼 Client Secret 或 Refresh Token 到文字訊息，請只用對話出現的安全輸入欄位。
