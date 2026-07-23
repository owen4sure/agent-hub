import test from "node:test";
import assert from "node:assert/strict";
import { applyGraphStructureEdits, planGraphStructureEdits } from "./graphStructure";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";
import type { WorkflowNode } from "./types";

function baseNodes(): WorkflowNode[] {
  return [
    { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
    { id: "notice", type: "desktop-notify", label: "通知我", config: { message: "完成" }, position: { x: 220, y: 0 } },
    { id: "done", type: "template-text", label: "整理結果", config: { template: "完成" }, position: { x: 440, y: 0 } },
  ];
}

test("結構修改：刪除多餘節點並重接線，保留其他最新節點設定", () => {
  const result = planGraphStructureEdits(
    { nodes: baseNodes(), edges: [{ from: "trigger", to: "notice" }, { from: "notice", to: "done" }] },
    { removeNodeIds: ["notice"], addEdges: [{ from: "trigger", to: "done" }] },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.nodes.map((node) => node.id), ["trigger", "done"]);
  assert.deepEqual(result.edges, [{ from: "trigger", to: "done" }]);
  assert.match(result.changes.map((change) => change.detail).join("\n"), /已刪除/);
});

test("結構修改：若 AI 指到不存在節點，整組不產生半套圖", () => {
  const graph = { nodes: baseNodes(), edges: [{ from: "trigger", to: "notice" }, { from: "notice", to: "done" }] };
  const result = planGraphStructureEdits(graph, { removeNodeIds: ["does-not-exist"], addEdges: [{ from: "trigger", to: "done" }] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.nodes, graph.nodes);
  assert.deepEqual(result.edges, graph.edges);
  assert.match(result.problems.join("\n"), /找不到要刪除/);
});

test("結構修改：不能刪 trigger、不能加入造成環的接線", () => {
  const graph = { nodes: baseNodes(), edges: [{ from: "trigger", to: "notice" }, { from: "notice", to: "done" }] };
  const removeTrigger = planGraphStructureEdits(graph, { removeNodeIds: ["trigger"] });
  assert.equal(removeTrigger.ok, false);
  assert.match(removeTrigger.problems.join("\n"), /不能刪除/);
  const cycle = planGraphStructureEdits(graph, { addEdges: [{ from: "done", to: "notice" }] });
  assert.equal(cycle.ok, false);
  assert.match(cycle.problems.join("\n"), /有環/);
});

test("結構修改：真正套用時只以磁碟最新版合併，不覆蓋其他設定", () => {
  const workflow = createWorkflow(`test-structure-${Date.now()}`);
  try {
    saveWorkflow({ ...workflow, nodes: baseNodes(), edges: [{ from: "trigger", to: "notice" }, { from: "notice", to: "done" }] });
    const applied = applyGraphStructureEdits(workflow.id, { removeNodeIds: ["notice"], addEdges: [{ from: "trigger", to: "done" }] });
    assert.equal(applied.ok, true);
    const saved = getWorkflow(workflow.id)!;
    assert.deepEqual(saved.nodes.map((node) => node.id), ["trigger", "done"]);
    assert.deepEqual(saved.edges, [{ from: "trigger", to: "done" }]);
    assert.equal(saved.nodes.find((node) => node.id === "done")?.config.template, "完成");
  } finally {
    deleteWorkflow(workflow.id);
  }
});
