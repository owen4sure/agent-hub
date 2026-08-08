import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { allowedConfigKeys, continueOnFailEnabled, POLICY_FIELDS, POLICY_CONFIG_KEYS } from "./nodePolicy";
import { getNodeDef } from "./registry";

/** 每節點失敗策略(2026-08):retryTimes 覆蓋重試、continueOnFail 失敗也繼續。源碼釘住關鍵語意。 */
const src = fs.readFileSync(path.join(process.cwd(), "lib/workflow/engine.ts"), "utf8");

test("retryTimes:上限永遠是節點自己宣告的 maxAttempts,使用者只能往下調", () => {
  // ceiling 由 retryable + def.maxAttempts 算出，retryTimes 只能 Math.min 進去——
  // 少了這一層，browser-login(maxAttempts:1，內部已燒完自己的重試預算)會被跑三次真實登入。
  assert.match(src, /const ceiling = retryable \? Math\.max\(1, Math\.min\(MAX_ATTEMPTS, configuredMaxAttempts \?\? MAX_ATTEMPTS\)\) : 1;/);
  assert.match(src, /perNodeRetry[\s\S]{0,200}Math\.min\(ceiling, Math\.floor\(perNodeRetry\)\)/);
});

test("continueOnFail:節點照樣標 failed、總結點名——絕不假裝成功", () => {
  const block = /continueOnFailEnabled[\s\S]{0,900}?continue;/.exec(src)?.[0] ?? "";
  assert.match(block, /status='failed'/, "節點要標紅");
  assert.match(block, /skippedFailures\.push/, "總結要點名");
  assert.match(block, /error: errMsg, errorStep: node\.label/, "錯誤要進 {{error}}/{{errorStep}}");
});

test("continueOnFail 不能借用失敗分支(Plan B)的總結文案——沒有 Plan B 就不准說有", () => {
  // handledFailures 那句寫的是「已由你畫好的失敗分支(Plan B)接手處理」。continueOnFail
  // 根本沒有 Plan B，混用等於跟使用者謊報有備援跑過(平台明令禁止的「全綠但走樣」)。
  const planB = /handledFailures\.length > 0[\s\S]{0,300}?: ""\)/.exec(src)?.[0] ?? "";
  assert.match(planB, /失敗分支\(Plan B\)接手處理/);
  const skipped = /skippedFailures\.length > 0[\s\S]{0,400}?: ""\)/.exec(src)?.[0] ?? "";
  assert.ok(skipped, "成功總結必須有 skippedFailures 這一段");
  assert.doesNotMatch(skipped, /Plan B/, "「失敗也繼續」的總結不可以提 Plan B");
  assert.match(skipped, /沒有做完|缺這份資料/, "要老實講這一步沒做完、後面是缺資料跑完的");
});

test("continueOnFail 不能蓋過失敗分支:有接 Plan B 就走 Plan B(語意較明確者優先)", () => {
  assert.match(src, /!hasErrorBranch && continueOnFailEnabled\(/);
});

test("保留鍵永遠在允許清單裡——AI 改一次節點不能把使用者設好的失敗策略洗掉", () => {
  const def = getNodeDef("web-page")!;
  const keys = allowedConfigKeys(def);
  for (const k of POLICY_CONFIG_KEYS) assert.ok(keys.has(k), `${k} 要在允許清單裡`);
  assert.ok(keys.has("url"), "節點自己的欄位也要在");
});

test("保留鍵有表單欄位定義——沒有 UI 的設定等於不存在", () => {
  assert.deepEqual(POLICY_FIELDS.map((f) => f.key).sort(), [...POLICY_CONFIG_KEYS].sort());
  for (const f of POLICY_FIELDS) assert.ok(f.label && f.help, `${f.key} 要有白話標題與說明`);
});

test("continueOnFailEnabled:布林與字串 true 都算開啟,其餘一律關", () => {
  assert.equal(continueOnFailEnabled({ continueOnFail: true }), true);
  assert.equal(continueOnFailEnabled({ continueOnFail: "true" }), true);
  assert.equal(continueOnFailEnabled({ continueOnFail: "false" }), false);
  assert.equal(continueOnFailEnabled({}), false);
  assert.equal(continueOnFailEnabled(undefined), false);
});

test("寫入回讀核對沒過要浮到執行結果,不能只寫進逐步紀錄", () => {
  assert.match(src, /verifyMisses\.push\(\{ label: node\.label, evidence: v\.evidence \}\)/);
  const reason = /verifyMisses\.length > 0[\s\S]{0,400}?: ""\)/.exec(src)?.[0] ?? "";
  assert.ok(reason, "成功總結必須點名回讀沒過的步驟");
  assert.match(reason, /人工|確認/, "要告訴使用者下一步是自己打開確認");
});
