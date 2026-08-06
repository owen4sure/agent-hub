import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describeRecording, scrubRecordedSecrets, toNodeCode } from "./actionRecorder";

/** Playwright codegen 真實產出的形狀(含它固定的 boilerplate)。 */
const RAW = `const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://mail.example.invalid/');
  await page.fill('input[name="USERID"]', 'owen');
  await page.fill('input[name="PASSWD"]', 'super-secret-pw');
  await page.getByRole('button', { name: '登入' }).click();
  await page.getByText('寫信').click();
  await page.fill('textarea[name="to"]', 'someone@example.invalid');

  // ---------------------
  await context.close();
  await browser.close();
})();
`;

test("錄製轉成節點程式碼：去掉自己開瀏覽器的 boilerplate，改用流程共用的分頁", () => {
  const { code, actionCount } = toNodeCode(RAW);
  assert.match(code, /const page = await ctx\.session\.getPage\(\);/);
  // 絕不能保留 codegen 自己啟動瀏覽器那段——那會在流程中間另開一個瀏覽器，
  // 前面登入好的 session 完全用不到。
  assert.doesNotMatch(code, /chromium\.launch/);
  assert.doesNotMatch(code, /browser\.close/);
  assert.doesNotMatch(code, /context\.newPage/);
  assert.match(code, /page\.goto\('https:\/\/mail\.example\.invalid\/'\)/);
  assert.equal(actionCount, 6);
  assert.match(code, /return \{ \.\.\.ctx\.input/);
});

test("密碼絕不落地：已保存的帳密值換成 ctx.secrets，其餘密碼欄一律清空並回報", () => {
  const result = scrubRecordedSecrets(RAW, { webmailPassword: "super-secret-pw" });
  assert.doesNotMatch(result.code, /super-secret-pw/, "明碼密碼絕對不能留在程式碼裡");
  assert.match(result.code, /ctx\.secrets\.webmailPassword/);
  assert.deepEqual(result.replacedKeys, ["webmailPassword"]);
});

test("錄到的密碼不在已保存帳密裡時，清空而不是保留明文", () => {
  const result = scrubRecordedSecrets(RAW, {}); // 使用者還沒把密碼存進平台
  assert.doesNotMatch(result.code, /super-secret-pw/, "不認得的密碼也不能留在檔案裡");
  assert.match(result.code, /input\[name="PASSWD"\]', ""/);
  assert.ok(result.suspiciousFields.some((f) => f.includes("PASSWD")));
});

test("短值不當帳密比對：避免把剛好等於某個短密碼的正常文字改壞", () => {
  const code = `await page.fill('input[name="qty"]', '12');`;
  const result = scrubRecordedSecrets(code, { pin: "12" });
  assert.equal(result.code, code, "少於 4 個字的帳密值不參與比對");
  assert.deepEqual(result.replacedKeys, []);
});

test("長的帳密值先換，短的不會把長的切壞", () => {
  const code = `await page.fill('#a', 'abcd1234'); await page.fill('#b', 'abcd');`;
  const result = scrubRecordedSecrets(code, { short: "abcd", long: "abcd1234" });
  assert.match(result.code, /ctx\.secrets\.long/);
  assert.match(result.code, /ctx\.secrets\.short/);
  assert.doesNotMatch(result.code, /abcd/);
});

test("白話覆述：把每一步翻成人話，並把「他輸入的內容」單獨標出來(那些每次可能不一樣)", () => {
  const { code } = toNodeCode(RAW);
  const scrubbed = scrubRecordedSecrets(code, { webmailPassword: "super-secret-pw" }).code;
  const actions = describeRecording(scrubbed);
  assert.ok(actions.some((a) => a.kind === "goto" && a.describe.includes("mail.example.invalid")));
  assert.ok(actions.some((a) => a.kind === "fill" && a.value === "owen"), "使用者輸入的帳號要被列成「值」");
  // 帳密那一格要顯示成「已保存的帳密」，不能顯示值
  const secretFill = actions.find((a) => a.describe.includes("已保存的帳密"));
  assert.ok(secretFill);
  assert.equal(secretFill?.value, undefined);
  assert.ok(actions.some((a) => a.kind === "click"));
});

/**
 * 這幾行是**真實跑過一次錄製才發現**的：codegen 收尾時會多產出只對它自己那支獨立腳本
 * 有意義的程式碼。留下來的後果不是「多幾行沒用的」，而是整條流程壞掉。
 */
test("錄製收尾的雜項一定要濾掉：page.close() 會關掉共用分頁、context.* 在節點裡不存在", () => {
  const raw = `const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://example.invalid/');
  await page.getByRole('button', { name: '下載' }).click();
  await page.close();
  await context.storageState({ path: '/Users/someone/agent-hub/data/browser-sessions/wf-1.json' });
  await context.close();
})();`;
  const { code, actionCount } = toNodeCode(raw);
  assert.doesNotMatch(code, /page\.close\(\)/, "關掉共用分頁會讓後面每一步都壞");
  assert.doesNotMatch(code, /context\./, "節點作用域裡沒有 context，執行就 ReferenceError");
  assert.doesNotMatch(code, /\/Users\//, "不能把本機絕對路徑寫進步驟裡");
  assert.match(code, /getByRole\('button', \{ name: '下載' \}\)/, "真正的操作要留下來");
  assert.equal(actionCount, 2);
});

/**
 * 2026-08 code review 抓到的真實 bug：startRecording 原本無條件讀寫 `<workflowId>.json`，
 * 但 browser-login 節點的 shareLoginAcrossWorkflows 預設開啟後，這種節點真正的登入狀態是存在
 * 共用檔案(shared-<hash>.json)裡，不是這條流程自己的檔名——結果是錄製視窗完全讀不到已經
 * 手動登入過的狀態，逼使用者在錄製視窗裡重新登入一次。跟真的開瀏覽器測太慢是同一套理由，
 * 這裡守的是「storage 這個檔名到底是怎麼算出來的」，讀原始碼就能百分之百確認。
 */
test("共用登入狀態：有共用代號時，錄製要讀寫共用檔案，不能還在讀每條流程各自一份的舊檔名", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/workflow/actionRecorder.ts"), "utf8");
  assert.match(source, /import \{ sharedSessionFileName \} from "\.\/sharedLoginSession";/);
  assert.match(
    source,
    /const storage = path\.join\(SESSION_DIR, sharedSessionKey \? sharedSessionFileName\(sharedSessionKey\) : `\$\{workflowId\}\.json`\);/,
    "有共用代號時要用共用檔名算 storage 路徑",
  );
});
