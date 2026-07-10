import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCron, parseCron, timeValid } from "./cron";
import { humanizeCron } from "../components/ui";

test("buildCron：各種模式組出正確的 cron 字串", () => {
  assert.equal(buildCron({ mode: "daily", time: "09:00", day: "1", weekday: "1" }), "0 9 * * *");
  assert.equal(buildCron({ mode: "monthly", time: "09:30", day: "15", weekday: "1" }), "30 9 15 * *");
  assert.equal(buildCron({ mode: "quarter", time: "08:00", day: "1", weekday: "1" }), "0 8 1 1,4,7,10 *");
  assert.equal(buildCron({ mode: "bimonth", time: "08:00", day: "1", weekday: "1" }), "0 8 1 1,3,5,7,9,11 *");
  assert.equal(buildCron({ mode: "weekly", time: "07:00", day: "1", weekday: "3" }), "0 7 * * 3");
});

test("parseCron：buildCron 的輸出要能還原回同一份表單(round-trip)", () => {
  for (const form of [
    { mode: "daily", time: "09:00", day: "1", weekday: "1" },
    { mode: "monthly", time: "09:30", day: "15", weekday: "1" },
    { mode: "quarter", time: "08:00", day: "1", weekday: "1" },
    { mode: "bimonth", time: "08:00", day: "1", weekday: "1" },
    { mode: "weekly", time: "07:00", day: "1", weekday: "3" },
  ]) {
    const cron = buildCron(form);
    const parsed = parseCron(cron);
    assert.deepEqual(parsed, form);
  }
});

test("parseCron：進階 cron(無法對應簡單表單)回 null，不硬猜", () => {
  assert.equal(parseCron("*/15 * * * *"), null);
  assert.equal(parseCron("0 9 1-5 * *"), null);
});

test("timeValid：格式檢查", () => {
  assert.equal(timeValid("09:00"), true);
  assert.equal(timeValid("9:00"), true);
  assert.equal(timeValid(""), false);
  assert.equal(timeValid("25:99"), true); // 只驗格式不驗範圍(維持既有行為，不引入新規則)
});

test("humanizeCron：翻成白話中文", () => {
  assert.equal(humanizeCron("0 9 * * *"), "每天 早上 9:00");
  assert.equal(humanizeCron("30 9 1 1,4,7,10 *"), "每季（1、4、7、10 月）1 號 早上 9:30");
  assert.equal(humanizeCron("0 14 1 * *"), "每月 1 號 下午 2:00");
});

test("humanizeCron：翻不了的進階 cron 原樣顯示，不裝懂", () => {
  assert.equal(humanizeCron("*/15 * * * *"), "*/15 * * * *");
});
