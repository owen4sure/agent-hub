import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** 每節點失敗策略(2026-08):retryTimes 覆蓋重試、continueOnFail 失敗也繼續。源碼釘住關鍵語意。 */
const src = fs.readFileSync(path.join(process.cwd(), "lib/workflow/engine.ts"), "utf8");

test("retryTimes:夾在 MAX_ATTEMPTS 之內——使用者不能把重試調到爆(盲目重跑不會讓事情變好)", () => {
  assert.match(src, /perNodeRetry[\s\S]{0,200}Math\.min\(MAX_ATTEMPTS/);
});

test("continueOnFail:節點照樣標 failed、總結點名(handledFailures)——絕不假裝成功", () => {
  const block = /continueOnFail[\s\S]{0,900}?continue;/.exec(src)?.[0] ?? "";
  assert.match(block, /status='failed'/, "節點要標紅");
  assert.match(block, /handledFailures\.push/, "總結要點名");
  assert.match(block, /error: errMsg, errorStep: node\.label/, "錯誤要進 {{error}}/{{errorStep}}");
});

test("continueOnFail 不能蓋過失敗分支:有接 Plan B 就走 Plan B(語意較明確者優先)", () => {
  assert.match(src, /!hasErrorBranch && \(cfgContinue === true \|\| cfgContinue === "true"\)/);
});
