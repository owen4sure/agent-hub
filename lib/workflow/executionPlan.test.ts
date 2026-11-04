import assert from "node:assert/strict";
import test from "node:test";
import { buildExecutionPlan } from "./executionPlan";
import type { Workflow } from "./types";

const base = (nodes: Workflow["nodes"]): Workflow => ({ id: "wf-plan", name: "執行計畫", status: "draft", builtin: false, defaultModel: "minimax-m3", nodes, edges: [] });

test("執行前計畫把讀取、檔案產出、外部寫入與通知分開列出", () => {
  const plan = buildExecutionPlan(base([
    { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
    { id: "read", type: "read-file", label: "讀取資料", config: { path: "{{filePath}}" }, position: { x: 0, y: 0 } },
    { id: "save", type: "write-file", label: "存成報表", config: { fileName: "/tmp/report.xlsx" }, position: { x: 0, y: 0 } },
    { id: "sheet", type: "google-sheet-update", label: "更新試算表", config: {}, position: { x: 0, y: 0 } },
    { id: "mail", type: "send-email", label: "寄出通知", config: {}, position: { x: 0, y: 0 } },
  ]), "abc");
  assert.equal(plan.graphFingerprint, "abc");
  assert.equal(plan.readCount, 2);
  assert.equal(plan.writeCount, 3);
  assert.equal(plan.requiresConfirmation, true);
  assert.deepEqual(plan.items.find((item) => item.nodeId === "save")?.destination, "本機檔案：report.xlsx");
  assert.ok(plan.effects.includes("remote-write"));
  assert.ok(plan.effects.includes("email"));
});

test("無法判定 custom-code 的副作用時必須標成待確認", () => {
  const plan = buildExecutionPlan(base([{ id: "code", type: "custom-code", label: "自訂步驟", config: {}, position: { x: 0, y: 0 } }]), "abc");
  assert.equal(plan.items[0].uncertain, true);
  assert.equal(plan.requiresConfirmation, true);
});

test("執行前計畫會攤平 repeat-steps 內的副作用，避免藏在容器裡", () => {
  const plan = buildExecutionPlan(base([{ id: "loop", type: "repeat-steps", label: "逐筆處理", config: { steps: JSON.stringify([{ type: "telegram-notify", label: "通知", config: { message: "x" } }]) }, position: { x: 0, y: 0 } }]), "abc");
  assert.ok(plan.items.some((item) => item.nodeId === "loop[步驟0]" && item.effects.includes("notify")));
  assert.equal(plan.requiresConfirmation, true);
});
