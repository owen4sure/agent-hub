import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestCronFromText, parseTimeOfDay } from "./scheduleSuggest";

/* ── 基本頻率 ─────────────────────────────────────────────── */

test("每週+沒講時間 → 週一 09:00,兩個假設都明講", () => {
  const r = suggestCronFromText("我每週要更新一份簡報的數字，想做成自動流程");
  assert.ok(r);
  assert.equal(r!.cron, "0 9 * * 1");
  assert.equal(r!.assumed.length, 2);
});

test("每週四早上8點半 → cron 正確,無假設", () => {
  const r = suggestCronFromText("每週四早上8點半自動更新");
  assert.ok(r);
  assert.equal(r!.cron, "30 8 * * 4");
  assert.deepEqual(r!.assumed, []);
});

test("每天 21:30 → 數字時間寫法", () => {
  assert.equal(suggestCronFromText("每天 21:30 抓一次")!.cron, "30 21 * * *");
});

test("每天下午3點 → 15:00", () => {
  assert.equal(suggestCronFromText("每天下午3點自動寄給我")!.cron, "0 15 * * *");
});

test("每月5號早上9點 → 月排程", () => {
  assert.equal(suggestCronFromText("每月5號早上9點跑")!.cron, "0 9 5 * *");
});

test("每月沒講日期 → 1 號並標假設", () => {
  const r = suggestCronFromText("每月自動彙整一次");
  assert.equal(r!.cron, "0 9 1 * *");
  assert.ok(r!.assumed.some((a) => a.includes("1 號")));
});

test("每月31號 → 不是每月都有,退到 1 號並明講", () => {
  const r = suggestCronFromText("每月31號晚上8點結算");
  assert.equal(r!.cron, "0 20 1 * *");
  assert.ok(r!.assumed.some((a) => a.includes("31")));
});

test("每週日 → 星期0", () => {
  assert.equal(suggestCronFromText("每週日晚上11點備份")!.cron, "0 23 * * 0");
});

test("每個星期三 → 「每個」寫法也要認得", () => {
  assert.equal(suggestCronFromText("每個星期三早上10點寄報表")!.cron, "0 10 * * 3");
});

test("只說自動、沒講頻率 → null(頻率不能猜)", () => {
  assert.equal(suggestCronFromText("幫我自動更新簡報"), null);
});

test("明講不要排程 → null", () => {
  assert.equal(suggestCronFromText("每週的報表,但不要排程,我自己手動跑"), null);
});

/* ── 星期區間：週一到週五不能被讀成「只有週一」 ─────────────── */

test("每週一到週五 → 1-5,不是只有週一", () => {
  const r = suggestCronFromText("每週一到週五早上9點自動跑");
  assert.equal(r!.cron, "0 9 * * 1-5");
  assert.deepEqual(r!.assumed, []);
});

test("工作日 → 週一到週五", () => {
  assert.equal(suggestCronFromText("工作日早上10點提醒我")!.cron, "0 10 * * 1-5");
});

test("平日/上班日也是同一件事", () => {
  assert.equal(suggestCronFromText("平日下午6點自動備份")!.cron, "0 18 * * 1-5");
  assert.equal(suggestCronFromText("上班日早上8點通知")!.cron, "0 8 * * 1-5");
});

test("任意星期區間(週二到週四)也支援", () => {
  assert.equal(suggestCronFromText("每週二到週四早上7點跑")!.cron, "0 7 * * 2-4");
});

test("跨週末的區間(週五到週一)cron 表達不了 → 不硬湊", () => {
  assert.equal(suggestCronFromText("每週五到週一晚上9點跑"), null);
});

/* ── 中文數字時間 ─────────────────────────────────────────── */

test("每天晚上八點 → 20:00(中文數字)", () => {
  const r = suggestCronFromText("每天晚上八點自動寄報表");
  assert.equal(r!.cron, "0 20 * * *");
  assert.deepEqual(r!.assumed, [], "使用者明明講了時間,不能反過來說他沒講");
});

