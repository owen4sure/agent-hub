# 貢獻指南 / Contributing

這個 repo 有一套不太一般的規則，**動手前先讀完這一頁**——不是形式，是因為裡面每一條都對應一個真的踩過的事故。

## 先讀這五份（不是選讀）

| 文件 | 它回答什麼 |
|---|---|
| `AGENTS.md` | 不可違反的鐵則（每一條都附「踩過的真實案例」），含 Next.js 版本注意事項 |
| `PROJECT_GOAL.md` | 產品終極目標與驗收優先順序——判斷「這個改動符不符合方向」 |
| `DEPENDENCY_MAP.md` | 一級資料流與「動到這個檔案會牽動什麼」 |
| `ARCHITECTURE.md` | 分層職責與不可破壞的架構規則 |
| `CHANGE_CONTROL.md` | 動手前的五問、實作時的閘門、`CHANGELOG.md` 的記錄格式 |

**這條規則對 AI 工具同樣適用**（Claude Code / Codex / Cursor 都在這個 repo 上改過東西）。
不同工具靠各自的訓練直覺去改，很容易在別人看不到的地方悄悄弄壞已經驗證過的功能——
這幾份文件加上 `npm run check:change-guard` 就是讓「換工具」不等於「換規則」的唯一防線。

## 開發環境

```bash
npm install          # postinstall 會一併裝 chromium 與 pre-commit hook
npm run doctor       # 環境健檢，有 ❌ 就照它給的修法處理
npm run dev          # http://127.0.0.1:3000
```

需要 **Node 24 以上**（`package.json` 的 `engines` 有宣告）。npm 10/11 對 lock 檔的格式不同，
混用會在 `npm ci` 假報 out-of-sync。

## 交出來之前一定要跑

```bash
npx tsc --noEmit
npm test                      # 950+ 個測試
npm run check:change-guard    # 治理底線 + lint + 隱私掃描
npm run check:audit           # 相依漏洞閘門（high/critical 一律擋）
```

改到 UI 的話，**要真的打開瀏覽器看過**——「型別過了、測試綠了」跟「使用者看到的畫面是對的」是兩件事，
這個 repo 有一整串只有截圖才抓到的問題記錄。

## Pull Request 要寫什麼

`CHANGE_CONTROL.md` 定義的格式，重點是三段：

1. **使用者原本會遇到什麼問題**（不是「重構了 X」，而是「使用者按了 X 之後畫面一片空白」）
2. **改了什麼、為什麼是這個做法**（尤其是「為什麼不用看起來更簡單的那個做法」）
3. **怎麼驗證的**——實際跑過什麼、輸出是什麼。沒驗證的部分要**明說沒驗證**，不要寫「應該沒問題」

同時在 `CHANGELOG.md` 的 `## Unreleased` 加一條，格式照現有的寫（`類型｜使用者結果｜改動範圍｜驗證方式`）。

## 不會被接受的改動

- 拿掉或加豁免給 `proxy.ts` 的跨站防護、本機存取權杖、匯入時清空 `custom-code`、SSRF 防護
- 前端整包送 `nodes` 回去存（會無聲蓋掉 AI 剛修好的設定，`AGENTS.md` 第 1 條）
- 用貪婪 regex 解析模型回的 JSON（第 4 條）
- 把「AI 修復」退回成只看靜態圖或只改單一節點（第 8、10 條）
- 靠提示詞約束模型行為，而不是用程式碼裡的 `if` 做確定性驗證（迴圈工程守則）
- 靜默失敗：吞掉錯誤、預設值代替真實資料、「表面成功實際什麼都沒做」

## 隱私（這一條特別重要）

這個 repo 的作者用它自動化真實工作，所以 **commit 前會自動掃隱私黑名單**（pre-commit hook）。
黑名單本身是 gitignore 掉的私人清單（`data/privacy-blocklist.txt`），只存在作者機器上；
外部貢獻者的環境不會有它，掃描會明確告訴你「這一項沒有檢查」。

實務上請遵守：**測試資料、範例、截圖一律用中性名稱**（`公司A`、`專案X`、`report.xlsx`），
不要出現看起來像真實公司、產品、內部系統或客戶的名字。

## 授權

送 PR 表示你同意以 MIT 授權貢獻你的程式碼。

安全問題請不要開 issue，見 `SECURITY.md`。
