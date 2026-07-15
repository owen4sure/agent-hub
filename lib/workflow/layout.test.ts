import { test } from "node:test";
import assert from "node:assert/strict";
import { autoLayout, compactLegacyLongChain, separateOverlappingNodes, simpleChainSequence } from "./layout";
import type { WorkflowNode } from "./types";

const node = (id: string, x: number, y: number): WorkflowNode => ({ id, type: "custom-code", label: id, config: {}, position: { x, y } });

test("畫布:已重疊的節點會確定性錯開,原本沒撞到的不動", () => {
  const result = separateOverlappingNodes([node("a", 10, 20), node("b", 10, 20), node("c", 600, 20)]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.positions.a, { x: 10, y: 20 });
  assert.ok(result.positions.b.y > result.positions.a.y);
  assert.deepEqual(result.positions.c, { x: 600, y: 20 });
});

test("畫布:自動排列的同欄分支有足夠間距", () => {
  const nodes = [node("t", 0, 0), node("a", 0, 0), node("b", 0, 0)];
  const positions = autoLayout(nodes, [{ from: "t", to: "a" }, { from: "t", to: "b" }]);
  assert.ok(Math.abs(positions.a.y - positions.b.y) >= 150);
});

test("畫布:長直線流程固定由左到右，不再折成難讀的蛇形", () => {
  const nodes = Array.from({ length: 10 }, (_, index) => node(`n${index}`, index * 310, 80));
  const edges = nodes.slice(1).map((current, index) => ({ from: nodes[index].id, to: current.id }));
  const positions = autoLayout(nodes, edges);
  assert.deepEqual(positions.n0, { x: 80, y: 80 });
  assert.deepEqual(positions.n1, { x: 295, y: 80 });
  assert.deepEqual(positions.n2, { x: 510, y: 80 });
  assert.deepEqual(positions.n3, { x: 725, y: 80 });
  assert.deepEqual(new Set(Object.values(positions).map((position) => position.y)), new Set([80]));
});

test("畫布:舊版窄單列會拉開，已經手動排成多列的不碰", () => {
  const nodes = Array.from({ length: 8 }, (_, index) => node(`n${index}`, index * 310, 80));
  const edges = nodes.slice(1).map((current, index) => ({ from: nodes[index].id, to: current.id }));
  assert.ok(compactLegacyLongChain(nodes, edges));
  nodes[4].position.y = 400;
  assert.equal(compactLegacyLongChain(nodes, edges), null);
});

test("畫布:短暫存在過的三欄蛇形會升級成單向流程線", () => {
  const nodes = Array.from({ length: 8 }, (_, index) => {
    const row = Math.floor(index / 3);
    const inRow = index % 3;
    const column = row % 2 === 0 ? inRow : 2 - inRow;
    return node(`n${index}`, 80 + column * 310, 80 + row * 155);
  });
  const edges = nodes.slice(1).map((current, index) => ({ from: nodes[index].id, to: current.id }));
  const upgraded = compactLegacyLongChain(nodes, edges);
  assert.deepEqual(upgraded?.n0, { x: 80, y: 80 });
  assert.deepEqual(upgraded?.n1, { x: 295, y: 80 });
  assert.deepEqual(upgraded?.n2, { x: 510, y: 80 });
});

test("畫布:舊的窄兩欄蛇形會自動升級成單向流程線", () => {
  const nodes = Array.from({ length: 8 }, (_, index) => {
    const row = Math.floor(index / 2);
    const inRow = index % 2;
    const column = row % 2 === 0 ? inRow : 1 - inRow;
    return node(`n${index}`, 80 + column * 310, 80 + row * 155);
  });
  const edges = nodes.slice(1).map((current, index) => ({ from: nodes[index].id, to: current.id }));
  const upgraded = compactLegacyLongChain(nodes, edges);
  assert.deepEqual(upgraded?.n0, { x: 80, y: 80 });
  assert.deepEqual(upgraded?.n1, { x: 295, y: 80 });
  assert.deepEqual(upgraded?.n2, { x: 510, y: 80 });
});

test("畫布:380px 欄距／155px 列距的兩欄蛇形也會升級", () => {
  const nodes = Array.from({ length: 8 }, (_, index) => {
    const row = Math.floor(index / 2);
    const inRow = index % 2;
    const column = row % 2 === 0 ? inRow : 1 - inRow;
    return node(`n${index}`, 80 + column * 380, 80 + row * 155);
  });
  const edges = nodes.slice(1).map((current, index) => ({ from: nodes[index].id, to: current.id }));
  const upgraded = compactLegacyLongChain(nodes, edges);
  assert.deepEqual(upgraded?.n0, { x: 80, y: 80 });
  assert.deepEqual(upgraded?.n2, { x: 510, y: 80 });
});

test("畫布:380px 欄距／150px 列距的兩欄蛇形也會升級", () => {
  const nodes = Array.from({ length: 8 }, (_, index) => {
    const row = Math.floor(index / 2);
    const inRow = index % 2;
    const column = row % 2 === 0 ? inRow : 1 - inRow;
    return node(`n${index}`, 80 + column * 380, 80 + row * 150);
  });
  const edges = nodes.slice(1).map((current, index) => ({ from: nodes[index].id, to: current.id }));
  const upgraded = compactLegacyLongChain(nodes, edges);
  assert.deepEqual(upgraded?.n0, { x: 80, y: 80 });
  assert.deepEqual(upgraded?.n1, { x: 295, y: 80 });
});

test("畫布:流程導覽順序取自真實連線，不依賴 nodes 陣列剛好排序", () => {
  const nodes = [node("c", 0, 0), node("a", 0, 0), node("b", 0, 0), node("d", 0, 0), node("e", 0, 0), node("f", 0, 0), node("g", 0, 0)];
  const edges = [
    { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" },
    { from: "d", to: "e" }, { from: "e", to: "f" }, { from: "f", to: "g" },
  ];
  assert.deepEqual(simpleChainSequence(nodes, edges), ["a", "b", "c", "d", "e", "f", "g"]);
});
