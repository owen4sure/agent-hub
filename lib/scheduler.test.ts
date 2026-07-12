import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidCron } from "./scheduler";

test("isValidCron：接受常用排程與合法範圍", () => {
  assert.equal(isValidCron("0 9 * * *"), true);
  assert.equal(isValidCron("0 9 1 1,4,7,10 *"), true);
  assert.equal(isValidCron("*/15 8-18 * * 1-5"), true);
});

test("isValidCron：拒絕永遠不會觸發的越界值與反向範圍", () => {
  assert.equal(isValidCron("99 9 * * *"), false);
  assert.equal(isValidCron("0 25 * * *"), false);
  assert.equal(isValidCron("0 9 32 * *"), false);
  assert.equal(isValidCron("0 9 * 13 *"), false);
  assert.equal(isValidCron("0 9 * * 8"), false);
  assert.equal(isValidCron("0 9 * * 5-1"), false);
});
