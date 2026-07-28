import test from "node:test";
import assert from "node:assert/strict";
import { autoTrimUnrequested, trimSummary } from "./autoTrim";
import type { WorkflowNode, WorkflowEdge } from "./types";

/**
 * 對應的真實紀錄：建圖被需求驗收擋下 57 次，前幾名是模型自己加了使用者沒要求的桌面通知(23)、
 * 把「每週我手動上傳」誤判成要建排程(7)。規則提示裡早就寫了、模型照樣照犯，而每被抓一次就
 * 多跑一輪模型(1～4 分鐘)，疊起來就是建圖失敗最大宗的逾時。這一層把「拿掉多做的」變成
 * 確定性操作，省掉那一輪。
 */
const node = (id: string, type: string, label = id): WorkflowNode =>
  ({ id, type, label, config: {}, position: { x: 0, y: 0 } });

test("自動修剪：使用者沒要求通知時，直接移除通知節點並把上下游接回去", () => {
  const nodes = [node("trigger", "trigger"), node("read", "excel-process"), node("notify", "desktop-notify", "完成通知"), node("save", "write-file")];
  const edges: WorkflowEdge[] = [
    { from: "trigger", to: "read" }, { from: "read", to: "notify" }, { from: "notify", to: "save" },
  ];
  const result = autoTrimUnrequested({ nodes, edges }, { dropUnrequestedOutbound: true, dropUnrequestedSchedule: false });
  assert.deepEqual(result.nodes.map((n) => n.id), ["trigger", "read", "save"]);
  assert.ok(result.edges.some((e) => e.from === "read" && e.to === "save"), "上下游要接回去，不能留下斷點");
  assert.ok(!result.edges.some((e) => e.from === "notify" || e.to === "notify"));
  assert.match(result.removed.join(""), /完成通知/, "拿掉了什麼一定要講出來");
});

test("自動修剪：接在錯誤分支上的桌面提醒是失敗備案，不能被當成多餘的完成通知刪掉", () => {
  const nodes = [node("trigger", "trigger"), node("work", "excel-process"), node("alert", "desktop-notify", "失敗時提醒我")];
  const edges: WorkflowEdge[] = [{ from: "trigger", to: "work" }, { from: "work", to: "alert", fromPort: "error" }];
  const result = autoTrimUnrequested({ nodes, edges }, { dropUnrequestedOutbound: true, dropUnrequestedSchedule: false });
  assert.deepEqual(result.nodes.map((n) => n.id), ["trigger", "work", "alert"]);
  assert.deepEqual(result.removed, []);
});

test("自動修剪：使用者沒要求自動執行時直接拿掉排程，並說明為什麼", () => {
  const result = autoTrimUnrequested(
    { nodes: [node("trigger", "trigger")], edges: [], schedule: { cron: "0 9 * * 1" } },
    { dropUnrequestedOutbound: false, dropUnrequestedSchedule: true },
  );
  assert.equal(result.schedule, undefined);
  assert.match(result.removed.join(""), /使用頻率/);
});

test("自動修剪：政策沒開就什麼都不動——判斷依據只來自需求驗收，不在這裡重新解讀使用者原話", () => {
  const nodes = [node("trigger", "trigger"), node("notify", "telegram-notify")];
  const edges: WorkflowEdge[] = [{ from: "trigger", to: "notify" }];
  const result = autoTrimUnrequested({ nodes, edges, schedule: { cron: "0 9 * * 1" } }, { dropUnrequestedOutbound: false, dropUnrequestedSchedule: false });
  assert.deepEqual(result.nodes.map((n) => n.id), ["trigger", "notify"]);
  assert.deepEqual(result.schedule, { cron: "0 9 * * 1" });
  assert.deepEqual(result.removed, []);
});

test("自動修剪：寄信節點跟通知節點一樣算「外送」，同一條政策要一起處理", () => {
  const nodes = [node("trigger", "trigger"), node("mail", "send-email", "寄結果給我")];
  const edges: WorkflowEdge[] = [{ from: "trigger", to: "mail" }];
  const result = autoTrimUnrequested({ nodes, edges }, { dropUnrequestedOutbound: true, dropUnrequestedSchedule: false });
  assert.deepEqual(result.nodes.map((n) => n.id), ["trigger"]);
});

test("修剪說明：沒有東西被拿掉就不要多印一段廢話", () => {
  assert.equal(trimSummary([]), "");
  assert.match(trimSummary(["移除了自動排程"]), /你沒有要求/);
});
