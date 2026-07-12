import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRequirements, unmetFeedback, checklistText } from "./requirementCheck";
import type { WorkflowNode, WorkflowEdge } from "./types";

const N = (id: string, type: string): WorkflowNode => ({ id, type, label: id, config: {}, position: { x: 0, y: 0 } });
const g = (nodes: WorkflowNode[], edges: WorkflowEdge[] = [], extra: { schedule?: { cron: string } } = {}) => ({ nodes, edges, ...extra });

test("需求驗收:簽核/門檻/通知都有對應節點 → 全過", () => {
  const items = checkRequirements(
    "金額超過 5000 要等我核准,核准後用 telegram 通知",
    g([N("t", "trigger"), N("i", "if-condition"), N("a", "wait-approval"), N("n", "telegram-notify")]),
  );
  assert.ok(items.length >= 3);
  assert.ok(items.every((i) => i.met), JSON.stringify(items));
  assert.equal(unmetFeedback(items), "");
});

test("需求驗收:講了簽核但圖上沒有 wait-approval → 未達+具體指引", () => {
  const items = checkRequirements("超過一萬要我核准才放行", g([N("t", "trigger"), N("i", "if-condition")]));
  const approval = items.find((i) => i.key === "approval");
  assert.ok(approval && !approval.met);
  assert.ok(unmetFeedback(items).includes("wait-approval"));
  assert.ok(checklistText(items).includes("⚠️"));
});

test("需求驗收:排程訊號要求 schedule 建議;失敗備案要求 error 邊", () => {
  const noSched = checkRequirements("每天早上抓網頁,失敗要有備案", g([N("t", "trigger"), N("w", "web-page")]));
  assert.ok(noSched.find((i) => i.key === "schedule" && !i.met));
  assert.ok(noSched.find((i) => i.key === "planB" && !i.met));
  const ok = checkRequirements(
    "每天早上抓網頁,失敗要有備案",
    g([N("t", "trigger"), N("w", "web-page"), N("d", "desktop-notify")], [{ from: "w", to: "d", fromPort: "error" }], { schedule: { cron: "0 9 * * *" } }),
  );
  assert.ok(ok.every((i) => i.met), JSON.stringify(ok));
});

test("需求驗收:沒有訊號就不出項目(不誤報)", () => {
  const items = checkRequirements("抓一個網頁的標題", g([N("t", "trigger"), N("w", "web-page")]));
  assert.equal(items.length, 0);
  assert.equal(checklistText(items), "");
});
