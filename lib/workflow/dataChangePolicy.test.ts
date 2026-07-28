import { test } from "node:test";
import assert from "node:assert/strict";
import { contractEffectsFor, dataChangePolicyFor, statesReadOnlyIntent } from "./dataChangePolicy";

/**
 * 「這次需求禁止哪些資料變更」的判斷有三個消費端(需求驗收、建立只讀契約、執行前重驗)，
 * 各寫一份必然漂移——這一系列 P0 的共同成因。這支測試盯住那份共用判斷本身的語意界線。
 */

test("資料變更政策：只讀類語句禁止本機與遠端的所有變更", () => {
  for (const text of ["只讀取資料，不要修改", "只分析不要寫入", "只計算就好", "不要改動任何既有資料"]) {
    const policy = dataChangePolicyFor(text);
    assert.equal(policy.forbidsAllChanges, true, text);
    assert.deepEqual([...policy.bannedEffects].sort(), ["file-modify", "file-write", "remote-write"], text);
    assert.equal(statesReadOnlyIntent(text), true, text);
  }
});

test("資料變更政策：「不要產出檔案」只禁本機新檔，不得升級成全面只讀或外送禁令", () => {
  const text = "整理一下就好，不要產出檔案";
  const policy = dataChangePolicyFor(text);
  assert.deepEqual([...policy.bannedEffects], ["file-write"]);
  assert.equal(policy.forbidsAllChanges, false);
  assert.equal(statesReadOnlyIntent(text), false);
  assert.deepEqual([...contractEffectsFor(text)], ["file-write"], "持久化的也只有本機新檔，不能順便擋掉寄信/遠端");
});

test("契約範圍：只讀類語句要持久化成「資料變更 + 對外發送」五類", () => {
  // 真實踩過的不一致：契約只存三類、執行前閘門的 delegated 那側自己加 email/notify，
  // 導致同一個 send-email 藏在子流程會被擋、畫在本圖反而放行。
  assert.deepEqual([...contractEffectsFor("只讀取資料，不要修改")].sort(),
    ["email", "file-modify", "file-write", "notify", "remote-write"]);
});

test("契約範圍：單項否定句各自持久化，不互相波及", () => {
  assert.deepEqual([...contractEffectsFor("整理完給我看就好，不要寄信")], ["email"]);
  assert.deepEqual([...contractEffectsFor("跑完不要通知我")], ["notify"]);
  // 使用者明確要求的外送不會被記成禁止
  assert.deepEqual([...contractEffectsFor("整理完寄信給我")], []);
  assert.deepEqual([...contractEffectsFor("跑完用 telegram 通知我")], []);
});

test("契約範圍：沒有任何明確否定句就不建立契約(不可憑猜測把使用者鎖住)", () => {
  assert.deepEqual([...contractEffectsFor("幫我讀這份表，整理成摘要")], []);
  assert.deepEqual([...contractEffectsFor("每天早上抓報表存成 Excel 寄給我")], []);
});

test("資料變更政策：明確要求的輸出從禁止清單移除，而不是讓整條規則失效", () => {
  const both = dataChangePolicyFor("不要修改原始資料，把結果存成新檔");
  assert.equal(both.bannedEffects.has("file-write"), false, "使用者明確要的新檔不該被擋");
  assert.equal(both.bannedEffects.has("remote-write"), true, "沒被明確要求的遠端寫入仍然禁止");

  const sheet = dataChangePolicyFor("整理資料，不要產出檔案，把結果更新到 Google 試算表");
  assert.equal(sheet.bannedEffects.has("remote-write"), false);
  assert.equal(sheet.bannedEffects.has("file-write"), true);
});

test("資料變更政策：一般需求不會憑空產生限制", () => {
  const policy = dataChangePolicyFor("每天早上讀報表，整理成摘要用 telegram 通知我");
  assert.equal(policy.bannedEffects.size, 0);
  assert.equal(statesReadOnlyIntent("每天早上讀報表，整理成摘要用 telegram 通知我"), false);
});
