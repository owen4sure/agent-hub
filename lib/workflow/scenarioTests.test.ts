import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "../db";
import { createWorkflow, deleteWorkflow, saveWorkflow } from "./store";
import { createScenarioFromRun, exportPortableScenarios, getScenarioRepairContext, getScenarioSuiteState, importPortableScenarios, listScenarios, scenarioApprovalDecisions, scenarioForcedFailures, scenarioResult } from "./scenarioTests";

test("情境測試保存加密輸入、綁定版本並核對欄位與分支", () => {
  const workflow = createWorkflow("scenario-test-" + Date.now());
  const db = getDb();
  const runId = "scenario-run-" + Date.now();
  try {
    saveWorkflow({ ...workflow, nodes: [...workflow.nodes, { id: "approval", type: "wait-approval", label: "核准", config: { message: "准嗎", channels: "desktop" }, position: { x: 200, y: 0 } }] });
    db.prepare("INSERT INTO runs (id, workflow_id, status, trigger_params_json, graph_fingerprint, started_at) VALUES (?, ?, 'success', ?, ?, ?)").run(runId, workflow.id, JSON.stringify({ amount: 120, password: "do-not-show" }), "", "2026-07-28 03:00:00");
    db.prepare("INSERT INTO node_runs (run_id, node_id, status, output_json, active_ports) VALUES (?, 'trigger', 'success', ?, ?)").run(runId, JSON.stringify({ rows: [1, 2] }), JSON.stringify(["approved"]));
    const scenario = createScenarioFromRun(workflow.id, runId, "金額核准", { approval: "rejected" });
    const rows = db.prepare("SELECT params_json, expected_json, controls_json FROM workflow_scenarios WHERE id=?").get(scenario.id) as { params_json: string; expected_json: string; controls_json: string };
    assert.notEqual(rows.params_json, JSON.stringify({ amount: 120, password: "do-not-show" }));
    assert.match(rows.expected_json, /approved/);
    assert.deepEqual(JSON.parse(rows.controls_json), { approvalDecisions: { approval: "rejected" }, forcedFailures: [] });
    assert.deepEqual(scenarioApprovalDecisions(db.prepare("SELECT * FROM workflow_scenarios WHERE id=?").get(scenario.id) as never), { approval: "rejected" });
    assert.deepEqual(scenarioForcedFailures(db.prepare("SELECT * FROM workflow_scenarios WHERE id=?").get(scenario.id) as never), []);
    assert.equal(listScenarios(workflow.id)[0]?.matchesCurrentGraph, true);
    assert.deepEqual(getScenarioSuiteState(workflow.id), { total: 1, passed: 1, failed: 0, pending: 0, stale: 0, allPassed: true });
    const result = scenarioResult(workflow.id, db.prepare("SELECT * FROM workflow_scenarios WHERE id=?").get(scenario.id) as never, runId);
    assert.equal(result.matched, true);
    assert.equal(JSON.stringify(result), JSON.stringify(result).replace("do-not-show", ""));
    const passport = exportPortableScenarios(workflow.id);
    assert.equal(passport.length, 1);
    assert.deepEqual(passport[0]?.params, { amount: 120, password: "do-not-show" });
    assert.equal(importPortableScenarios(workflow.id, passport).imported, 1);
    assert.equal(listScenarios(workflow.id).length, 2);
    db.prepare("DELETE FROM workflow_scenarios WHERE workflow_id=? AND id<>?").run(workflow.id, scenario.id);
    assert.equal(importPortableScenarios(workflow.id, [{ ...passport[0], graphFingerprint: "stale-version" }]).skipped, 1);
    db.prepare("UPDATE workflow_scenarios SET expected_json=? WHERE id=?").run(JSON.stringify({ nodes: [{ nodeId: "trigger", fields: [{ name: "missingField", kind: "text" }], ports: [] }] }), scenario.id);
    assert.deepEqual(getScenarioSuiteState(workflow.id), { total: 1, passed: 0, failed: 1, pending: 0, stale: 0, allPassed: false });
    assert.equal(listScenarios(workflow.id)[0]?.lastFailedNode, "trigger");
    assert.equal(getScenarioRepairContext(workflow.id, db.prepare("SELECT * FROM workflow_scenarios WHERE id=?").get(scenario.id) as never, runId)?.mismatches[0], "步驟「開始」少了欄位「missingField」");
    saveWorkflow({ ...workflow, nodes: [...workflow.nodes, { id: "later", type: "template-text", label: "後來新增", config: { template: "x" }, position: { x: 0, y: 0 } }] });
    assert.equal(listScenarios(workflow.id)[0]?.matchesCurrentGraph, false);
    deleteWorkflow(workflow.id);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM workflow_scenarios WHERE workflow_id=?").get(workflow.id) as { n: number }).n, 0);
  } finally {
    db.prepare("DELETE FROM node_runs WHERE run_id=?").run(runId);
    db.prepare("DELETE FROM runs WHERE id=?").run(runId);
    db.prepare("DELETE FROM workflow_scenarios WHERE workflow_id=?").run(workflow.id);
    deleteWorkflow(workflow.id);
  }
});
