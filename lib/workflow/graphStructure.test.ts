import test from "node:test";
import assert from "node:assert/strict";
import { applyGraphStructureEdits, hasStructureChanges, planGraphStructureEdits } from "./graphStructure";
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

// 真實踩過的事故：模型照抄範例 JSON 形狀，即使只是改設定也常常順手附一個空的 structure({})——
// 呼叫端不能只看「structure 這個 key 存不存在」，否則會把空殼送進 planGraphStructureEdits 判定
// 「沒有任何實際修改」，擋下整包原本合法的 edits(wf-0d10f38d-copy-8eed43-copy-060a04 真實踩過，
// 燒光 5 分鐘建圖逾時)。
test("hasStructureChanges：空殼 structure(模型照抄範本殘留)一律視為沒有實際修改", () => {
  assert.equal(hasStructureChanges(undefined), false);
  assert.equal(hasStructureChanges(null), false);
  assert.equal(hasStructureChanges({}), false);
  assert.equal(hasStructureChanges({ removeNodeIds: [], addNodes: [], addEdges: [], removeEdges: [] }), false);
  assert.equal(hasStructureChanges([] as never), false);
  assert.equal(hasStructureChanges("not-an-object" as never), false);
});

test("hasStructureChanges：任一陣列有實際內容就算真的要修改", () => {
  assert.equal(hasStructureChanges({ removeNodeIds: ["n1"] }), true);
  assert.equal(hasStructureChanges({ addNodes: [{ id: "n2", type: "template-text", label: "x", config: {} }] }), true);
  assert.equal(hasStructureChanges({ addEdges: [{ from: "n1", to: "n2" }] }), true);
  assert.equal(hasStructureChanges({ removeEdges: [{ from: "n1", to: "n2" }] }), true);
});
