import { test } from "node:test";
import assert from "node:assert/strict";
import { stableJson, safeParseJson } from "./engine";

test("stableJson：鍵值順序不同但內容相同要判相等", () => {
  const a = { filterStart: "2026-01-01", filterEnd: "2026-03-31", periodLabel: "第一季" };
  const b = { periodLabel: "第一季", filterEnd: "2026-03-31", filterStart: "2026-01-01" };
  assert.equal(stableJson(a), stableJson(b));
});

test("stableJson：內容真的不同(換了期間)要判不相等——這是部分執行防止拿舊參數當種子的核心判準", () => {
  const q1 = { filterStart: "2026-01-01", filterEnd: "2026-03-31" };
  const q2 = { filterStart: "2026-04-01", filterEnd: "2026-06-30" };
  assert.notEqual(stableJson(q1), stableJson(q2));
});

test("stableJson：巢狀物件/陣列也要排序後比較", () => {
  const a = { outer: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] };
  const b = { list: [{ x: 1, y: 2 }], outer: { a: 1, b: 2 } };
  assert.equal(stableJson(a), stableJson(b));
});

test("safeParseJson：壞 JSON／null 安全回空物件，不拋錯", () => {
  assert.deepEqual(safeParseJson(null), {});
  assert.deepEqual(safeParseJson("{不是合法json"), {});
  assert.deepEqual(safeParseJson("[1,2,3]"), {}); // 陣列不是「參數物件」，當空物件處理
});

test("safeParseJson：正常物件原樣解析", () => {
  assert.deepEqual(safeParseJson('{"a":1,"b":"x"}'), { a: 1, b: "x" });
});
