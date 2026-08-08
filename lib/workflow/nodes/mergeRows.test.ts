import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRowsNode } from "./mergeRows";
import type { NodeContext } from "../types";

function ctx(
  config: Record<string, unknown>,
  outputs: Record<string, Record<string, unknown>>,
  upstreamChains: string[][],
  logs: string[] = [],
): NodeContext {
  return { runId: "t", workflowId: "zz-test", nodeId: "m", input: {}, outputs, upstreamChains, config, secrets: {}, vars: {}, model: "", baseUrl: "", apiKey: "", headed: false, outputDir: "/tmp", debugDir: "/tmp", session: {} as never, cancelSignal: new AbortController().signal, log: (m: string) => logs.push(m), registerFile: () => {} } as NodeContext;
}

test("接起來:兩個分支各自的 rows 用分開層抓,不吃攤平後蓋前", async () => {
  const r = await mergeRowsNode.execute(ctx({ mode: "append" }, {
    branchA: { rows: [{ n: 1 }, { n: 2 }] },
    branchB: { rows: [{ n: 3 }] },
    other: { notRows: true },
  }, [["branchA"], ["branchB"], ["other"]]));
  assert.equal(r.output.rowCount, 3);
  assert.deepEqual(r.output.mergedFrom, ["branchA", "branchB"]);
});

test("來源只算直屬分支——中間步驟的清單絕不能一起被合進來", async () => {
  // 讀Excel(100 筆) → 篩選A(2 筆) ↘
  //                 → 篩選B(1 筆) ↗ 合併
  // 祖先集合裡有「讀Excel」，但它不是直屬分支：把它算成第三個來源，
  // 產出就會多出 100 筆未篩選的原始資料，而且整條流程全綠。
  const outputs = {
    讀Excel: { rows: [{ n: 1 }, { n: 2 }, { n: 3 }] },
    篩選A: { rows: [{ n: 1 }, { n: 2 }] },
    篩選B: { rows: [{ n: 3 }] },
  };
  const r = await mergeRowsNode.execute(ctx({ mode: "append" }, outputs, [["篩選A", "讀Excel"], ["篩選B", "讀Excel"]]));
  assert.deepEqual(r.output.mergedFrom, ["篩選A", "篩選B"]);
  assert.equal(r.output.rowCount, 3);
});

test("分支上有不產清單的步驟也接得起來:往上找最近一個真的有清單的", async () => {
  const r = await mergeRowsNode.execute(ctx({ mode: "append" }, {
    讀A: { rows: [{ n: 1 }] },
    等一下: { waited: true },
    讀B: { rows: [{ n: 2 }] },
  }, [["等一下", "讀A"], ["讀B"]]));
  assert.deepEqual(r.output.mergedFrom, ["讀A", "讀B"]);
  assert.equal(r.output.rowCount, 2);
});

test("兩條線最後匯到同一個來源=只算一次,不重複計入", async () => {
  const r = await mergeRowsNode.execute(ctx({ mode: "append" }, {
    讀A: { rows: [{ n: 1 }] },
    左: { passed: true },
    右: { passed: true },
  }, [["左", "讀A"], ["右", "讀A"]]));
  assert.deepEqual(r.output.mergedFrom, ["讀A"]);
  assert.equal(r.output.rowCount, 1);
});

test("只有一條分支提供清單:照做但要出聲提醒(合併兩份才是這個節點的用途)", async () => {
  const logs: string[] = [];
  const r = await mergeRowsNode.execute(ctx({ mode: "append" }, { 讀A: { rows: [{ n: 1 }] } }, [["讀A"]], logs));
  assert.equal(r.output.rowCount, 1);
  assert.ok(logs.some((l) => l.includes("只有一條分支")), "要提醒使用者另一條線可能沒接上");
});

test("依鍵合併:同鍵的欄位拼成一筆;缺鍵欄位要指名哪個上游並列實際欄位", async () => {
  const r = await mergeRowsNode.execute(ctx({ mode: "by-key", key: "email" }, {
    a: { rows: [{ email: "x@y.z", 名字: "小明" }] },
    b: { rows: [{ email: "x@y.z", 金額: 100 }, { email: "q@y.z", 金額: 5 }] },
  }, [["a"], ["b"]]));
  assert.equal(r.output.rowCount, 2);
  const merged = (r.output.rows as Record<string, unknown>[]).find((x) => x.email === "x@y.z")!;
  assert.equal(merged.名字, "小明");
  assert.equal(merged.金額, 100);
  await assert.rejects(
    () => mergeRowsNode.execute(ctx({ mode: "by-key", key: "沒這欄" }, { a: { rows: [{ email: "e" }] } }, [["a"]])),
    /實際欄位/,
  );
});

test("沒有任何直屬分支輸出清單=老實報錯教怎麼接", async () => {
  await assert.rejects(() => mergeRowsNode.execute(ctx({ mode: "append" }, {}, [])), /要接在/);
  // 祖先有清單、但沒有一條直屬分支帶得到它 → 一樣要報錯，不能默默去撈祖先
  await assert.rejects(
    () => mergeRowsNode.execute(ctx({ mode: "append" }, { 遠方: { rows: [{ n: 1 }] } }, [["別人"]])),
    /要接在/,
  );
});
