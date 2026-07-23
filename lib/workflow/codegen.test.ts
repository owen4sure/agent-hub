import assert from "node:assert/strict";
import test from "node:test";
import { generateCustomCode } from "./codegen";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";
import type { NodeContext } from "./types";

const explicitDailyIntent = `讀日報 Excel 的每日明細與通路累計摘要。
日期在A欄。
- C通路：台幣客戶數 BZ欄 + 外幣客戶數 BK欄
- D通路：台幣客戶數 CM欄 + 外幣客戶數 BW欄
從『通路結算及占比』分頁讀取餘額。`;

test("custom-code 產碼：明確日報規格直接編譯並存回節點，不受 store/registry 循環相依影響", async () => {
  const workflow = createWorkflow("codegen isolated test");
  const node = {
    id: "metrics",
    type: "custom-code",
    label: "計算日報",
    config: { intent: explicitDailyIntent, code: "" },
    position: { x: 300, y: 0 },
  };
  saveWorkflow({ ...workflow, nodes: [...workflow.nodes, node], edges: [{ from: "trigger", to: node.id }] });
  const logs: string[] = [];
  try {
    const ctx = {
      runId: "codegen-test-run",
      workflowId: workflow.id,
      nodeId: node.id,
      input: {},
      config: node.config,
      secrets: {},
      vars: {},
      model: "model-that-must-not-be-called",
      baseUrl: "http://unused",
      apiKey: "unused",
      headed: false,
      outputDir: "/tmp",
      debugDir: "/tmp",
      session: {} as never,
      cancelSignal: new AbortController().signal,
      log: (line: string) => logs.push(line),
      registerFile: () => {},
    } satisfies NodeContext;
    const code = await generateCustomCode(ctx, explicitDailyIntent);
    assert.match(code, /const ExcelJS/);
    assert.match(code, /findCumulativeColumn/);
    assert.ok(logs.some((line) => line.includes("直接建立可驗證的計算程式碼")));
    assert.equal(getWorkflow(workflow.id)?.nodes.find((item) => item.id === node.id)?.config.code, code);
  } finally {
    deleteWorkflow(workflow.id);
  }
});
