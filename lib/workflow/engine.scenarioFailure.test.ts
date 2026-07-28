import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflow, deleteWorkflow, saveWorkflow } from "./store";
import { getRun, startWorkflowRun } from "./engine";
import type { WorkflowEdge, WorkflowNode } from "./types";

interface RunRow { status: string; reason: string | null }
interface NodeRunRow { node_id: string; status: string; active_ports: string | null }

async function waitForTerminal(runId: string): Promise<{ run: RunRow; nodeRuns: NodeRunRow[] }> {
  for (let i = 0; i < 100; i += 1) {
    const result = getRun(runId) as { run?: RunRow; nodeRuns: NodeRunRow[] };
    if (result.run && ["success", "failed", "stopped"].includes(result.run.status)) return result as { run: RunRow; nodeRuns: NodeRunRow[] };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("情境故障試跑沒有在期限內完成");
}

test("情境故障試跑：只讀故意失敗指定步驟，真的走 error 備援且正常路徑不執行", async () => {
  const workflow = createWorkflow("scenario-failure-" + Date.now());
  const nodes: WorkflowNode[] = [
    { id: "target", type: "template-text", label: "要驗證的步驟", config: { template: "正常結果" }, position: { x: 200, y: 0 } },
    { id: "normal", type: "template-text", label: "正常路徑", config: { template: "不應執行" }, position: { x: 450, y: -80 } },
    { id: "fallback", type: "template-text", label: "備援路徑", config: { template: "已接手" }, position: { x: 450, y: 80 } },
  ];
  const edges: WorkflowEdge[] = [
    { from: "trigger", to: "target" },
    { from: "target", to: "normal" },
    { from: "target", to: "fallback", fromPort: "error" },
  ];
  try {
    saveWorkflow({ ...workflow, nodes: [...workflow.nodes, ...nodes], edges });
    const runId = startWorkflowRun(workflow.id, {}, { trigger: "manual", dryRun: true, scenarioForcedFailures: { target: "scenario" } });
    const result = await waitForTerminal(runId);
    assert.equal(result.run.status, "success");
    const target = result.nodeRuns.find((row) => row.node_id === "target");
    const normal = result.nodeRuns.find((row) => row.node_id === "normal");
    const fallback = result.nodeRuns.find((row) => row.node_id === "fallback");
    assert.equal(target?.status, "failed");
    assert.equal(target?.active_ports, '["error"]');
    assert.equal(normal?.status, "skipped");
    assert.equal(fallback?.status, "success");
    assert.match(result.run.reason ?? "", /故意模擬|Plan B|備援/);
  } finally {
    deleteWorkflow(workflow.id);
  }
});