test("九點半 → 9:30", () => {
  assert.equal(suggestCronFromText("每天早上九點半跑")!.cron, "30 9 * * *");
});

test("十點/十一點/二十三點都要認得", () => {
  assert.equal(suggestCronFromText("每天十點跑")!.cron, "0 10 * * *");
  assert.equal(suggestCronFromText("每天晚上十一點跑")!.cron, "0 23 * * *");
  assert.equal(suggestCronFromText("每天二十三點跑")!.cron, "0 23 * * *");
});

test("十五分/三十分這種中文分鐘", () => {
  assert.equal(suggestCronFromText("每天早上八點十五分跑")!.cron, "15 8 * * *");
});

/* ── 半夜 12 點 ───────────────────────────────────────────── */

test("晚上12點=半夜0點,不是中午12點", () => {
  assert.equal(suggestCronFromText("每天晚上12點清理資料")!.cron, "0 0 * * *");
});

test("凌晨12點也是 0 點", () => {
  assert.equal(suggestCronFromText("每天凌晨12點清理")!.cron, "0 0 * * *");
});

test("中午12點才是 12 點", () => {
  assert.equal(suggestCronFromText("每天中午12點寄出")!.cron, "0 12 * * *");
});

/* ── 頻率詞衝突：資料期間 vs 排程頻率 ───────────────────────── */

test("「整理每週營收，每天9點更新」→ 排程是每天,不是每週", () => {
  assert.equal(suggestCronFromText("幫我整理每週營收數據，每天早上9點自動更新")!.cron, "0 9 * * *");
});

test("「彙整每個月的帳單，每週一寄給我」→ 排程是每週一", () => {
  assert.equal(suggestCronFromText("彙整每個月的帳單，每週一寄給我")!.cron, "0 9 * * 1");
});

test("兩個頻率詞都像在講排程 → 分不出來就回 null,不要賭", () => {
  assert.equal(suggestCronFromText("每天早上9點跑，每週寄一次總表"), null);
});

/* ── 「N點」不一定是時刻 ─────────────────────────────────── */

test("每月10點 → 10 是時刻不是日期,日期要標成假設", () => {
  const r = suggestCronFromText("每月10點跑一次結算");
  assert.equal(r!.cron, "0 10 1 * *", "不能把小時當成每月10號");
  assert.ok(r!.assumed.some((a) => a.includes("1 號")));
});

test("「第3點」是序數不是凌晨3點", () => {
  const r = suggestCronFromText("每天早上9點跑，第3點要注意");
  assert.equal(r!.cron, "0 9 * * *");
});

test("「3點重點」不是凌晨3點", () => {
  assert.equal(parseTimeOfDay("這份報告有3點重點"), null);
  assert.equal(suggestCronFromText("每天9點寄出，內容有3點重點")!.cron, "0 9 * * *");
});

test("「每3小時」不會被當成 3 點", () => {
  assert.equal(parseTimeOfDay("每3小時跑一次"), null);
});

test("「9點30」沒有「分」就不算分鐘,避免把步驟數當分鐘", () => {
  assert.deepEqual(parseTimeOfDay("每天9點3個步驟"), { hour: 9, minute: 0 });
});

/* ── 產出的 cron 一定要是平台排程器認得的 ─────────────────── */

test("所有產出的 cron 都能通過 isValidCron", async () => {
  const { isValidCron } = await import("../scheduler");
  const samples = [
    "每天早上9點自動跑",
    "每週三下午2點跑",
    "每週一到週五早上9點自動跑",
    "工作日早上10點提醒我",
    "每月5號早上9點跑",
    "每天晚上12點清理資料",
  ];
  for (const s of samples) {
    const r = suggestCronFromText(s);
    assert.ok(r, `「${s}」應該要推得出 cron`);
    assert.ok(isValidCron(r!.cron), `「${s}」產出的 ${r!.cron} 排程器不認得`);
  }
});
