import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 這裡守的是一個真實踩過的 bug：`openManualLoginInner` 拿到 `sharedSessionKey ?? workflowId`
 * 算出的 `storageKey` 之後，內部真正讀寫檔案的 `loadState`/`saveStateFile` 呼叫點卻還留著改之前
 * 的 `workflowId`，等於「算出了正確的共用代號，但完全沒有拿去用」——手動登入視窗開啟時沿用的是
 * 這條流程自己的舊狀態(不是共用池)，登入完存回去的也是這條流程自己專屬的檔案，而不是共用檔案。
 * 使用者實測：手動登入完全成功，但因為存錯檔案，其他 11 條共用同一帳號的流程完全吃不到這次登入。
 *
 * 跟其他背景/瀏覽器自動化模組同一套理由：真的開瀏覽器測太慢，這裡守的是「呼叫點用的是哪個變數」，
 * 這是讀原始碼就能百分之百確認、不需要真的開瀏覽器的事實。
 */
const source = fs.readFileSync(path.join(process.cwd(), "lib/workflow/manualLogin.ts"), "utf8");

test("開新 context 時載入的是 storageKey 對應的狀態，不能是 workflowId(踩過：算出共用代號卻沒拿去用)", () => {
  assert.match(source, /const savedState = loadState\(storageKey\);/);
  assert.doesNotMatch(source, /loadState\(workflowId\)/, "不能再用 workflowId 直接讀狀態檔");
});

test("每次存檔(saveNow)寫的是 storageKey 對應的檔案，不能是 workflowId", () => {
  const fnBody = /const saveNow = async \(\) => \{[\s\S]*?\n  \};/.exec(source)?.[0] ?? "";
  assert.match(fnBody, /saveStateFile\(storageKey, state\);/);
  assert.doesNotMatch(fnBody, /saveStateFile\(workflowId,/, "不能再用 workflowId 直接存狀態檔");
});

test("視窗真正結束(disconnected)只收尾一次，不管是使用者按關閉還是直接叉視窗都要觸發驗證", () => {
  assert.match(source, /browser\.on\("disconnected", finalize\);/);
  const fnBody = /const finalize = \(\) => \{[\s\S]*?\n  \};/.exec(source)?.[0] ?? "";
  assert.match(fnBody, /if \(finalized\) return;/, "要防止兩條收尾路徑重複觸發驗證");
  assert.match(fnBody, /void runVerification\(workflowId, storageKey, url\);/);
});

test("開新一輪手動登入時要清掉舊的驗證結果，不能讓畫面顯示上一輪的答案", () => {
  assert.match(source, /lastVerification\.delete\(workflowId\); \/\/ 開新的一輪/);
});

test("驗證邏輯要用跟 browser-login 節點判斷『登入成功』同一套 isAuthenticated 標準，不能自己另外發明一套", () => {
  assert.match(source, /import \{ isAuthenticated \} from "\.\/nodes\/browserLogin";/);
  const fnBody = /async function runVerification[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  assert.match(fnBody, /await isAuthenticated\(page\)/);
});

test("完全沒有存到任何登入狀態時要老實回報，不能拋錯或誤判成功", () => {
  const fnBody = /async function runVerification[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  assert.match(fnBody, /if \(!state\) \{/);
  assert.match(fnBody, /verified: false,/);
});
