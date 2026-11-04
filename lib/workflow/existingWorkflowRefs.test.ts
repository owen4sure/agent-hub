import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflow, deleteWorkflow, saveWorkflow } from "./store";
import { startWorkflowRun, getRun } from "./engine";
import { existingWorkflowRefsSection } from "./existingWorkflowRefs";
import type { WorkflowNode, WorkflowEdge } from "./types";

/**
 * 使用者實測發現的落差：跟 builder 說「跑一次『某條既有流程』」時，它完全看不到那條流程實際
 * 長什麼樣、輸出什麼欄位，只能把名字塞進 run-workflow 的 target，下游欄位只能用猜的。這裡驗證
 * existingWorkflowRefsSection 真的能從使用者訊息裡認出提到的既有流程，並且真的執行過的流程
 * 要餵回真實輸出欄位(不是憑空編的欄位名)，沒執行過的要老實說「不知道」而不是假裝有答案。
 */

async function waitForStatus(runId: string, statuses: string[], timeoutMs = 15_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const result = getRun(runId) as { run?: { status: string } };
    if (result.run && statuses.includes(result.run.status)) return result.run.status;
    if (Date.now() - start > timeoutMs) throw new Error(`等 run ${runId} 進入 ${statuses.join("/")} 逾時`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("existingWorkflowRefsSection：訊息裡完全沒提到任何既有流程名稱時回空字串", () => {
  const wf = createWorkflow(`test-refs-noise-${Date.now()}`);
  try {
    saveWorkflow({ ...wf, status: "official", nodes: [{ id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] });
    assert.equal(existingWorkflowRefsSection("跑台積電股價通知我"), "");
  } finally {
    deleteWorkflow(wf.id);
  }
});

test("existingWorkflowRefsSection：從沒成功執行過的流程要老實說「不知道輸出欄位」，不能假裝有答案", () => {
  const wf = createWorkflow(`test-refs-neverrun-${Date.now()}`);
  try {
    saveWorkflow({
      ...wf, status: "official",
      nodes: [
        { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "c", type: "custom-code", label: "算東西", config: { intent: "test", code: "return { ...ctx.input, x: 1 };" }, position: { x: 300, y: 0 } },
      ],
      edges: [{ from: "t", to: "c" }],
    });
    const section = existingWorkflowRefsSection(`跑一次「${wf.name}」`);
    assert.match(section, new RegExp(wf.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(section, /還沒有成功執行過/, "沒跑過就要老實說不知道，不能編欄位名稱");
    assert.match(section, /不要憑空編/);
  } finally {
    deleteWorkflow(wf.id);
  }
});

test("existingWorkflowRefsSection：真的成功執行過的流程要帶出真實輸出欄位名稱，不是憑空猜的", async () => {
  const wf = createWorkflow(`test-refs-hasrun-${Date.now()}`);
  try {
    const nodes: WorkflowNode[] = [
      { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
      { id: "c", type: "custom-code", label: "算報表標題", config: { intent: "test", code: "return { ...ctx.input, reportTitle: '【真實欄位】週報' };" }, position: { x: 300, y: 0 } },
    ];
    const edges: WorkflowEdge[] = [{ from: "t", to: "c" }];
    saveWorkflow({ ...wf, status: "official", nodes, edges });

    const runId = startWorkflowRun(wf.id, {}, { trigger: "manual" });
    const status = await waitForStatus(runId, ["success", "failed"]);
    assert.equal(status, "success", "測試用的流程本身要能順利跑成功，這樣才有『真的執行過』的資料可以驗證");

    const section = existingWorkflowRefsSection(`跑一次「${wf.name}」，再把結果拿去用`);
    assert.match(section, /reportTitle=【真實欄位】週報/, "要帶出真實跑出來的欄位名稱與值，不是隨便編一個看起來合理的欄位名");
  } finally {
    deleteWorkflow(wf.id);
  }
});

test("existingWorkflowRefsSection：excludeWorkflowId 要真的把自己排除掉，不然編輯中的流程會拿自己的名字當參考", () => {
  const wf = createWorkflow(`test-refs-exclude-self-${Date.now()}`);
  try {
    saveWorkflow({ ...wf, status: "official", nodes: [{ id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] });
    const section = existingWorkflowRefsSection(`跑一次「${wf.name}」`, wf.id);
    assert.equal(section, "", "被排除的流程不該出現在參考區塊裡");
  } finally {
    deleteWorkflow(wf.id);
  }
});
