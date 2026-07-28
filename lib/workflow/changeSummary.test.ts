import assert from "node:assert/strict";
import test from "node:test";
import { summarizeWorkflowChange } from "./changeSummary";
import type { Workflow } from "./types";

const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: "wf-change", name: "原流程", status: "draft", builtin: false, defaultModel: "minimax-m3",
  nodes: [{ id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }, { id: "n", type: "template-text", label: "組文字", config: { template: "{{x}}" }, position: { x: 100, y: 0 } }],
  edges: [{ from: "t", to: "n" }], ...overrides,
});

test("變更摘要忽略座標，只報節點設定、連線與新增副作用", () => {
  const before = workflow();
  const after = workflow({ nodes: [...before.nodes.map((node) => node.id === "n" ? { ...node, config: { template: "{{x}}", outputKey: "message" } } : { ...node, position: { x: 999, y: 999 } }), { id: "mail", type: "send-email", label: "寄信", config: {}, position: { x: 300, y: 0 } }], edges: [...before.edges, { from: "n", to: "mail" }] });
  const result = summarizeWorkflowChange(before, after);
  assert.equal(result.changedNodes[0].changes.includes("步驟設定"), true);
  assert.equal(result.addedNodes[0].label, "寄信");
  assert.deepEqual(result.riskEffectsAdded, ["email"]);
  assert.equal(result.hasChanges, true);
});

test("沒有執行語意變更時，單純拖動畫布不算版本差異", () => {
  const before = workflow();
  const result = summarizeWorkflowChange(before, workflow({ nodes: before.nodes.map((node) => ({ ...node, position: { x: node.position.x + 50, y: node.position.y + 50 } })) }));
  assert.equal(result.hasChanges, false);
  assert.deepEqual(result.changedNodes, []);
});
