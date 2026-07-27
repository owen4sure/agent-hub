import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidCron, mergeScheduleOrder } from "./scheduler";
import type { ScheduleRow } from "./scheduler";

function row(id: string, opts: { enabled?: boolean; nextRunAt?: string | null } = {}): ScheduleRow {
  return {
    id,
    workflow_id: `wf-${id}`,
    enabled: opts.enabled === false ? 0 : 1,
    cron: "0 9 * * *",
    params_json: null,
    last_fired_minute: null,
    next_run_at: opts.nextRunAt ?? null,
    created_at: "2026-01-01 00:00:00",
  };
}

// 排程操控台以前直接用 DB 回傳的「建立時間新到舊」順序，使用者完全看不出哪個排程快到了。
test("mergeScheduleOrder：沒有手動排序時，依下次執行時間由近到遠排列", () => {
  const schedules = [
    row("c", { nextRunAt: "2026-08-01 09:00" }),
    row("a", { nextRunAt: "2026-07-20 09:00" }),
    row("b", { nextRunAt: "2026-07-25 09:00" }),
  ];
  assert.deepEqual(mergeScheduleOrder(schedules, []).map((s) => s.id), ["a", "b", "c"]);
});

test("mergeScheduleOrder：已暫停或算不出下次時間的排到最後，彼此之間維持原順序", () => {
  const schedules = [
    row("soon", { nextRunAt: "2026-07-20 09:00" }),
    row("paused", { enabled: false, nextRunAt: "2026-07-18 09:00" }), // 暫停了，時間再早也要排最後
    row("noNextRun", { nextRunAt: null }),
    row("later", { nextRunAt: "2026-08-01 09:00" }),
  ];
  assert.deepEqual(mergeScheduleOrder(schedules, []).map((s) => s.id), ["soon", "later", "paused", "noNextRun"]);
});

// 核心需求：使用者拖曳過的順序要優先於時間排序，但沒拖過的排程不能被硬塞到清單最後，
// 要維持在時間排序裡原本的相對位置——這樣新增的排程才會自然出現在合理的位置，不用使用者手動排。
test("mergeScheduleOrder：手動排序優先，沒被手動排過的排程維持在時間排序裡的相對位置", () => {
  const schedules = [
    row("a", { nextRunAt: "2026-07-20 09:00" }),
    row("b", { nextRunAt: "2026-07-21 09:00" }),
    row("c", { nextRunAt: "2026-07-22 09:00" }),
    row("d", { nextRunAt: "2026-07-23 09:00" }),
  ];
  // 使用者把時間上排最後的「d」拖到最前面；b、c 沒被拖過，順序不變
  assert.deepEqual(mergeScheduleOrder(schedules, ["d"]).map((s) => s.id), ["d", "a", "b", "c"]);
});

test("mergeScheduleOrder：手動排序清單裡的已刪除 id 不影響其餘排程排序", () => {
  const schedules = [
    row("a", { nextRunAt: "2026-07-20 09:00" }),
    row("b", { nextRunAt: "2026-07-21 09:00" }),
  ];
  assert.deepEqual(mergeScheduleOrder(schedules, ["deleted-one", "b", "deleted-two"]).map((s) => s.id), ["b", "a"]);
});

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
