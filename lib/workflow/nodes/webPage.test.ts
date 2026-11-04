import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 源碼釘住測試(跟 manualLogin.test.ts 同一套理由:守的是「失敗時走哪條路」,讀原始碼就能
 * 百分之百確認,不用真的對外抓網頁)。守住 2026-08 真實踩過的 bug:連線失敗(fetch failed)
 * 直接拋錯,永遠走不到瀏覽器備援——使用者公司官網擋非瀏覽器抓取,節點吹「會自動用瀏覽器補抓」
 * 卻在第一步就死掉。
 */
const source = fs.readFileSync(path.join(process.cwd(), "lib/workflow/nodes/webPage.ts"), "utf8");

test("連線失敗(fetch 拋錯)必須走降級鏈,不能直接 RetryableError 了事", () => {
  const catchBlock = /catch \(err\) \{\s*const output = await fetchViaFallbacks/.exec(source);
  assert.ok(catchBlock, "fetch 的 catch 裡要呼叫 fetchViaFallbacks");
});

test("HTTP 403/406(典型反爬回應)也要走降級鏈", () => {
  assert.match(source, /res\.status === 403 \|\| res\.status === 406/);
});

test("Firecrawl 是第三層而且是選配:一定先內建瀏覽器、有設定才輪到它", () => {
  const fn = /async function fetchViaFallbacks[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  const browserIdx = fn.indexOf("renderPageText");
  const fcIdx = fn.indexOf("firecrawlConfigured()");
  assert.ok(browserIdx > -1 && fcIdx > -1 && browserIdx < fcIdx, "順序必須是 瀏覽器→Firecrawl");
  assert.match(fn, /if \(firecrawlConfigured\(\)\)/, "沒設定 Firecrawl 絕不能呼叫它");
});

test("全部失敗的錯誤訊息要誠實列出試過哪些路,沒設 Firecrawl 的人要被告知有這個選項", () => {
  const fn = /async function fetchViaFallbacks[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  assert.match(fn, /已試過/);
  assert.match(fn, /設定 → 進階/);
});

test("Firecrawl 的錯誤要被接住:誠實的「試過哪些路」不能被它衝掉", () => {
  const fn = /async function fetchViaFallbacks[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  const call = /const page = await firecrawlScrape\([\s\S]{0,800}?catch \(err\)/.exec(fn);
  assert.ok(call, "firecrawlScrape 必須包在 try/catch 裡");
  assert.match(fn, /firecrawlErr/, "它的錯誤要記下來併進最後那句總結");
  assert.match(fn, /→Firecrawl\(\$\{firecrawlErr\}\)/, "最後的訊息要含 Firecrawl 這一層的原因");
});

test("金鑰錯/額度用完=PermanentError,不准重跑整條降級鏈(每跑一次都要錢)", () => {
  const fn = /async function fetchViaFallbacks[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  assert.match(fn, /firecrawlPermanent = err instanceof FirecrawlError && err\.permanent/);
  assert.match(fn, /throw firecrawlPermanent \? new PermanentError\(detail\) : new RetryableError\(detail\)/);
});

test("使用者按停止時不能被翻譯成「這個網頁抓不下來」", () => {
  const fn = /async function fetchViaFallbacks[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  assert.match(fn, /if \(ctx\.cancelSignal\.aborted\) throw err/);
});
