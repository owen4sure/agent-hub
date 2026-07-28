import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "../db";
import { createWorkflow, deleteWorkflow } from "./store";
import { buildRunReceipt } from "./runReceipt";

test("summarizes outputs without exposing raw values and compares the previous success", () => {
    const workflow = createWorkflow("receipt-test-" + Date.now());
    const db = getDb();
    const previousId = "receipt-prev-" + Date.now();
    const currentId = previousId + "-current";
    try {
      const insertRun = db.prepare("INSERT INTO runs (id, workflow_id, status, started_at, graph_fingerprint) VALUES (?, ?, 'success', ?, ?)");
      insertRun.run(previousId, workflow.id, "2026-07-28T01:00:00.000Z", "old");
      insertRun.run(currentId, workflow.id, "2026-07-28T02:00:00.000Z", "new");
      const insertNode = db.prepare("INSERT INTO node_runs (run_id, node_id, status, output_json) VALUES (?, ?, 'success', ?)");
      insertNode.run(previousId, "n1", JSON.stringify({ rows: [1], secret: "previous-secret" }));
      insertNode.run(currentId, "n1", JSON.stringify({ rows: [1, 2, 3], secret: "current-secret" }));

      const receipt = buildRunReceipt(currentId);
      assert.ok(receipt);
      assert.doesNotMatch(JSON.stringify(receipt), /current-secret/);
      assert.equal(receipt.nodes[0]?.fields.find((field) => field.name === "rows")?.detail, "共有 3 筆");
      assert.equal(receipt.comparedTo?.runId, previousId);
      assert.equal(receipt.changes.some((change) => change.field === "rows"), true);
    } finally {
      db.prepare("DELETE FROM node_runs WHERE run_id IN (?, ?)").run(previousId, currentId);
      db.prepare("DELETE FROM runs WHERE id IN (?, ?)").run(previousId, currentId);
      deleteWorkflow(workflow.id);
    }
});
