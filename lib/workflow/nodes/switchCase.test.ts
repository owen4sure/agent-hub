import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSwitchCases, pickSwitchCase, SWITCH_FALLBACK_PORT } from "./switchCase";

test("parseSwitchCases：換行/逗號(半形全形)都能切，去空白去空行", () => {
  assert.deepEqual(parseSwitchCases("請假\n報支\n其他問題"), ["請假", "報支", "其他問題"]);
  assert.deepEqual(parseSwitchCases("請假, 報支，其他問題"), ["請假", "報支", "其他問題"]);
  assert.deepEqual(parseSwitchCases("  請假  \n\n  "), ["請假"]);
  assert.deepEqual(parseSwitchCases(""), []);
});

test("pickSwitchCase：完全相等優先(不分大小寫、去頭尾空白)", () => {
  assert.equal(pickSwitchCase("請假", ["請假", "報支"]), "請假");
  assert.equal(pickSwitchCase("  報支  ", ["請假", "報支"]), "報支");
  assert.equal(pickSwitchCase("YES", ["yes", "no"]), "yes");
});

test("pickSwitchCase：唯一包含也能救回(上游 AI 回「分類:請假」這種)", () => {
  assert.equal(pickSwitchCase("分類:請假", ["請假", "報支"]), "請假");
});

test("pickSwitchCase：否定反轉不能命中(「非請假」不能算成請假)", () => {
  assert.equal(pickSwitchCase("非請假", ["請假", "報支"]), SWITCH_FALLBACK_PORT);
  assert.equal(pickSwitchCase("不是報支", ["請假", "報支"]), SWITCH_FALLBACK_PORT);
});

test("pickSwitchCase：多重命中/沒命中都走「其他」", () => {
  assert.equal(pickSwitchCase("請假還是報支", ["請假", "報支"]), SWITCH_FALLBACK_PORT);
  assert.equal(pickSwitchCase("加班", ["請假", "報支"]), SWITCH_FALLBACK_PORT);
  assert.equal(pickSwitchCase("", ["請假", "報支"]), SWITCH_FALLBACK_PORT);
});
