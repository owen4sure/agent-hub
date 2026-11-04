import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowDataFlow } from "./dataFlow";
import type { Workflow } from "./types";

const base: Workflow = {
  id: "wf-data-flow", name: "資料流測試", status: "draft", builtin: false, defaultModel: "minimax-m3",
  nodes: [
    { id: "t", type: "trigger", label: "收到檔案", config: {}, position: { x: 0, y: 0 } },
    { id: "code", type: "custom-code", label: "算出月份", config: { intent: "算月份", code: "return { month: '2026-07' };" }, position: { x: 200, y: 0 } },
    { id: "out", type: "template-text", label: "組通知", config: { template: "月份 {{month}}，檔案 {{missingValue}}" }, position: { x: 400, y: 0 } },
  ],
  edges: [{ from: "t", to: "code" }, { from: "code", to: "out" }],
};

test("資料流摘要會列出上游來源、執行期欄位與缺失引用", () => {
  const result = buildWorkflowDataFlow(base);
  const output = result.nodes.find((node) => node.id === "out")!;
  assert.equal(output.inputs.find((field) => field.name === "month")?.sources[0], "算出月份");
  assert.equal(output.references.find((ref) => ref.token === "month")?.status, "available");
  assert.equal(output.references.find((ref) => ref.token === "missingValue")?.status, "missing");
  assert.match(result.warnings[0], /missingValue/);
});

test("自訂程式碼無法靜態列舉時保守標成 unknown-source，不誤說欄位不存在", () => {
  const workflow = { ...base, nodes: base.nodes.map((node) => node.id === "code" ? { ...node, config: { code: "return {...someLocalObject};" } } : node) };
  const result = buildWorkflowDataFlow(workflow);
  const output = result.nodes.find((node) => node.id === "out")!;
  assert.equal(output.references.find((ref) => ref.token === "missingValue")?.status, "unknown-source");
  assert.deepEqual(result.warnings, []);
});
