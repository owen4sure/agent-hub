import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldAutoInspectRuntime } from "./runtimeInspectionIntent";

test("對話自動讀取現場：明確要求先看檔案時才安全試跑", () => {
  assert.equal(shouldAutoInspectRuntime("你先去附件看 H6 對應的欄位，再告訴我抓什麼資料"), true);
});

test("對話自動讀取現場：明說不要執行時，不能因為提到讀檔節點而偷跑", () => {
  assert.equal(shouldAutoInspectRuntime("請只改讀取檔案這個節點，先不要執行。附件只是讓你了解資料格式。"), false);
  assert.equal(shouldAutoInspectRuntime("不要重跑流程，我只是問這個 Excel 分頁的用途"), false);
});

// 真實踩過的事故：範圍只認得「檔案/附件/試算表」這類字眼，使用者說「去 Google Drive 看最新簡報」
// 完全不會觸發真實檢查，AI 只能憑聊天裡貼過的截圖判斷，看到截圖不等於驗證了真正的簡報內容。
test("對話自動讀取現場：Google Drive/簡報/網頁/網址/信箱這類說法也要能觸發真實檢查", () => {
  assert.equal(shouldAutoInspectRuntime("你先去 Google Drive 看一下最新的簡報"), true);
  assert.equal(shouldAutoInspectRuntime("幫我查看 Google Slides 裡的圖表對不對"), true);
  assert.equal(shouldAutoInspectRuntime("你打開網頁看看現在的內容"), true);
  assert.equal(shouldAutoInspectRuntime("先打開這個網址確認一下"), true);
  assert.equal(shouldAutoInspectRuntime("你先去信箱確認一下那封信"), true);
});
