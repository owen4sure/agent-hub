import { test } from "node:test";
import assert from "node:assert/strict";
import { collectRunSeeds, downstreamNodeIds } from "./partialRun";
import { DRY_RUN_SKIPPED_WRITES_KEY } from "./dryRun";
import type { WorkflowEdge, WorkflowNode } from "./types";

const node = (id: string, type = "custom-code"): WorkflowNode =>
  ({ id, type, label: id, config: {}, x: 0, y: 0 } as unknown as WorkflowNode);
const edge = (from: string, to: string, fromPort?: string): WorkflowEdge =>
  ({ from, to, ...(fromPort ? { fromPort } : {}) } as WorkflowEdge);

test("downstreamNodeIds：只含起點+它的所有下游，不含上游與旁支", () => {
  // trigger → a → b → sw ─(x)→ c
  //                     └─(y)→ d
  const edges = [edge("trigger", "a"), edge("a", "b"), edge("b", "sw"), edge("sw", "c", "x"), edge("sw", "d", "y")];
  assert.deepEqual([...downstreamNodeIds(edges, "b")].sort(), ["b", "c", "d", "sw"]);
  assert.deepEqual([...downstreamNodeIds(edges, "c")].sort(), ["c"]);
  // 起點是全圖第一步=整條都重跑
  assert.deepEqual([...downstreamNodeIds(edges, "trigger")].sort(), ["a", "b", "c", "d", "sw", "trigger"]);
});

test("collectRunSeeds：只收成功節點；合併輸出=input+output；分支 port 有存就用、沒存就從輸出反推", () => {
  const nodes = [node("a"), node("sw", "switch"), node("ifn", "if-condition"), node("failed")];
  const rows = [
    { node_id: "a", status: "success", input_json: '{"x":1}', output_json: '{"y":2}', active_ports: null },
    { node_id: "sw", status: "success", input_json: null, output_json: '{"matched":"PPTX"}', active_ports: null },
    { node_id: "ifn", status: "success", input_json: null, output_json: '{"result":true}', active_ports: '["true"]' },
    { node_id: "failed", status: "failed", input_json: null, output_json: null, active_ports: null },
  ];
  const { seeds, seedPorts } = collectRunSeeds(nodes, rows);
  assert.deepEqual(seeds.a, { x: 1, y: 2 });
  assert.equal(seeds.failed, undefined); // 失敗的不能當種子
  assert.deepEqual(seedPorts.sw, ["PPTX"]); // switch 舊資料沒存 ports → 從 matched 反推
  assert.deepEqual(seedPorts.ifn, ["true"]); // 有存就直接用
});

test("collectRunSeeds：status=success 但帶 DRY_RUN_SKIPPED_WRITES_KEY 標記的列(只讀試跑內部攔下寫入)不能當種子——否則後續正式執行會沿用假成功、真正的寫入永遠不會發生", () => {
  const nodes = [node("write-step")];
  const rows = [
    {
      node_id: "write-step",
      status: "success",
      input_json: '{"a":1}',
      output_json: JSON.stringify({ a: 1, [DRY_RUN_SKIPPED_WRITES_KEY]: [{ nodeLabel: "寫回試算表", type: "custom-code", config: {}, input: {} }] }),
      active_ports: null,
    },
  ];
  const { seeds } = collectRunSeeds(nodes, rows);
  assert.equal(seeds["write-step"], undefined);
});
