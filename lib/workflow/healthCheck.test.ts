import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "../db";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";
import { workflowExecutionFingerprint } from "./fingerprint";
import { createScenarioFromRun } from "./scenarioTests";
import { getHealthCheckView, normalizeHealthCheckInterval, startHealthCheck, sweepHealthChecks, updateHealthCheck } from "./healthCheck";
import { getAutomationReadiness } from "./automationReadiness";

test("健康巡檢頻率只接受白話選項，避免前端注入任意排程", () => {
  assert.equal(normalizeHealthCheckInterval(15), 15);
  assert.equal(normalizeHealthCheckInterval("60"), 60);
  assert.equal(normalizeHealthCheckInterval(17), null);
  assert.equal(normalizeHealthCheckInterval("0"), null);
});

test("健康巡檢設定會綁目前版本與已保存情境，沒有正確基準不能啟用", () => {
  const workflow = createWorkflow("health-check-test-" + Date.now());
  const db = getDb();
  const runId = "health-check-run-" + Date.now();
  try {
    const official = { ...workflow, status: "official" as const };
    saveWorkflow(official);
    const fingerprint = workflowExecutionFingerprint(official);
    assert.throws(() => updateHealthCheck(workflow.id, true, 60), /至少一個成功情境/);
    db.prepare("INSERT INTO runs (id, workflow_id, status, trigger_params_json, graph_fingerprint, started_at) VALUES (?, ?, 'success', ?, ?, ?)").run(runId, workflow.id, "{}", fingerprint, "2026-07-28 04:00:00");
    db.prepare("INSERT INTO node_runs (run_id, node_id, status, output_json) VALUES (?, 'trigger', 'success', ?)").run(runId, JSON.stringify({ ok: true }));
    const scenario = createScenarioFromRun(workflow.id, runId, "基準情境");
    const first = updateHealthCheck(workflow.id, false, "60");
    assert.equal(first.enabled, false);
    assert.equal(first.currentScenarioCount, 1);
    const enabled = updateHealthCheck(workflow.id, true, 60);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.intervalMinutes, 60);
    assert.equal(enabled.lastStatus, null);
    assert.ok(enabled.currentGraphFingerprint);
    assert.equal(getHealthCheckView(workflow.id).currentScenarioCount, 1);
    db.prepare("UPDATE workflow_health_checks SET last_status='failed' WHERE workflow_id=?").run(workflow.id);
    assert.equal(getAutomationReadiness(getWorkflow(workflow.id)!).items.some((item) => item.code === "health-check"), true);
    assert.equal(scenario.name, "基準情境");
  } finally {
    db.prepare("DELETE FROM node_runs WHERE run_id=?").run(runId);
    db.prepare("DELETE FROM runs WHERE id=?").run(runId);
    deleteWorkflow(workflow.id);
  }
});

test("健康巡檢會真的重播 dry-run，完成後保存通過結果", async () => {
  const workflow = createWorkflow("health-check-replay-" + Date.now());
  const db = getDb();
  const baseRunId = "health-check-base-" + Date.now();
  try {
    const official = {
      ...workflow,
      status: "official" as const,
      nodes: [...workflow.nodes, { id: "out", type: "template-text", label: "輸出", config: { template: "ok", outputKey: "result" }, position: { x: 200, y: 160 } }],
      edges: [{ from: "trigger", to: "out" }],
    };
    saveWorkflow(official);
    const fingerprint = workflowExecutionFingerprint(official);
    db.prepare("INSERT INTO runs (id, workflow_id, status, trigger_params_json, graph_fingerprint, started_at) VALUES (?, ?, 'success', ?, ?, ?)").run(baseRunId, workflow.id, "{}", fingerprint, "2026-07-28 04:10:00");
    db.prepare("INSERT INTO node_runs (run_id, node_id, status, output_json) VALUES (?, 'trigger', 'success', ?), (?, 'out', 'success', ?)").run(baseRunId, JSON.stringify({}), baseRunId, JSON.stringify({ result: "ok" }));
    const scenario = createScenarioFromRun(workflow.id, baseRunId, "可重播基準");
    const started = startHealthCheck(workflow.id);
    assert.equal(started.runIds.length, 1);
    let view = getHealthCheckView(workflow.id);
    for (let i = 0; i < 50 && view.activeBatchId; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = getHealthCheckView(workflow.id);
    }
    assert.equal(view.lastStatus, "passed");
    assert.equal(view.items.find((item) => item.scenarioId === scenario.id)?.matched, true);
    assert.equal((db.prepare("SELECT dry_run, trigger_type FROM runs WHERE id=?").get(started.runIds[0]) as { dry_run: number; trigger_type: string }).dry_run, 1);
    assert.equal((db.prepare("SELECT trigger_type FROM runs WHERE id=?").get(started.runIds[0]) as { trigger_type: string }).trigger_type, "health-check");
    updateHealthCheck(workflow.id, true, 15);
    db.prepare("UPDATE workflow_health_checks SET next_run_at='2000-01-01 00:00:00' WHERE workflow_id=?").run(workflow.id);
    sweepHealthChecks();
    view = getHealthCheckView(workflow.id);
    for (let i = 0; i < 50 && view.activeBatchId; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = getHealthCheckView(workflow.id);
    }
    assert.equal(view.lastStatus, "passed");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE workflow_id=? AND trigger_type='health-check'").get(workflow.id) as { n: number }).n, 2);
  } finally {
    db.prepare("DELETE FROM node_runs WHERE run_id=?").run(baseRunId);
    db.prepare("DELETE FROM runs WHERE id=?").run(baseRunId);
    deleteWorkflow(workflow.id);
  }
});
