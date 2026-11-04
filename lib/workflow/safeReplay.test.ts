import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "../db";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";
import { replayFailedNodeSafely } from "./engine";
import { workflowExecutionFingerprint } from "./fingerprint";

test("安全重播只重跑失敗節點並凍結當下 input", async () => {
  const workflow = createWorkflow("safe-replay-" + Date.now());
  const db = getDb();
  const sourceRunId = "safe-replay-source-" + Date.now();
  let replayRunId: string | null = null;
  try {
    saveWorkflow({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        { id: "failed", type: "custom-code", label: "失敗步驟", config: { intent: "重播測試", code: "return { ...ctx.input, replayed: true };" }, position: { x: 240, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "failed" }],
    });
    const current = getWorkflow(workflow.id)!;
    const fingerprint = workflowExecutionFingerprint(current);
    db.prepare("INSERT INTO runs (id, workflow_id, status, trigger_type, headed, trigger_params_json, dry_run, graph_fingerprint, failed_node, started_at) VALUES (?, ?, 'failed', 'manual', 0, '{}', 0, ?, 'failed', datetime('now'))").run(
      sourceRunId, workflow.id, fingerprint,
    );
    db.prepare("INSERT INTO node_runs (run_id, node_id, status, input_json, error) VALUES (?, 'trigger', 'success', '{}', NULL)").run(sourceRunId);
    db.prepare("INSERT INTO node_runs (run_id, node_id, status, input_json, error) VALUES (?, 'failed', 'failed', ?, '刻意失敗')").run(
      sourceRunId, JSON.stringify({ customer: "小明", privateToken: "must-stay-local" }),
    );

    const result = replayFailedNodeSafely(sourceRunId);
    assert.equal(result.ok, true);
    assert.ok(result.runId);
    replayRunId = result.runId!;
    const created = db.prepare("SELECT trigger_type, dry_run, trigger_params_json FROM runs WHERE id=?").get(replayRunId) as { trigger_type: string; dry_run: number; trigger_params_json: string };
    assert.equal(created.trigger_type, "replay");
    assert.equal(created.dry_run, 1);
    assert.deepEqual(JSON.parse(created.trigger_params_json), {});

    for (let i = 0; i < 100; i++) {
      const status = (db.prepare("SELECT status FROM runs WHERE id=?").get(replayRunId) as { status: string }).status;
      if (["success", "failed", "stopped"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const replayInput = db.prepare("SELECT input_json, output_json, status FROM node_runs WHERE run_id=? AND node_id='failed'").get(replayRunId) as { input_json: string; output_json: string | null; status: string };
    assert.deepEqual(JSON.parse(replayInput.input_json), { customer: "小明", privateToken: "must-stay-local" });
    assert.match(String(replayInput.output_json), /replayed/);
    assert.equal((db.prepare("SELECT status FROM node_runs WHERE run_id=? AND node_id='trigger'").get(replayRunId) as { status: string }).status, "skipped");
  } finally {
    if (replayRunId) db.prepare("DELETE FROM node_runs WHERE run_id=?").run(replayRunId);
    db.prepare("DELETE FROM node_runs WHERE run_id=?").run(sourceRunId);
    db.prepare("DELETE FROM runs WHERE id=? OR workflow_id=?").run(sourceRunId, workflow.id);
    deleteWorkflow(workflow.id);
  }
});
