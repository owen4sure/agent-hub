import { test } from "node:test";
import assert from "node:assert/strict";
import { graphUntouchedSinceApply, mergeWorkflowWithLatest, WorkflowConflictError } from "./store";
import type { Workflow } from "./types";
import type { WorkflowNode, WorkflowEdge, ParamField } from "./types";

const N = (id: string): WorkflowNode => ({ id, type: "write-file", label: id, config: {}, position: { x: 0, y: 0 } });
const nodes: WorkflowNode[] = [N("a"), N("b")];
const edges: WorkflowEdge[] = [{ from: "a", to: "b" }];
const params: ParamField[] = [{ key: "x", label: "X", type: "text" }];

test("graphUntouchedSinceApply：跟剛套用的內容完全一樣才算沒被動過", () => {
  assert.equal(
    graphUntouchedSinceApply({ nodes, edges, triggerParams: params }, { nodes, edges, triggerParams: params }),
    true,
  );
});

test("graphUntouchedSinceApply：nodes 不同(拖過位置/改過設定)算被動過，不能安全回滾", () => {
  const movedNode = { ...N("a"), position: { x: 999, y: 0 } };
  assert.equal(
    graphUntouchedSinceApply({ nodes: [movedNode, N("b")], edges, triggerParams: params }, { nodes, edges, triggerParams: params }),
    false,
  );
});

test("graphUntouchedSinceApply：edges 不同算被動過", () => {
  assert.equal(
    graphUntouchedSinceApply({ nodes, edges: [], triggerParams: params }, { nodes, edges, triggerParams: params }),
    false,
  );
});

test("graphUntouchedSinceApply：triggerParams 不同算被動過；undefined 跟空陣列不同不能誤判成一樣", () => {
  assert.equal(
    graphUntouchedSinceApply({ nodes, edges, triggerParams: [] }, { nodes, edges, triggerParams: params }),
    false,
  );
  // undefined 跟 undefined 比對(都沒宣告 triggerParams)算沒被動過
  assert.equal(
    graphUntouchedSinceApply({ nodes, edges, triggerParams: undefined }, { nodes, edges, triggerParams: undefined }),
    true,
  );
});

function W(nodesValue = nodes): Workflow {
  return { id: "wf-merge", name: "原名", status: "draft", builtin: false, defaultModel: "minimax-m3", nodes: nodesValue, edges };
}

test("跨進程三方合併：一邊拖位置、一邊 AI 改 config，兩邊都保留", () => {
  const base = W();
  const desired = W([{ ...N("a"), config: { value: "AI 修好" } }, N("b")]);
  const latest = W([{ ...N("a"), position: { x: 900, y: 30 } }, N("b")]);
  const merged = mergeWorkflowWithLatest(base, desired, latest);
  assert.deepEqual(merged.nodes[0].config, { value: "AI 修好" });
  assert.deepEqual(merged.nodes[0].position, { x: 900, y: 30 });
});

test("跨進程三方合併：同一設定被改成不同值時拒絕，不做最後寫入者覆蓋", () => {
  const base = W([{ ...N("a"), config: { value: "舊" } }, N("b")]);
  const desired = W([{ ...N("a"), config: { value: "AI" } }, N("b")]);
  const latest = W([{ ...N("a"), config: { value: "使用者" } }, N("b")]);
  assert.throws(() => mergeWorkflowWithLatest(base, desired, latest), WorkflowConflictError);
});
