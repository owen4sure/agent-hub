import assert from "node:assert/strict";
import test from "node:test";
import { conciseRuntimeError } from "./plainLanguage";

test("執行紀錄不顯示 Playwright ANSI 與 disabled 欄位的數十行 call log", () => {
  const raw = '在「登入 Webmail」這步失敗：page.fill: Timeout 30000ms exceeded.\nCall log:\n\u001b[2m - locator resolved to <input disabled name="USERID_show"/>\u001b[22m\n - element is not enabled｜AI 可修：請重試';
  const shown = conciseRuntimeError(raw);
  assert.equal(shown, "在「登入 Webmail」這步失敗：帳號欄位已由網站預填並鎖定，舊版仍重複輸入而逾時。｜AI 可修：請重試");
  assert.doesNotMatch(shown, /\u001b|Call log|locator resolved/);
});
