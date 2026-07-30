import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidCron, mergeScheduleOrder } from "./scheduler";
import * as schedulerModule from "./scheduler";
import { getDb } from "./db";
import type { ScheduleRow } from "./scheduler";

const db = () => getDb();
const enabledOf = (id: string) =>
  (getDb().prepare(`SELECT enabled FROM schedules WHERE id = ?`).get(id) as { enabled: number } | undefined)?.enabled;

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

/**
 * 「全部暫停 → 恢復」最危險的地方不是暫停，是恢復：如果恢復是「把所有排程都打開」，
 * 就會把使用者幾週前刻意關掉的排程一起放回背景執行——而背景執行會真的寄信、寫試算表、
 * 動外部系統。所以恢復必須只動「這次被全部暫停關掉的那幾筆」。
 *
 * 這裡刻意**不**呼叫 pauseAllSchedules()：測試跑在真實的 data/ 上，那個函式會掃全表，
 * 等於把使用者真正在用的排程全部關掉；萬一測試中途掛掉就留在關閉狀態。
 * 所以改成直接驗證「選擇性恢復」這段真正有風險的邏輯，全域掃描那段用真實操作驗證。
 */
test("恢復只打開「這次被全部暫停關掉的」，不會動到使用者原本就暫停的排程", () => {
  const { createSchedule, deleteSchedule, updateSchedule, resumePausedBatch } = schedulerModule;
  const mine = createSchedule("wf-test-pause-batch", "0 9 * * *", {});
  const untouched = createSchedule("wf-test-pause-batch", "0 10 * * *", {});
  try {
    // 兩筆都關掉，但只有 mine 是「這次全部暫停」關的
    updateSchedule(mine, { enabled: false });
    updateSchedule(untouched, { enabled: false });
    db().prepare(`INSERT INTO settings (key, value) VALUES ('schedulePausedBatch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify([mine]));

    const result = resumePausedBatch();

    assert.deepEqual(result.resumed, [mine]);
    assert.equal(enabledOf(mine), 1, "被全部暫停關掉的那筆要恢復");
    assert.equal(enabledOf(untouched), 0, "使用者原本就關掉的那筆絕對不能被打開");
    // 恢復後清空批次，避免第二次按「恢復」又把同一批打開一次
    assert.deepEqual(schedulerModule.getPausedBatch(), []);
  } finally {
    deleteSchedule(mine);
    deleteSchedule(untouched);
    db().prepare(`DELETE FROM settings WHERE key = 'schedulePausedBatch'`).run();
  }
});

test("恢復時遇到已經被刪掉的排程要跳過並回報，不能整批失敗", () => {
  const { createSchedule, deleteSchedule, updateSchedule, resumePausedBatch } = schedulerModule;
  const alive = createSchedule("wf-test-pause-batch", "0 9 * * *", {});
  try {
    updateSchedule(alive, { enabled: false });
    db().prepare(`INSERT INTO settings (key, value) VALUES ('schedulePausedBatch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify([alive, "已經不存在的排程 id"]));
    const result = resumePausedBatch();
    assert.deepEqual(result.resumed, [alive]);
    assert.equal(result.missing, 1);
    assert.equal(enabledOf(alive), 1);
  } finally {
    deleteSchedule(alive);
    db().prepare(`DELETE FROM settings WHERE key = 'schedulePausedBatch'`).run();
  }
});
