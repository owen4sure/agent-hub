import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { startWorkflowRun } from "./workflow/engine";
import { getWorkflow } from "./workflow/store";
import { resolveParams } from "./relativeDate";
import { sweepExpiredApprovals } from "./approvals";

export interface ScheduleRow {
  id: string;
  workflow_id: string;
  enabled: number;
  cron: string;
  params_json: string | null;
  last_fired_minute: string | null;
  next_run_at: string | null;
  created_at: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function taipeiParts(date: Date) {
  const t = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    weekday: t.getUTCDay(), // 0=Sun..6=Sat
  };
}

/**
 * @param min 這個欄位的最小合法值(分/時/星期=0，日/月=1)。星號加斜線 N 這種步進寫法要從欄位的最小值算起，
 *            不是永遠從 0 算——不然月份的步進 3 會變 3,6,9,12 月而不是標準 cron 的 1,4,7,10 月。
 */
function matchesField(spec: string, value: number, min = 0): boolean {
  if (spec === "*") return true;
  return spec.split(",").some((part) => {
    let step: number | null = null;
    let range = part;
    if (part.includes("/")) {
      const [r, s] = part.split("/");
      range = r;
      step = Number(s);
      // Number("abc") 是 NaN，而 NaN 跟任何數字比較都是 false——不擋掉的話
      // 「value < NaN || value > NaN」永遠不成立，亂打的欄位會被當成「永遠符合」、每分鐘觸發一次
      if (Number.isNaN(step)) return false;
    }
    let lo = value;
    let hi = value;
    if (range !== "*") {
      if (range.includes("-")) {
        const [a, b] = range.split("-").map(Number);
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
        lo = a;
        hi = b;
      } else {
        const n = Number(range);
        if (Number.isNaN(n)) return false;
        lo = hi = n;
      }
    } else {
      if (step == null) return true;
      return (value - min) % step === 0;
    }
    if (value < lo || value > hi) return false;
    return step == null || (value - lo) % step === 0;
  });
}

/** 檢查單一 cron 欄位的格式是否合法：* 、數字、範圍(a-b)、步進(/N)、逗號清單的任意組合 */
function isValidCronField(spec: string, min: number, max: number): boolean {
  if (spec === "*") return true;
  const isNum = (s: string) => /^\d+$/.test(s);
  return spec.split(",").every((part) => {
    let range = part;
    if (part.includes("/")) {
      const segs = part.split("/");
      if (segs.length !== 2 || !isNum(segs[1]) || Number(segs[1]) === 0) return false;
      range = segs[0];
    }
    if (range === "*") return true;
    if (range.includes("-")) {
      const segs = range.split("-");
      if (segs.length !== 2 || !isNum(segs[0]) || !isNum(segs[1])) return false;
      const [lo, hi] = segs.map(Number);
      return lo >= min && hi <= max && lo <= hi;
    }
    return isNum(range) && Number(range) >= min && Number(range) <= max;
  });
}

/**
 * 建立/更新排程前先驗證 cron 表達式：必須 5 個欄位、每欄都能被上面的解析邏輯合法解析。
 * 不擋在入口的話，亂打的欄位存進 DB 後 tick 端很難給使用者看得到的錯誤回饋。
 */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const limits: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return parts.every((part, i) => isValidCronField(part, ...limits[i]));
}

export function cronMatches(
  cron: string,
  dt: { minute: number; hour: number; day: number; month: number; weekday: number },
): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, day, month, weekday] = parts;
  if (!matchesField(min, dt.minute, 0)) return false;
  if (!matchesField(hour, dt.hour, 0)) return false;
  if (!matchesField(month, dt.month, 1)) return false;

  // 標準 cron 語意：日期(day-of-month)和星期(day-of-week)兩個都有限制時是「或」(符合其一就觸發)，
  // 只有其中一個是 "*" 時才由另一個單獨決定——不能永遠用「且」，不然 "0 9 1 * 1"(每月1號或每週一)
  // 會被誤解成「只有1號又剛好是週一才觸發」，一年只會對到一兩次。
  const dayWild = day === "*";
  const wkWild = weekday === "*";
  const dayMatch = matchesField(day, dt.day, 1);
  const wkMatch = matchesField(weekday, dt.weekday, 0) || matchesField(weekday, dt.weekday === 0 ? 7 : dt.weekday, 0);
  if (dayWild && wkWild) return true;
  if (dayWild) return wkMatch;
  if (wkWild) return dayMatch;
  return dayMatch || wkMatch;
}

