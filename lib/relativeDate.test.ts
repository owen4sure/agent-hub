import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDateToken, computePeriod } from "./relativeDate";

// 固定「現在」= 2026-07-09(週四) Asia/Taipei，讓所有測試不受執行當下的實際日期影響
const NOW = new Date("2026-07-09T12:00:00Z");

test("resolveDateToken：基本相對日期", () => {
  assert.equal(resolveDateToken("today", NOW), "2026-07-09");
  assert.equal(resolveDateToken("yesterday", NOW), "2026-07-08");
  assert.equal(resolveDateToken("day-before-yesterday", NOW), "2026-07-07");
});

test("resolveDateToken：-N 位移在 today/yesterday 生效", () => {
  assert.equal(resolveDateToken("today-7", NOW), "2026-07-02");
  assert.equal(resolveDateToken("yesterday-3", NOW), "2026-07-05");
});

// 修復重點：以前 -N 只在 today/yesterday/day-before-yesterday 生效，月/季/年邊界的 -N 會被靜默忽略
test("resolveDateToken：-N 位移在月/季/年邊界也要生效", () => {
  assert.equal(resolveDateToken("this-month-start-5", NOW), "2026-06-26");
  assert.equal(resolveDateToken("last-month-end-3", NOW), "2026-06-27");
  assert.equal(resolveDateToken("last-quarter-end-3", NOW), "2026-06-27");
  assert.equal(resolveDateToken("last-year-start-1", NOW), "2024-12-31"); // 跨年位移
});

test("resolveDateToken：月/季/年邊界(無位移)", () => {
  assert.equal(resolveDateToken("this-month-start", NOW), "2026-07-01");
  assert.equal(resolveDateToken("this-month-end", NOW), "2026-07-31");
  assert.equal(resolveDateToken("this-quarter-start", NOW), "2026-07-01");
  assert.equal(resolveDateToken("this-year-end", NOW), "2026-12-31");
});

test("resolveDateToken：不認得的變數要丟錯(不能默默回傳字面字串)", () => {
  assert.throws(() => resolveDateToken("not-a-real-token", NOW));
});

test("computePeriod：quarter/last 算出正確的上一季區間", () => {
  const p = computePeriod("quarter", "last", NOW); // now=7月 → 這一季是Q3，上一季是Q2(4-6月)
  assert.equal(p.start, "2026-04-01");
  assert.equal(p.end, "2026-06-30");
  assert.equal(p.reportDate, "2026-07-01"); // end 隔天
  assert.equal(p.label, "第二季");
});

test("computePeriod：指定 'YYYY-N' 精準選期間", () => {
  const p = computePeriod("quarter", "2025-1", NOW);
  assert.equal(p.start, "2025-01-01");
  assert.equal(p.end, "2025-03-31");
});
