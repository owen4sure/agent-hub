import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "../db";
import { createWorkflow, deleteWorkflow, saveWorkflow } from "./store";
import { getPendingEffects, resolvePendingEffect } from "./engine";
import { markAttemptStarted } from "./idempotency";

test("不確定外部動作：使用者確認沒完成後，只清除 pending 並從原處續跑", async () => {
  const workflow = createWorkflow("effect-resolution-" + Date.now());
  const db = getDb();
  const runId = "effect-resolution-run-" + Date.now();
  try {
    saveWorkflow({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        { id: "send", type: "custom-code", label: "外部動作", config: { intent: "模擬後續動作", code: "return { ...ctx.input, resumed: true };" }, position: { x: 240, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "send" }],
    });
    db.prepare("INSERT INTO runs (id, workflow_id, status, trigger_type, headed, trigger_params_json, dry_run, failed_node, started_at) VALUES (?, ?, 'failed', 'manual', 0, '{}', 0, 'send', datetime('now'))").run(runId, workflow.id);
    db.prepare("INSERT INTO node_runs (run_id, node_id, status, input_json) VALUES (?, 'trigger', 'success', '{}')").run(runId);
    db.prepare("INSERT INTO node_runs (run_id, node_id, status, input_json, error) VALUES (?, 'send', 'failed', ?, '回應逾時')").run(runId, JSON.stringify({ order: "A-1" }));
    markAttemptStarted(`${runId}:send`);
    assert.deepEqual(getPendingEffects(runId).map((effect) => effect.nodeId), ["send"]);

    const result = resolvePendingEffect(runId, "send", "retry");
    assert.equal(result.ok, true);
    assert.deepEqual(getPendingEffects(runId), []);
    for (let i = 0; i < 100; i++) {
      const status = (db.prepare("SELECT status FROM runs WHERE id=?").get(runId) as { status: string }).status;
      if (["success", "failed", "stopped"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal((db.prepare("SELECT status FROM runs WHERE id=?").get(runId) as { status: string }).status, "success");
  } finally {
    db.prepare("DELETE FROM idempotent_actions WHERE key=?").run(`${runId}:send`);
    db.prepare("DELETE FROM node_runs WHERE run_id=?").run(runId);
    db.prepare("DELETE FROM runs WHERE id=?").run(runId);
    deleteWorkflow(workflow.id);
  }
});
