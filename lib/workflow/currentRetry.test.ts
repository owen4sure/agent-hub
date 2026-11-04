import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "../db";
import { encryptSecret } from "../secretVault";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";
import { retryRunWithCurrentWorkflow } from "./engine";
import { workflowExecutionFingerprint } from "./fingerprint";

test("目前版本重試：保留輸入但不攜帶舊版輸出與一次性覆寫", async () => {
  const workflow = createWorkflow("current-retry-" + Date.now());
  const db = getDb();
  const sourceRunId = "current-retry-source-" + Date.now();
  let nextRunId: string | null = null;
  try {
    saveWorkflow({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        { id: "calc", type: "custom-code", label: "計算", config: { intent: "把輸入保留並完成計算", code: "return { ...ctx.input, retried: true };" }, position: { x: 240, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "calc" }],
    });
    db.prepare("INSERT INTO runs (id, workflow_id, status, trigger_type, headed, trigger_params_json, secret_overrides_json, node_config_overrides_json, dry_run, graph_fingerprint, started_at) VALUES (?, ?, 'failed', 'manual', 0, ?, ?, ?, 0, ?, datetime('now'))").run(
      sourceRunId, workflow.id, JSON.stringify({ amount: 42 }), encryptSecret(JSON.stringify({ ONE_TIME: "never-copy" })), JSON.stringify({ calc: { temporary: true } }), workflowExecutionFingerprint(workflow),
    );
    const currentFingerprint = workflowExecutionFingerprint(getWorkflow(workflow.id)!);
    const result = retryRunWithCurrentWorkflow(sourceRunId);
    assert.equal(result.ok, true);
    assert.ok(result.runId);
    nextRunId = result.runId!;
    const next = db.prepare("SELECT trigger_type, trigger_params_json, secret_overrides_json, node_config_overrides_json, graph_fingerprint FROM runs WHERE id=?").get(nextRunId) as Record<string, unknown>;
    assert.equal(next.trigger_type, "retry");
    assert.deepEqual(JSON.parse(String(next.trigger_params_json)), { amount: 42 });
    assert.equal(next.secret_overrides_json, null);
    assert.equal(next.node_config_overrides_json, null);
    assert.equal(next.graph_fingerprint, currentFingerprint);
    for (let i = 0; i < 50; i++) {
      const status = (db.prepare("SELECT status FROM runs WHERE id=?").get(nextRunId) as { status: string }).status;
      if (["success", "failed", "stopped"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    if (nextRunId) db.prepare("DELETE FROM node_runs WHERE run_id IN (?, ?)").run(sourceRunId, nextRunId);
    db.prepare("DELETE FROM runs WHERE id=? OR workflow_id=?").run(sourceRunId, workflow.id);
    deleteWorkflow(workflow.id);
  }
});
