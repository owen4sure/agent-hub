import test from "node:test";
import assert from "node:assert/strict";
import { workflowExecutionFingerprint } from "./fingerprint";
import type { Workflow } from "./types";

const workflow = {
  nodes: [
    { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
    { id: "n", type: "template-text", label: "組內容", config: { template: "{{value}}" }, position: { x: 240, y: 0 } },
  ],
  edges: [{ from: "t", to: "n" }],
  triggerParams: [{ key: "value", label: "內容", type: "text" as const }],
  defaultModel: "minimax-m3",
} satisfies Pick<Workflow, "nodes" | "edges" | "triggerParams" | "defaultModel">;

test("安全預覽指紋：拖位置不失效，但設定、接線、參數或模型改變一定失效", () => {
  const base = workflowExecutionFingerprint(workflow);
  assert.equal(workflowExecutionFingerprint({
    ...workflow,
    nodes: workflow.nodes.map((node) => ({ ...node, position: { x: node.position.x + 99, y: 88 } })),
  }), base);
  assert.notEqual(workflowExecutionFingerprint({
    ...workflow,
    nodes: workflow.nodes.map((node) => node.id === "n" ? { ...node, config: { template: "已改" } } : node),
  }), base);
  assert.notEqual(workflowExecutionFingerprint({ ...workflow, edges: [] }), base);
  assert.notEqual(workflowExecutionFingerprint({ ...workflow, triggerParams: [] }), base);
  assert.notEqual(workflowExecutionFingerprint({ ...workflow, defaultModel: "Qwen--3.5-max" }), base);
});
