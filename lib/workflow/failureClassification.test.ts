import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, isDeterministicValidationFailure } from "./engine";

describe("classifyFailure", () => {
  it("缺少試算表網址歸類為設定，不會誤叫使用者檢查密碼", () => {
    const result = classifyFailure("尚未填入試算表寫入網址");
    assert.equal(result.category, "configuration");
    assert.doesNotMatch(result.reason, /帳號密碼/);
    assert.match(result.reason, /設定/);
  });

  it("Apps Script 舊部署是外部設定，不讓 AI 自動修復空轉", () => {
    const result = classifyFailure("執行前檢查發現 Google Sheet 寫入服務還不能使用：Apps Script 部署版本太舊");
    assert.equal(result.category, "configuration");
    assert.equal(result.resolution, "needs-human");
  });

  it("真正的密碼錯誤仍歸類為帳密", () => {
    assert.equal(classifyFailure("帳號密碼錯誤").category, "credentials");
  });

  it("上游資料未產出仍交給整圖修復", () => {
    assert.equal(classifyFailure("上游節點沒有解析到實際資料").category, "ai-fixable");
  });

  it("驗證碼視覺服務整體沒回應時不誘導使用者叫 AI 改流程圖，且標成暫時性問題可自動重跑", () => {
    const result = classifyFailure("驗證碼視覺模型目前沒有回應");
    assert.equal(result.category, "configuration");
    assert.equal(result.resolution, "needs-human");
    assert.equal(result.transient, true);
  });

  it("非暫時性的失敗(帳密錯誤/邏輯問題)不標成 transient，不會被排自動重跑", () => {
    assert.equal(classifyFailure("帳號密碼錯誤").transient, false);
    assert.equal(classifyFailure("上游節點沒有解析到實際資料").transient, false);
    assert.equal(classifyFailure("尚未填入試算表寫入網址").transient, false);
  });

  it("Apps Script 執行當下找不到指令碼函式(doGet)是實測過的偶發性問題，標成可自動重跑", () => {
    const result = classifyFailure("Apps Script 執行失敗：找不到以下指令碼函式：doGet");
    assert.equal(result.transient, true);
    assert.equal(result.category, "configuration");
  });

  it("既有自訂步驟被清空後的 AI 產碼逾時，要說出真正原因而不是叫使用者亂調設定", () => {
    const result = classifyFailure("自訂步驟「計算數字」沒有可執行程式碼，正在由 AI 臨時產碼但 180 秒內沒有完成；這不是 Excel、資料或其他節點設定的問題。");
    assert.equal(result.category, "ai-fixable");
    assert.match(result.reason, /沒有保存可執行程式碼/);
    assert.match(result.reason, /不要重跑或手動調整其他節點/);
  });

  it("兩張表的日期互相矛盾是資料問題，相同 input 不會白等三次", () => {
    const message = "主管報告資料日 2026-07-08 早於週增量結束日 2026-07-14，兩張表的日期設定互相矛盾";
    assert.equal(classifyFailure(message).category, "data");
    assert.equal(classifyFailure(message).resolution, "needs-human");
    assert.equal(isDeterministicValidationFailure("custom-code", new Error(message)), true);
    assert.equal(isDeterministicValidationFailure("http-request", new Error(message)), true);
  });

  it("掃過所有候選頁面、內容跟預期兜不上是資料問題，不是選擇器問題，不能讓 AI 一直瞎猜選擇器", () => {
    const message = "找不到目標頁面：沒有任何一頁同時符合「業績總覽表」標題、「1.存款」綠色標籤、以及「週成長趨勢」折線圖(含A通路/B通路/C通路/D通路/E通路圖例)，詳見 log 中每頁掃描結果";
    const result = classifyFailure(message);
    assert.equal(result.category, "data");
    assert.equal(result.resolution, "needs-human");
  });

  it("Google OAuth refresh token 失效(invalid_grant)歸帳密類，需人工重新走 OAuth 流程，不是改設定或重試能救", () => {
    const message = "Google OAuth 憑證已失效(invalid_grant)：refresh token 被撤銷、過期，或帳號密碼/兩步驟驗證設定已變更。需要重新走一次 OAuth 流程拿新的 refresh token";
    const result = classifyFailure(message);
    assert.equal(result.category, "credentials");
    assert.equal(result.resolution, "needs-human");
  });

  it("Google OAuth 用戶端 ID/密鑰貼錯(invalid_client)也要歸帳密類——這是 invalid_grant 的漏網之魚，真實跑過才發現只顧到一種 OAuth 錯誤", () => {
    const message = "Google OAuth 用戶端 ID(Client ID)或密鑰不正確(invalid_client)。請重新確認 Google Cloud Console 的 OAuth 2.0 用戶端 ID／密鑰是否貼對，到設定頁重新填入。";
    const result = classifyFailure(message);
    assert.equal(result.category, "credentials");
    assert.equal(result.resolution, "needs-human");
  });

  it("尚未設定 Google OAuth 憑證歸類為設定缺漏，不是密碼打錯", () => {
    const result = classifyFailure("尚未設定 Google OAuth 憑證——請到「設定」頁最下面照教學建立 Google Cloud 專案＋OAuth 用戶端，填入 Client ID／密鑰／Refresh Token");
    assert.equal(result.category, "configuration");
    assert.equal(result.resolution, "needs-human");
  });

  it("把 ExcelJS 的 central directory 技術錯誤翻成使用者能採取動作的檔案格式提示，不叫 AI 空轉", () => {
    const result = classifyFailure("Can't find end of central directory : is this a zip file ?");
    assert.equal(result.category, "data");
    assert.equal(result.resolution, "needs-human");
    assert.match(result.reason, /不是有效的 .xlsx/);
    assert.match(result.reason, /不需要叫 AI 重跑/);
  });

  // 真實踩過的案例：使用者的 Apps Script 部署/授權問題都解決之後，緊接著撞上「找不到分頁: X」——
  // AI 沒有辦法連進使用者的 Google 試算表去看裡面實際有哪些分頁，只能對著這句話瞎猜著改設定，
  // 猜不中當然一直卡著、使用者看起來像是「AI 修很久都沒改變」。這種錯誤只有使用者本人知道
  // 正確的分頁名稱是什麼(可能被改名、或原始設定跟試算表裡的不完全一樣，連多一個空格都算不同)，
  // 必須歸類成需人工，不能讓修復迴圈對著它空轉。
  it("Apps Script 寫入時找不到分頁是使用者才知道答案的事，不能讓 AI 修復迴圈瞎猜著空轉", () => {
    const message = "試算表那端拒絕寫入：找不到分頁: 每週業績折線圖_業務週會";
    const result = classifyFailure(message);
    assert.equal(result.category, "data");
    assert.equal(result.resolution, "needs-human");
  });

  // 同一類漏網之魚：excelProcess.ts 找不到指定欄位時也會列出實際欄位清單，AI 一樣沒辦法
  // 連進使用者的真實 Excel 檔案去確認正確欄名是什麼，只能瞎猜，跟「找不到分頁」是同一種
  // 「只有使用者知道答案」的情境，必須同樣歸類成需人工。
  it("Excel 找不到指定的欄位一樣是使用者才知道答案的事，不能讓 AI 瞎猜欄名空轉", () => {
    const message = "找不到要 highlight 的欄「待補貨狀態」。這個分頁的欄位有：品項、數量、單價";
    const result = classifyFailure(message);
    assert.equal(result.resolution, "needs-human");
  });

  // Telegram Chat ID / LINE 傳送對象 ID 錯誤是跟 Token 同一類「只有使用者能取得的識別碼」，
  // 但這兩則訊息沒有出現「Token」字樣，原本的帳密規則抓不到，會掉到預設的 ai-fixable，讓
  // 修復迴圈對著使用者自己才能取得的 ID 一直空轉重試。
  it("Telegram Chat ID／LINE 傳送對象 ID 不正確要歸類成需人工帳密類，不是 AI 能重試修好的", () => {
    const telegram = classifyFailure("Telegram Chat ID 不正確(找不到聊天)——請先在 Telegram 跟你的 bot 說一句話，再到設定頁按「自動偵測」重抓 Chat ID");
    assert.equal(telegram.resolution, "needs-human");
    assert.equal(telegram.category, "credentials");
    const line = classifyFailure("LINE 的傳送對象 ID 不正確——1對1 用 LINE Developers Basic settings 最下方的 Your user ID(U 開頭)");
    assert.equal(line.resolution, "needs-human");
    assert.equal(line.category, "credentials");
  });

  it("選擇器、欄位與分頁這類結構性錯誤第一次就停下，不拿同一份設定重跑", () => {
    assert.equal(isDeterministicValidationFailure("browser-login", new Error("找不到帳號欄位元素(選擇器 input[name='USER'])")), true);
    assert.equal(isDeterministicValidationFailure("excel-process", new Error("找不到分頁「月報週會報告用」")), true);
    assert.equal(isDeterministicValidationFailure("http-request", new Error("503 service unavailable")), false);
  });
});
