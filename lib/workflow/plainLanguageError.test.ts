import assert from "node:assert/strict";
import test from "node:test";
import { conciseRuntimeError } from "./plainLanguage";

test("執行紀錄不顯示 Playwright ANSI 與 disabled 欄位的數十行 call log", () => {
  const raw = '在「登入 Webmail」這步失敗：page.fill: Timeout 30000ms exceeded.\nCall log:\n\u001b[2m - locator resolved to <input disabled name="USERID_show"/>\u001b[22m\n - element is not enabled｜AI 可修：請重試';
  const shown = conciseRuntimeError(raw);
  assert.equal(shown, "在「登入 Webmail」這步失敗：帳號欄位已由網站預填並鎖定，舊版仍重複輸入而逾時。｜AI 可修：請重試");
  assert.doesNotMatch(shown, /\u001b|Call log|locator resolved/);
});

// 真實踩過的新手第一印象事故：建圖總結說「把資料追加到桌面的「0」」——檔名整個消失只剩一個 0。
// 根因是 plainLanguage 的字面值保護會巢狀(檔名先被檔名規則收走、包住它的「」引號再把含佔位符的
// 內容整段收走)，而還原只掃一趟，內層佔位符字面留在輸出裡(頭尾是看不見的私有區字元，只剩索引數字)。
// 這條測試釘住：引號包住的檔名經過白話化必須原封不動活著回來。
test("plainLanguage：引號裡的檔名(巢狀保護)白話化後必須完整保留，不能變成佔位符數字", async () => {
  const { plainLanguage } = await import("./plainLanguage");
  const message = "把今天日期和股價追加一行到桌面的「台積電股價.xlsx」（第一次執行時會自動建立這個檔案）";
  assert.equal(plainLanguage(message), message);
  const multi = "先讀「來源.xlsx」再寫「彙整結果.csv」，最後通知";
  assert.equal(plainLanguage(multi), multi);
});
