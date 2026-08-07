import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRowsNode } from "./mergeRows";
import type { NodeContext } from "../types";

function ctx(config: Record<string, unknown>, outputs: Record<string, Record<string, unknown>>): NodeContext {
  return { runId: "t", workflowId: "zz-test", nodeId: "m", input: {}, outputs, config, secrets: {}, vars: {}, model: "", baseUrl: "", apiKey: "", headed: false, outputDir: "/tmp", debugDir: "/tmp", session: {} as never, cancelSignal: new AbortController().signal, log: () => {}, registerFile: () => {} } as NodeContext;
}

test("接起來:兩個分支各自的 rows 用分開層抓,不吃攤平後蓋前", async () => {
  const r = await mergeRowsNode.execute(ctx({ mode: "append" }, {
    branchA: { rows: [{ n: 1 }, { n: 2 }] },
    branchB: { rows: [{ n: 3 }] },
    other: { notRows: true },
  }));
  assert.equal(r.output.rowCount, 3);
  assert.deepEqual(r.output.mergedFrom, ["branchA", "branchB"]);
});

test("依鍵合併:同鍵的欄位拼成一筆;缺鍵欄位要指名哪個上游並列實際欄位", async () => {
  const r = await mergeRowsNode.execute(ctx({ mode: "by-key", key: "email" }, {
    a: { rows: [{ email: "x@y.z", 名字: "小明" }] },
    b: { rows: [{ email: "x@y.z", 金額: 100 }, { email: "q@y.z", 金額: 5 }] },
  }));
  assert.equal(r.output.rowCount, 2);
  const merged = (r.output.rows as Record<string, unknown>[]).find((x) => x.email === "x@y.z")!;
  assert.equal(merged.名字, "小明");
  assert.equal(merged.金額, 100);
  await assert.rejects(() => mergeRowsNode.execute(ctx({ mode: "by-key", key: "沒這欄" }, { a: { rows: [{ email: "e" }] } })), /實際欄位/);
});

test("沒有任何上游輸出清單=老實報錯教怎麼接", async () => {
  await assert.rejects(() => mergeRowsNode.execute(ctx({ mode: "append" }, {})), /要接在/);
});
