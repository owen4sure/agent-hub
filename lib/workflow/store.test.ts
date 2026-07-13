import { test } from "node:test";
import assert from "node:assert/strict";
import { graphUntouchedSinceApply } from "./store";
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
