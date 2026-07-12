import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSuggestedSchedule } from "./builder";

test("builder schedule：接受常用中文需求會產生的排程", () => {
  assert.deepEqual(validateSuggestedSchedule({ cron: "0 9 1 * *", params: {} }), []);
  assert.deepEqual(validateSuggestedSchedule({ cron: "0 9 * * 1" }), []);
  assert.deepEqual(validateSuggestedSchedule(undefined), []);
});

test("builder schedule：在進入預覽前攔截錯誤 cron", () => {
  assert.ok(validateSuggestedSchedule({ cron: "每天九點" }).length > 0);
  assert.ok(validateSuggestedSchedule({ cron: "99 25 32 13 8" }).length >= 5);
  assert.ok(validateSuggestedSchedule({ cron: "0 9 * * MON" }).length > 0);
});
