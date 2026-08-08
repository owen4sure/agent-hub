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

test("大於/小於遇到比不了的值:當場報錯,絕不靜默留下 0 筆", async () => {
  // 「日期 大於 2026-01-01」——比較值不是數字。NaN 的比較永遠是 false，
  // 舊行為是安安靜靜濾掉全部資料、流程全綠、報表整份空白。
  await assert.rejects(
    () => filterRowsNode.execute(ctx({ field: "金額", op: "gt", value: "2026-01-01" }, { rows })),
    /不是數字|沒辦法比大小/,
  );
  // 欄位本身整欄都不是數字(日期字串)
  const dates = [{ 訂單日期: "2026-01-05" }, { 訂單日期: "2026-02-11" }];
  await assert.rejects(
    () => filterRowsNode.execute(ctx({ field: "訂單日期", op: "gt", value: "20260101" }, { rows: dates })),
    /沒有任何一格是數字/,
  );
  // 只有部分是空白/非數字 → 照樣比得下去，空的那筆不符合而已
  const mixed = [{ 金額: 100 }, { 金額: "" }, { 金額: 50000 }];
  const r = await filterRowsNode.execute(ctx({ field: "金額", op: "gt", value: "1000" }, { rows: mixed }));
  assert.equal(r.output.rowCount, 1);
});

test("排序:空白格一律排最後,而且順序必須是穩定可預測的", async () => {
  // 舊行為讓空白「跟誰都一樣大」→ 比較器不遞移 → 排出來的順序取決於原始資料順序，
  // 「排序後取前 N 名」會拿到錯的名單。這裡用同一份資料的兩種排列驗證結果一致。
  const a = [{ 金額: 100 }, { 金額: "" }, { 金額: 21000 }, { 金額: 7200 }];
  const b = [{ 金額: 21000 }, { 金額: 7200 }, { 金額: "" }, { 金額: 100 }];
  const pick = async (rowsIn: Record<string, unknown>[]) =>
    ((await sortRowsNode.execute(ctx({ field: "金額", direction: "desc" }, { rows: rowsIn }))).output.rows as { 金額: unknown }[]).map((x) => x.金額);
  assert.deepEqual(await pick(a), [21000, 7200, 100, ""]);
  assert.deepEqual(await pick(b), [21000, 7200, 100, ""], "換一種輸入順序，結果必須一模一樣");
  const asc = await sortRowsNode.execute(ctx({ field: "金額", direction: "asc" }, { rows: a }));
  assert.deepEqual((asc.output.rows as { 金額: unknown }[]).map((x) => x.金額), [100, 7200, 21000, ""], "小到大時空白一樣排最後");
});
