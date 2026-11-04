import assert from "node:assert/strict";
import test from "node:test";
import { collectExternalPreflightTargets, preflightExternalIntegrations, ExternalPreflightError, clearExternalPreflightCacheForTests } from "./preflight";
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

test("正式執行前只預檢需要 v3 能力的 Sheet 更新節點", () => {
  const targets = collectExternalPreflightTargets(workflow([
    { id: "read", type: "google-sheet-read", label: "讀取", position: { x: 0, y: 0 }, config: { sheetUrl: "https://docs.google.com/spreadsheets/d/x" } },
    { id: "append", type: "google-sheet-append", label: "新增列", position: { x: 0, y: 0 }, config: { scriptUrl: "https://script.google.com/macros/s/append/exec" } },
    { id: "update", type: "google-sheet-update", label: "更新週報", position: { x: 0, y: 0 }, config: { scriptUrl: "https://script.google.com/macros/s/v2/exec" } },
  ]));
  assert.deepEqual(targets, [{
    nodeId: "update",
    nodeLabel: "更新週報",
    kind: "google-sheet-v3",
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

// 真實踩過：這個檢查跑在引擎的節點重試機制之外(任何節點開始前就先做)，同一支網址只是偶爾
// 暫時性失敗，卻因為被這個檢查打到就讓使用者連登入、抓信都還沒開始就整條流程失敗——比正式
// 執行時的寫入節點本身還沒耐受度。
test("preflightExternalIntegrations：探測第一次暫時性失敗、第二次成功時不該讓整條流程失敗", async () => {
  clearExternalPreflightCacheForTests();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return new Response("Not Found", { status: 404 });
    return new Response(JSON.stringify({ ok: true, agentHubVersion: 4, actions: ["writeCells", "updateTable", "readCells"] }), { status: 200 });
  }) as typeof fetch;
  try {
    const wf: Workflow = {
      id: "wf-test", name: "測試", status: "draft", builtin: false, defaultModel: "minimax-m3",
      nodes: [{ id: "update", type: "google-sheet-update", label: "更新週報", position: { x: 0, y: 0 }, config: { scriptUrl: "https://script.google.com/macros/s/flaky/exec" } }],
      edges: [],
    };
    await preflightExternalIntegrations(wf);
    assert.ok(calls >= 2, "應該重試過至少一次");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preflightExternalIntegrations：持續失敗(不是偶發)還是要老實擋下來，不能無限重試", async () => {
  clearExternalPreflightCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;
  try {
    const wf: Workflow = {
      id: "wf-test", name: "測試", status: "draft", builtin: false, defaultModel: "minimax-m3",
      nodes: [{ id: "update", type: "google-sheet-update", label: "更新週報", position: { x: 0, y: 0 }, config: { scriptUrl: "https://script.google.com/macros/s/dead/exec" } }],
      edges: [],
    };
    await assert.rejects(preflightExternalIntegrations(wf), ExternalPreflightError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