/** 從現在往後搜尋(最多400天，涵蓋季報/雙月/年報這種週期>45天的 cron)，找出下一次會符合這個 cron 的時間，供 UI 顯示 */
export function computeNextRun(cron: string, from: Date): string | null {
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  for (let i = 1; i <= 60 * 24 * 400; i++) {
    const candidate = new Date(start.getTime() + i * 60_000);
    const dt = taipeiParts(candidate);
    if (cronMatches(cron, dt)) {
      return `${dt.year}-${pad(dt.month)}-${pad(dt.day)} ${pad(dt.hour)}:${pad(dt.minute)}`;
    }
  }
  return null;
}

export function listSchedules(workflowId?: string): ScheduleRow[] {
  const db = getDb();
  if (workflowId) {
    return db.prepare(`SELECT * FROM schedules WHERE workflow_id = ? ORDER BY created_at DESC`).all(workflowId) as ScheduleRow[];
  }
  return db.prepare(`SELECT * FROM schedules ORDER BY created_at DESC`).all() as ScheduleRow[];
}

export function createSchedule(workflowId: string, cron: string, params: Record<string, unknown>): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO schedules (id, workflow_id, enabled, cron, params_json, next_run_at, created_at) VALUES (?, ?, 1, ?, ?, ?, datetime('now'))`,
  ).run(id, workflowId, cron, JSON.stringify(params), computeNextRun(cron, new Date()));
  return id;
}

export function updateSchedule(id: string, patch: { enabled?: boolean; cron?: string; params?: Record<string, unknown> }): boolean {
  const db = getDb();
  if (!db.prepare(`SELECT 1 FROM schedules WHERE id = ?`).get(id)) return false;
  if (patch.enabled !== undefined) {
    db.prepare(`UPDATE schedules SET enabled = ? WHERE id = ?`).run(patch.enabled ? 1 : 0, id);
  }
  if (patch.cron !== undefined) {
    db.prepare(`UPDATE schedules SET cron = ? WHERE id = ?`).run(patch.cron, id);
  }
  if (patch.params !== undefined) {
    db.prepare(`UPDATE schedules SET params_json = ? WHERE id = ?`).run(JSON.stringify(patch.params), id);
  }
  // 重新啟用、或改了 cron 時，一定要把 next_run_at 往前重算——
  // 停用期間 tick 不會更新它(tick 只看 enabled=1)，重啟用時它可能是一週前的舊值，
  // tick 的「補跑(next_run_at 已過就補)」邏輯會誤判成錯過了、立刻跑一次。重算掉這個假的過期時間就不會誤觸發。
  if (patch.enabled === true || patch.cron !== undefined) {
    const row = db.prepare(`SELECT cron FROM schedules WHERE id = ?`).get(id) as { cron: string } | undefined;
    if (row) db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ?`).run(computeNextRun(row.cron, new Date()), id);
  }
  return true;
}

export function deleteSchedule(id: string): boolean {
  const db = getDb();
  return db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id).changes > 0;
}

let tickTimer: ReturnType<typeof setInterval> | null = null;

