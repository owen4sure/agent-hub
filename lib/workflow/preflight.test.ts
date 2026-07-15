import assert from "node:assert/strict";
import test from "node:test";
import { collectExternalPreflightTargets } from "./preflight";
import type { Workflow } from "./types";

function workflow(nodes: Workflow["nodes"]): Workflow {
  return {
    id: "wf-test",
    name: "測試",
    status: "draft",
    builtin: false,
    defaultModel: "minimax-m3",
    nodes,
    edges: [],
  };
}

test("正式執行前只預檢需要 v2 能力的 Sheet 更新節點", () => {
  const targets = collectExternalPreflightTargets(workflow([
    { id: "read", type: "google-sheet-read", label: "讀取", position: { x: 0, y: 0 }, config: { sheetUrl: "https://docs.google.com/spreadsheets/d/x" } },
    { id: "append", type: "google-sheet-append", label: "新增列", position: { x: 0, y: 0 }, config: { scriptUrl: "https://script.google.com/macros/s/append/exec" } },
    { id: "update", type: "google-sheet-update", label: "更新週報", position: { x: 0, y: 0 }, config: { scriptUrl: "https://script.google.com/macros/s/v2/exec" } },
  ]));
  assert.deepEqual(targets, [{
    nodeId: "update",
    nodeLabel: "更新週報",
    kind: "google-sheet-v2",
    endpoint: "https://script.google.com/macros/s/v2/exec",
  }]);
});

test("同一個 Sheet deployment 只預檢一次並保留第一個可定位節點", () => {
  const endpoint = "https://script.google.com/macros/s/shared/exec";
  const targets = collectExternalPreflightTargets(workflow([
    { id: "a", type: "google-sheet-update", label: "更新 A", position: { x: 0, y: 0 }, config: { scriptUrl: endpoint } },
    { id: "b", type: "google-sheet-update", label: "更新 B", position: { x: 0, y: 0 }, config: { scriptUrl: endpoint } },
    { id: "empty", type: "google-sheet-update", label: "未設定", position: { x: 0, y: 0 }, config: {} },
  ]));
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.nodeId, "a");
});
