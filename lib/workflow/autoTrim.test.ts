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

// ── 手動選檔：三個條件裡漏掉的那一個 ──
// 驗收要「有選檔欄位 + 讀檔節點真的引用它 + 沒有資料夾監聽」三者同時成立。前兩個早就會自動補，
// 第三個(watchPath)從來沒被處理，所以每次都還是要多花一輪模型去請它拿掉——實測 17 次都卡在這裡。
test("手動選檔：使用者說執行時自己選檔時，模型設的資料夾監聽要直接清掉", async () => {
  const { wireManualFileUpload } = await import("./builder");
  const nodes: WorkflowNode[] = [
    { id: "trigger", type: "trigger", label: "開始", config: { watchPath: "/Users/me/收件匣", watchPattern: "*.xlsx" }, position: { x: 0, y: 0 } },
    { id: "read", type: "excel-process", label: "讀 Excel", config: { inputPath: "" }, position: { x: 200, y: 0 } },
  ];
  const result = wireManualFileUpload(nodes, undefined, "每次執行時讓我選一份 Excel 檔");
  const trigger = result.nodes.find((n) => n.id === "trigger")!;
  assert.equal(trigger.config.watchPath, undefined, "資料夾監聽要被清掉，否則驗收永遠不過");
  assert.equal(trigger.config.watchPattern, undefined);
  assert.equal(result.nodes.find((n) => n.id === "read")!.config.inputPath, "{{filePath}}", "讀檔節點要接上選檔欄位");
  assert.ok(result.triggerParams?.some((p) => p.key === "filePath"), "要補上選檔欄位");
  assert.match(result.removed.join(""), /資料夾監聽/, "清掉了什麼要講出來");
});

test("手動選檔：使用者沒說要選檔時，資料夾監聽要原封不動", async () => {
  const { wireManualFileUpload } = await import("./builder");
  const nodes: WorkflowNode[] = [
    { id: "trigger", type: "trigger", label: "開始", config: { watchPath: "/Users/me/收件匣" }, position: { x: 0, y: 0 } },
  ];
  const result = wireManualFileUpload(nodes, undefined, "監聽這個資料夾，有新檔案就處理");
  assert.equal(result.nodes[0].config.watchPath, "/Users/me/收件匣");
  assert.deepEqual(result.removed, []);
});