function tick() {
  const db = getDb();
  const now = new Date();
  // 簽核逾時掃描搭排程的每分鐘心跳一起做：過期的等簽核 run 要老實收尾+通知，不能無聲掛著
  try {
    sweepExpiredApprovals();
  } catch (err) {
    console.error("[scheduler] 簽核逾時掃描失敗:", err);
  }
  const dt = taipeiParts(now);
  const minuteKey = `${dt.year}-${pad(dt.month)}-${pad(dt.day)}T${pad(dt.hour)}:${pad(dt.minute)}`;
  const nowStr = `${dt.year}-${pad(dt.month)}-${pad(dt.day)} ${pad(dt.hour)}:${pad(dt.minute)}`;

  const schedules = db.prepare(`SELECT * FROM schedules WHERE enabled = 1`).all() as ScheduleRow[];
  for (const sched of schedules) {
    try {
      const wf = getWorkflow(sched.workflow_id);
      if (!wf) {
        // 流程已被刪除但排程還留著：不清掉的話這筆排程每分鐘都會在這裡卡住，且下面 startWorkflowRun 會直接 throw
        db.prepare(`DELETE FROM schedules WHERE id = ?`).run(sched.id);
        continue;
      }
      // 草稿可以先保存排程設定，但絕不能在背景自行執行。設為正式後同一筆 enabled 排程
      // 會自然開始生效，跟資料夾／收信監聽的產品語意一致。
      if (wf.status !== "official") {
        db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ?`).run(computeNextRun(sched.cron, now), sched.id);
        continue;
      }

      const alreadyFiredThisMinute = sched.last_fired_minute === minuteKey;
      // 補跑：上次算好的 next_run_at 已經過了、但這個 minuteKey 還沒因為命中 cron 而觸發過，
      // 代表中間電腦睡眠/關機錯過了那個時間點——一次性補跑，而不是靜默永遠漏掉(對季報這種低頻排程是致命的)。
      const missed = !alreadyFiredThisMinute && sched.next_run_at != null && sched.next_run_at <= nowStr;
      const exactMatch = !alreadyFiredThisMinute && cronMatches(sched.cron, dt);

      if (exactMatch || missed) {
        // 用「條件式 UPDATE」當原子性的搶佔鎖：同一分鐘只有第一個成功改到 last_fired_minute 的呼叫會觸發，
        // 就算 daemon 和另一個手動啟動的 dev server 同時對著同一顆 SQLite tick，也不會兩邊都觸發同一次。
        const claimed = db
          .prepare(`UPDATE schedules SET last_fired_minute = ? WHERE id = ? AND (last_fired_minute IS NULL OR last_fired_minute != ?)`)
          .run(minuteKey, sched.id, minuteKey);
        if (claimed.changes === 1) {
          const rawParams = sched.params_json ? JSON.parse(sched.params_json) : {};
          // 排程觸發要跟手動執行(app/api/workflows/[id]/run)走一樣的參數處理：
          // 經過 resolveParams 套用預設值、解析 {{last-quarter-start}} 這類日期 token、算出 __period。
          // 不然靠預設值/日期 token 的流程排程跑起來會抓錯期間(拿到原始 token 字串而不是實際日期)。
          const params = resolveParams(wf.triggerParams ?? [], rawParams, now);
          startWorkflowRun(sched.workflow_id, params, { trigger: "schedule", headed: false });
        }
      }

      const nextRunAt = computeNextRun(sched.cron, now);
      db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ?`).run(nextRunAt, sched.id);
    } catch (err) {
      // workflow id 本身不合法時 getWorkflow 會直接 throw(assertValidId)，走不到上面「流程已刪→清掉排程」的分支，
      // 不在這裡清掉的話這筆排程會每分鐘 error 一次、永遠刪不掉
      if (err instanceof Error && err.message.includes("不合法的 workflow id")) {
        db.prepare(`DELETE FROM schedules WHERE id = ?`).run(sched.id);
        console.error(`[scheduler] 排程 ${sched.id} 指向不合法的 workflow id，已自動刪除`);
        continue;
      }
      // 單一排程處理出錯不能讓迴圈中斷——不然一個壞排程會讓「後面所有排程」這個 tick 都不會被檢查
      console.error(`[scheduler] 排程 ${sched.id} 處理失敗:`, err);
    }
  }
}

/** server 啟動時呼叫一次；重複呼叫是安全的(不會啟動第二個 timer) */
export function startScheduler() {
  if (tickTimer) return;
  tick();
  tickTimer = setInterval(tick, 60_000);
}
