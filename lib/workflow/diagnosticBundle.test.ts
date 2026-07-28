import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "../db";
import { deleteSharedSecrets, setSharedSecrets } from "../settingsStore";
import { createWorkflow, deleteWorkflow } from "./store";
import { buildDiagnosticBundle } from "./diagnosticBundle";

test("安全診斷包只保留形狀與錯誤線索，不帶原始輸入、輸出或秘密", () => {
  const workflow = createWorkflow("diagnostic-bundle-" + Date.now());
  const runId = "diagnostic-run-" + Date.now();
  const secretKey = "DIAGNOSTIC_TEST_SECRET";
  const secret = "diagnostic-secret-value-123";
  const db = getDb();
  try {
    setSharedSecrets({ [secretKey]: secret });
    db.prepare(`INSERT INTO runs (id, workflow_id, status, trigger_type, trigger_params_json, reason, error, failed_node, started_at, finished_at, graph_fingerprint) VALUES (?, ?, 'failed', 'manual', ?, ?, ?, ?, ?, ?, ?)`).run(
      runId, workflow.id, JSON.stringify({ email: "person@example.com", password: secret }), `網址含 ${secret}`, `Bearer ${secret}`, "trigger", "2026-07-28 01:00:00", "2026-07-28 01:00:02", "fingerprint",
    );
    db.prepare(`INSERT INTO node_runs (run_id, node_id, status, attempt, started_at, finished_at, output_json, error) VALUES (?, ?, 'failed', 2, ?, ?, ?, ?)`).run(
      runId, "trigger", "2026-07-28 01:00:00", "2026-07-28 01:00:02", JSON.stringify({ secret, customer: "raw customer" }), `登入失敗 ${secret}`,
    );
    db.prepare(`INSERT INTO run_logs (run_id, node_id, ts, line) VALUES (?, ?, ?, ?)`).run(runId, "trigger", "2026-07-28 01:00:01", `log ${secret}`);

    const bundle = buildDiagnosticBundle(runId);
    assert.ok(bundle);
    const serialized = JSON.stringify(bundle);
    assert.doesNotMatch(serialized, /diagnostic-secret-value-123/);
    assert.doesNotMatch(serialized, /raw customer/);
    assert.doesNotMatch(serialized, /person@example.com/);
    assert.deepEqual(bundle.run.inputShape.keys, ["email", "password"]);
    assert.equal(bundle.trace[0]?.outputShape.count, 2);
    assert.equal(bundle.trace[0]?.attempt, 2);
    assert.equal(bundle.privacy.rawInputs, false);
  } finally {
    deleteSharedSecrets([secretKey]);
    db.prepare("DELETE FROM run_logs WHERE run_id=?").run(runId);
    db.prepare("DELETE FROM node_runs WHERE run_id=?").run(runId);
    db.prepare("DELETE FROM runs WHERE id=?").run(runId);
    deleteWorkflow(workflow.id);
  }
});
