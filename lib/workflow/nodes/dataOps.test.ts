import { test } from "node:test";
import assert from "node:assert/strict";
import { filterRowsNode, sortRowsNode, aggregateRowsNode, dedupRowsNode } from "./dataOps";
import type { NodeContext } from "../types";

function ctx(config: Record<string, unknown>, input: Record<string, unknown>): NodeContext {
  return { runId: "t", workflowId: "zz-test", nodeId: "n", input, config, secrets: {}, vars: {}, model: "", baseUrl: "", apiKey: "", headed: false, outputDir: "/tmp", debugDir: "/tmp", session: {} as never, cancelSignal: new AbortController().signal, log: () => {}, registerFile: () => {} } as NodeContext;
}
const rows = [
  { 分類: "飲品", 品項: "咖啡", 金額: "12,800" },
  { 分類: "烘焙", 品項: "可頌", 金額: 7200 },
  { 分類: "飲品", 品項: "掛耳", 金額: 21000 },
  { 分類: "飲品", 品項: "咖啡", 金額: 100 },
];

test("篩選:等於/大於(含千分位字串數字)/欄位不存在要列出實際欄位", async () => {
  const eq = await filterRowsNode.execute(ctx({ field: "分類", op: "equals", value: "飲品" }, { rows }));
  assert.equal(eq.output.rowCount, 3);
  const gt = await filterRowsNode.execute(ctx({ field: "金額", op: "gt", value: "10000" }, { rows }));
  assert.equal(gt.output.rowCount, 2, "千分位字串 12,800 要當數字比");
  await assert.rejects(() => filterRowsNode.execute(ctx({ field: "不存在欄", op: "equals", value: "x" }, { rows })), /實際的欄位有.*分類/);
  await assert.rejects(() => filterRowsNode.execute(ctx({ field: "分類", op: "equals", value: "x" }, { 沒有清單: 1 })), /要接在/);
});

test("排序:數字欄用數值比(不是字串比),大到小", async () => {
  const r = await sortRowsNode.execute(ctx({ field: "金額", direction: "desc" }, { rows }));
  const amounts = (r.output.rows as { 金額: unknown }[]).map((x) => x.金額);
  assert.deepEqual(amounts, [21000, "12,800", 7200, 100]);
});

test("彙總:分組筆數+加總;不分組=整體", async () => {
  const g = await aggregateRowsNode.execute(ctx({ groupBy: "分類", sumField: "金額" }, { rows }));
  assert.equal(g.output.rowCount, 2);
  const drink = (g.output.rows as { 分組: string; 筆數: number; 加總: number }[]).find((x) => x.分組 === "飲品")!;
  assert.equal(drink.筆數, 3);
  assert.equal(drink.加總, 12800 + 21000 + 100);
  assert.equal(g.output.grandTotal, 12800 + 7200 + 21000 + 100);
});

test("去重:依多欄位判重,留第一筆並回報移除數", async () => {
  const r = await dedupRowsNode.execute(ctx({ fields: "分類,品項" }, { rows }));
  assert.equal(r.output.rowCount, 3);
  assert.equal(r.output.removedCount, 1);
});
