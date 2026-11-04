import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptanceSpecOutdated, isAcceptanceSpecForGraph, normalizeAcceptanceSpec } from "./acceptanceSpec";
import { workflowExecutionFingerprint } from "./fingerprint";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";

const graph = { nodes: [], edges: [], triggerParams: [], defaultModel: "test" };
const fingerprint = () => "a".repeat(64);

test("驗收標準只對應保存時的流程版本", () => {
  const spec = normalizeAcceptanceSpec({ expectedAnswer: "應該有 5 筆", graphFingerprint: fingerprint(), savedAt: "2026-07-27T00:00:00.000Z" });
  assert.equal(isAcceptanceSpecForGraph(spec!, graph, fingerprint), true);
  assert.equal(isAcceptanceSpecForGraph({ ...spec!, graphFingerprint: "b".repeat(64) }, graph, fingerprint), false);
});

test("驗收標準拒絕空答案、錯誤指紋與超長內容", () => {
  assert.throws(() => normalizeAcceptanceSpec({ expectedAnswer: "", graphFingerprint: fingerprint(), savedAt: "now" }), /必須填寫/);
  assert.throws(() => normalizeAcceptanceSpec({ expectedAnswer: "有答案", graphFingerprint: "bad", savedAt: "now" }), /指紋/);
  assert.throws(() => normalizeAcceptanceSpec({ expectedAnswer: "x".repeat(4_001), graphFingerprint: fingerprint(), savedAt: "now" }), /必須填寫/);
});

test("驗收標準會持久化，但流程內容一改就不再對目前版本有效", () => {
  const created = createWorkflow(`test-acceptance-spec-${Date.now()}`);
  try {
    const graphFingerprint = workflowExecutionFingerprint(created);
    saveWorkflow({ ...created, acceptanceSpec: { expectedAnswer: "應該有 5 筆", graphFingerprint, savedAt: new Date().toISOString() } });
    const loaded = getWorkflow(created.id)!;
    assert.equal(loaded.acceptanceSpec?.expectedAnswer, "應該有 5 筆");
    assert.equal(isAcceptanceSpecForGraph(loaded.acceptanceSpec, loaded, workflowExecutionFingerprint), true);
    saveWorkflow({ ...loaded, nodes: loaded.nodes.map((node) => node.id === "trigger" ? { ...node, label: "新的開始" } : node) });
    const changed = getWorkflow(created.id)!;
    assert.equal(changed.acceptanceSpec?.expectedAnswer, "應該有 5 筆");
    assert.equal(isAcceptanceSpecForGraph(changed.acceptanceSpec, changed, workflowExecutionFingerprint), false);
    assert.equal(acceptanceSpecOutdated(changed.acceptanceSpec, changed, workflowExecutionFingerprint), true);
  } finally {
    deleteWorkflow(created.id);
  }
});

test("沒有驗收標準的舊流程不會被版本閘門誤擋", () => {
  assert.equal(acceptanceSpecOutdated(undefined, graph, fingerprint), false);
});
