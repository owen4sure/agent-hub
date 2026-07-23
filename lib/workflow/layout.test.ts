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

test("畫布:依實際使用者截圖核對出的錯位排法——每一步都左右錯開一小段、上下交錯，不折行、連續往右延伸", () => {
  const nodes = Array.from({ length: 10 }, (_, index) => node(`n${index}`, index * 310, 80));
  const edges = nodes.slice(1).map((current, index) => ({ from: nodes[index].id, to: current.id }));
  const positions = autoLayout(nodes, edges);
  assert.deepEqual(positions.n0, { x: 80, y: 80 });
  assert.deepEqual(positions.n1, { x: 195, y: 210 });
  assert.deepEqual(positions.n2, { x: 310, y: 80 });
  assert.deepEqual(positions.n3, { x: 425, y: 210 });
  // 連續往右延伸，不折行、不回頭
  assert.deepEqual(positions.n9, { x: 80 + 9 * 115, y: 210 });
  // 只有兩個 y 值(上/下交錯)，不會出現第三種高度
  assert.deepEqual(new Set(Object.values(positions).map((p) => p.y)), new Set([80, 210]));
});

test("畫布:2026-07-14 版的單一橫排長鏈是舊排法，載入時會自動升級成錯位排法；已經手動排成多列的不碰", () => {
  const nodes = Array.from({ length: 8 }, (_, index) => node(`n${index}`, 80 + index * 215, 80));
  const edges = nodes.slice(1).map((current, index) => ({ from: nodes[index].id, to: current.id }));
  const upgraded = compactLegacyLongChain(nodes, edges);
  assert.ok(upgraded);
  assert.deepEqual(upgraded?.n1, { x: 195, y: 210 });
  nodes[4].position.y = 400;
  assert.equal(compactLegacyLongChain(nodes, edges), null);
});

test("畫布:短暫存在過的三欄蛇形會升級成現在的錯位排法", () => {
  const nodes = Array.from({ length: 8 }, (_, index) => {
    const row = Math.floor(index / 3);
    const inRow = index % 3;
    const column = row % 2 === 0 ? inRow : 2 - inRow;
    return node(`n${index}`, 80 + column * 310, 80 + row * 155);
  });
  const edges = nodes.slice(1).map((current, index) => ({ from: nodes[index].id, to: current.id }));
  const upgraded = compactLegacyLongChain(nodes, edges);
  assert.deepEqual(upgraded?.n0, { x: 80, y: 80 });
  assert.deepEqual(upgraded?.n1, { x: 195, y: 210 });
});

test("畫布:舊的窄兩欄蛇形會自動升級成現在的錯位排法", () => {
  const nodes = Array.from({ length: 8 }, (_, index) => {
    const row = Math.floor(index / 2);
    const inRow = index % 2;
    const column = row % 2 === 0 ? inRow : 1 - inRow;
    return node(`n${index}`, 80 + column * 310, 80 + row * 155);
  });
  const edges = nodes.slice(1).map((current, index) => ({ from: nodes[index].id, to: current.id }));
  const upgraded = compactLegacyLongChain(nodes, edges);
  assert.deepEqual(upgraded?.n0, { x: 80, y: 80 });
  assert.deepEqual(upgraded?.n1, { x: 195, y: 210 });
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
  assert.deepEqual(upgraded?.n2, { x: 310, y: 80 });
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
  assert.deepEqual(upgraded?.n1, { x: 195, y: 210 });
});

test("畫布:有真正分支的圖，每個分支各自佔一步、依序錯位排開，不會疊在一起", () => {
  const nodes: WorkflowNode[] = [node("t", 0, 0), node("a", 0, 0), node("b0", 0, 0), node("b1", 0, 0), node("b2", 0, 0)];
  const edges = [
    { from: "t", to: "a" },
    { from: "a", to: "b0" }, { from: "a", to: "b1" }, { from: "a", to: "b2" },
  ];
  const positions = autoLayout(nodes, edges);
  const all = Object.values(positions);
  // 5 個節點應該落在 5 個不同的位置(沒有任兩個完全疊在一起)
  const keys = new Set(all.map((p) => `${p.x},${p.y}`));
  assert.equal(keys.size, 5);
});

test("畫布:實際踩過的真實案例——長直線流程後接分支(3條裡只有1條繼續走)，接續的下一步照樣依序錯位排開", () => {
  const nodes: WorkflowNode[] = [];
  const edges: { from: string; to: string }[] = [];
  let prev: string | null = null;
  for (let i = 0; i < 16; i++) {
    nodes.push(node(`t${i}`, 0, 0));
    if (prev) edges.push({ from: prev, to: `t${i}` });
    prev = `t${i}`;
  }
  // t15 (依檔案格式分流) fan-out 成 3 條，只有 continue 那條會繼續往下走
  nodes.push(node("deadEndA", 0, 0), node("deadEndB", 0, 0), node("continue", 0, 0));
  edges.push({ from: "t15", to: "deadEndA" }, { from: "t15", to: "deadEndB" }, { from: "t15", to: "continue" });
  prev = "continue";
  for (const id of ["c1", "c2", "c3"]) {
    nodes.push(node(id, 0, 0));
    edges.push({ from: prev!, to: id });
    prev = id;
  }
  const positions = autoLayout(nodes, edges);
  // 沒有任兩個節點疊在一起
  const keys = new Set(Object.values(positions).map((p) => `${p.x},${p.y}`));
  assert.equal(keys.size, nodes.length);
  // 真正繼續走下去的那條分支跟它接續的下一步，沒有中間節點的死路分支被拆到序列裡打斷
  assert.equal(positions.continue.x, positions.t15.x + 115);
  assert.equal(positions.c1.x, positions.continue.x + 115);
  // 死路分支貼在分岔點(t15)正右邊，不佔用主幹序列的位置(不會把 c1/c2/c3 往後擠)
  assert.equal(positions.deadEndA.x, positions.continue.x);
  assert.equal(positions.deadEndB.x, positions.continue.x);
  // 任兩個節點的中心距離都要夠遠，不會有卡片重疊/連線斜插過去的疑慮
  const all = Object.values(positions);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const dx = Math.abs(all[i].x - all[j].x);
      const dy = Math.abs(all[i].y - all[j].y);
      assert.ok(dx >= 210 || dy >= 125, `節點 ${i},${j} 太近: dx=${dx} dy=${dy}`);
    }
  }
});

test("畫布:流程導覽順序取自真實連線，不依賴 nodes 陣列剛好排序", () => {
  const nodes = [node("c", 0, 0), node("a", 0, 0), node("b", 0, 0), node("d", 0, 0), node("e", 0, 0), node("f", 0, 0), node("g", 0, 0)];
  const edges = [
    { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" },
    { from: "d", to: "e" }, { from: "e", to: "f" }, { from: "f", to: "g" },
  ];
  assert.deepEqual(simpleChainSequence(nodes, edges), ["a", "b", "c", "d", "e", "f", "g"]);
});
