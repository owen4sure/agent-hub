import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { decryptSecret, encryptSecret } from "../secretVault";
import { getWorkflow } from "./store";
import { workflowExecutionFingerprint } from "./fingerprint";
import type { RunReceipt } from "./runReceipt";
import { buildRunReceipt } from "./runReceipt";
import { startWorkflowRun } from "./engine";

export interface ScenarioSummary {
  id: string;
  workflowId: string;
  name: string;
  graphFingerprint: string;
  createdAt: string;
  updatedAt: string;
  matchesCurrentGraph: boolean;
  lastRunId: string | null;
  lastRunStatus: string | null;
  lastMatched: boolean | null;
  lastMismatches: string[];
  lastFailedNode: string | null;
  approvalDecisions: Record<string, "approved" | "rejected">;
  forcedFailures: string[];
}

export interface ScenarioSuiteState {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  stale: number;
  allPassed: boolean;
}

export interface ScenarioSuiteRunResult {
  runIds: string[];
  skippedStale: string[];
  errors: { scenarioId: string; error: string }[];
}

export interface ScenarioExpectedNode {
  nodeId: string;
  fields: { name: string; kind: string }[];
  ports: string[];
}

export interface ScenarioExpected {
  nodes: ScenarioExpectedNode[];
}

export interface ScenarioRunResult {
  scenario: ScenarioSummary;
  complete: boolean;
  runId: string;
  status: string;
  matched: boolean | null;
  mismatches: string[];
  receipt: RunReceipt | null;
}

export interface ScenarioRepairContext {
  repairNodeId: string | null;
  mismatches: string[];
  status: string;
}

export interface PortableScenario {
  name: string;
  graphFingerprint: string;
  params: Record<string, unknown>;
  expected: ScenarioExpected;
  controls: { approvalDecisions: Record<string, "approved" | "rejected">; forcedFailures: string[] };
}

type ScenarioRow = {
  id: string;
  workflow_id: string;
  name: string;
  graph_fingerprint: string;
  params_json: string;
  expected_json: string;
  created_at: string;
  updated_at: string;
  controls_json: string | null;
};

type LatestRun = { id: string; status: string; failed_node: string | null };

function latestRunForScenario(row: ScenarioRow): LatestRun | null {
  return getDb().prepare("SELECT id, status, failed_node FROM runs WHERE scenario_id=? AND workflow_id=? ORDER BY started_at DESC LIMIT 1").get(row.id, row.workflow_id) as LatestRun | null;
}

function parseApprovalDecisions(raw: string | null | undefined): Record<string, "approved" | "rejected"> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key, decision]) =>
      /^[A-Za-z0-9_-]{1,80}$/.test(key) && (decision === "approved" || decision === "rejected"),
    )) as Record<string, "approved" | "rejected">;
  } catch { return {}; }
}

export function scenarioApprovalDecisions(row: ScenarioRow): Record<string, "approved" | "rejected"> {
  const raw = row.controls_json;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "approvalDecisions" in parsed) {
      return parseApprovalDecisions(JSON.stringify((parsed as { approvalDecisions?: unknown }).approvalDecisions));
    }
  } catch { /* 舊資料解析失敗時交給既有 parser 回空 */ }
  return parseApprovalDecisions(raw);
}

export function scenarioForcedFailures(row: ScenarioRow): string[] {
  if (!row.controls_json) return [];
  try {
    const parsed = JSON.parse(row.controls_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const value = (parsed as { forcedFailures?: unknown }).forcedFailures;
    return Array.isArray(value) ? value.filter((nodeId): nodeId is string => typeof nodeId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(nodeId)).slice(0, 20) : [];
  } catch { return []; }
}

function normalizeApprovalDecisions(workflow: ReturnType<typeof getWorkflow>, value: unknown): Record<string, "approved" | "rejected"> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("簽核分支選擇格式不正確");
  const approvalIds = new Set((workflow?.nodes ?? []).filter((node) => node.type === "wait-approval").map((node) => node.id));
  const output: Record<string, "approved" | "rejected"> = {};
  for (const [nodeId, decision] of Object.entries(value as Record<string, unknown>)) {
    if (!approvalIds.has(nodeId)) throw new Error(`找不到可指定的簽核節點「${nodeId}」`);
    if (decision !== "approved" && decision !== "rejected") throw new Error(`簽核節點「${nodeId}」只能選核准或拒絕`);
    output[nodeId] = decision;
  }
  return output;
}

function normalizeForcedFailures(workflow: ReturnType<typeof getWorkflow>, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("故障情境節點格式不正確");
  const nodeMap = new Map((workflow?.nodes ?? []).map((node) => [node.id, node]));
  const errorNodes = new Set((workflow?.edges ?? []).filter((edge) => edge.fromPort === "error").map((edge) => edge.from));
  const result: string[] = [];
  for (const nodeId of value.slice(0, 20)) {
    if (typeof nodeId !== "string" || !nodeMap.has(nodeId)) throw new Error(`找不到要模擬失敗的步驟「${String(nodeId)}」`);
    if (!errorNodes.has(nodeId)) throw new Error(`步驟「${nodeMap.get(nodeId)?.label ?? nodeId}」沒有接「出錯時」備援路徑`);
    if (!result.includes(nodeId)) result.push(nodeId);
  }
  return result;
}

function rowToSummary(row: ScenarioRow, currentFingerprint: string | null, latest: LatestRun | null = latestRunForScenario(row)): ScenarioSummary {
  let matched: boolean | null = null;
  let mismatches: string[] = [];
  let repairNodeId = latest?.failed_node ?? null;
  if (latest && ["success", "failed", "stopped"].includes(latest.status)) {
    if (latest.status === "success") {
      const receipt = buildRunReceipt(latest.id);
      if (receipt) {
        const expected = parseExpected(row.expected_json);
        mismatches = compareExpected(expected, receipt);
        repairNodeId = mismatches.length > 0 ? firstMismatchNodeId(expected, receipt) : null;
      }
    }
    matched = latest.status === "success" && mismatches.length === 0;
  }
  return {
    id: row.id,
    workflowId: row.workflow_id,
    name: row.name,
    graphFingerprint: row.graph_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    matchesCurrentGraph: currentFingerprint === row.graph_fingerprint,
    lastRunId: latest?.id ?? null,
    lastRunStatus: latest?.status ?? null,
    lastMatched: matched,
    lastMismatches: mismatches.slice(0, 8),
    lastFailedNode: repairNodeId,
    approvalDecisions: scenarioApprovalDecisions(row),
    forcedFailures: scenarioForcedFailures(row),
  };
}

function safeName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) return "未命名情境";
  return name.trim().slice(0, 120);
}

function parseExpected(raw: string): ScenarioExpected {
  try {
    const parsed = JSON.parse(raw) as ScenarioExpected;
    if (!parsed || !Array.isArray(parsed.nodes)) return { nodes: [] };
    return { nodes: parsed.nodes.slice(0, 200).map((node) => ({
      nodeId: typeof node.nodeId === "string" ? node.nodeId : "",
      fields: Array.isArray(node.fields) ? node.fields.filter((field) => field && typeof field.name === "string" && typeof field.kind === "string").slice(0, 80) : [],
      ports: Array.isArray(node.ports) ? node.ports.filter((port): port is string => typeof port === "string").slice(0, 20) : [],
    })) };
  } catch {
    return { nodes: [] };
  }
}

function expectedFromReceipt(receipt: RunReceipt): ScenarioExpected {
  return {
    nodes: receipt.nodes.map((node) => ({
      nodeId: node.nodeId,
      fields: node.fields.map((field) => ({ name: field.name, kind: field.kind })),
      ports: [...node.ports].sort(),
    })),
  };
}

function compareExpected(expected: ScenarioExpected, receipt: RunReceipt): string[] {
  const actual = new Map(receipt.nodes.map((node) => [node.nodeId, node]));
  const mismatches: string[] = [];
  for (const expectedNode of expected.nodes) {
    const node = actual.get(expectedNode.nodeId);
    if (!node) {
      mismatches.push("少了步驟「" + expectedNode.nodeId + "」的結果");
      continue;
    }
    const expectedFields = new Map(expectedNode.fields.map((field) => [field.name, field.kind]));
    const actualFields = new Map(node.fields.map((field) => [field.name, field.kind]));
    for (const [name, kind] of expectedFields) {
      if (!actualFields.has(name)) mismatches.push("步驟「" + node.label + "」少了欄位「" + name + "」");
      else if (actualFields.get(name) !== kind) mismatches.push("步驟「" + node.label + "」欄位「" + name + "」型別變成 " + actualFields.get(name));
    }
    for (const [name] of actualFields) if (!expectedFields.has(name)) mismatches.push("步驟「" + node.label + "」多了欄位「" + name + "」");
    const actualPorts = [...node.ports].sort();
    if (JSON.stringify(actualPorts) !== JSON.stringify(expectedNode.ports)) {
      mismatches.push("步驟「" + node.label + "」走了不同分支");
    }
    if (mismatches.length >= 80) return mismatches;
  }
  return mismatches;
}

function firstMismatchNodeId(expected: ScenarioExpected, receipt: RunReceipt): string | null {
  const actual = new Map(receipt.nodes.map((node) => [node.nodeId, node]));
  for (const expectedNode of expected.nodes) {
    const node = actual.get(expectedNode.nodeId);
    if (!node) return expectedNode.nodeId;
    const expectedFields = new Map(expectedNode.fields.map((field) => [field.name, field.kind]));
    const actualFields = new Map(node.fields.map((field) => [field.name, field.kind]));
    if ([...expectedFields].some(([name, kind]) => actualFields.get(name) !== kind)) return expectedNode.nodeId;
    if ([...actualFields.keys()].some((name) => !expectedFields.has(name))) return expectedNode.nodeId;
    if (JSON.stringify([...node.ports].sort()) !== JSON.stringify([...expectedNode.ports].sort())) return expectedNode.nodeId;
  }
  return receipt.nodes.find((node) => !expected.nodes.some((expectedNode) => expectedNode.nodeId === node.nodeId))?.nodeId ?? null;
}

export function getScenario(workflowId: string, scenarioId: string): ScenarioRow | null {
  return getDb().prepare("SELECT id, workflow_id, name, graph_fingerprint, params_json, expected_json, created_at, updated_at, controls_json FROM workflow_scenarios WHERE id=? AND workflow_id=?").get(scenarioId, workflowId) as ScenarioRow | null;
}

export function exportPortableScenarios(workflowId: string): PortableScenario[] {
  const rows = getDb().prepare("SELECT id, workflow_id, name, graph_fingerprint, params_json, expected_json, created_at, updated_at, controls_json FROM workflow_scenarios WHERE workflow_id=? ORDER BY updated_at DESC LIMIT 50").all(workflowId) as ScenarioRow[];
  return rows.map((row) => ({
    name: row.name,
    graphFingerprint: row.graph_fingerprint,
    params: scenarioRunParams(row),
    expected: parseExpected(row.expected_json),
    controls: { approvalDecisions: scenarioApprovalDecisions(row), forcedFailures: scenarioForcedFailures(row) },
  }));
}

export function importPortableScenarios(workflowId: string, raw: unknown): { imported: number; skipped: number } {
  const workflow = getWorkflow(workflowId);
  if (!workflow || !Array.isArray(raw)) return { imported: 0, skipped: Array.isArray(raw) ? raw.length : 0 };
  const fingerprint = workflowExecutionFingerprint(workflow);
  let imported = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  for (const item of raw.slice(0, 50)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { skipped++; continue; }
    const value = item as Record<string, unknown>;
    if (typeof value.name !== "string" || typeof value.graphFingerprint !== "string" || !value.params || typeof value.params !== "object" || Array.isArray(value.params) || !value.expected || typeof value.expected !== "object" || Array.isArray(value.expected)) { skipped++; continue; }
    if (value.graphFingerprint !== fingerprint) { skipped++; continue; }
    const expected = parseExpected(JSON.stringify(value.expected));
    if (expected.nodes.length === 0) { skipped++; continue; }
    const controlsRaw = value.controls && typeof value.controls === "object" && !Array.isArray(value.controls) ? value.controls as Record<string, unknown> : {};
    let approvals: Record<string, "approved" | "rejected"> = {};
    let failures: string[] = [];
    try {
      approvals = normalizeApprovalDecisions(workflow, controlsRaw.approvalDecisions);
      failures = normalizeForcedFailures(workflow, controlsRaw.forcedFailures);
    } catch { skipped++; continue; }
    const params = JSON.stringify(value.params);
    if (params.length > 100_000) { skipped++; continue; }
    const id = "scenario-" + randomUUID();
    getDb().prepare("INSERT INTO workflow_scenarios (id, workflow_id, name, graph_fingerprint, params_json, expected_json, controls_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, workflowId, safeName(value.name), fingerprint, encryptSecret(params), JSON.stringify(expected), JSON.stringify({ approvalDecisions: approvals, forcedFailures: failures }), now, now);
    imported++;
  }
  return { imported, skipped };
}

export function listScenarios(workflowId: string): ScenarioSummary[] {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return [];
  const fingerprint = workflowExecutionFingerprint(workflow);
  const rows = getDb().prepare("SELECT id, workflow_id, name, graph_fingerprint, params_json, expected_json, created_at, updated_at, controls_json FROM workflow_scenarios WHERE workflow_id=? ORDER BY updated_at DESC").all(workflowId) as ScenarioRow[];
  return rows.map((row) => rowToSummary(row, fingerprint));
}

export function createScenarioFromRun(workflowId: string, runId: string, name: unknown, approvalDecisions?: unknown, forcedFailures?: unknown): ScenarioSummary {
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error("找不到這條流程");
  const run = getDb().prepare("SELECT id, workflow_id, status, trigger_params_json, graph_fingerprint FROM runs WHERE id=? AND workflow_id=?").get(runId, workflowId) as { id: string; workflow_id: string; status: string; trigger_params_json: string | null; graph_fingerprint: string | null } | undefined;
  if (!run) throw new Error("找不到這次執行");
  if (run.status !== "success") throw new Error("只有成功的執行才能保存成情境測試");
  const receipt = buildRunReceipt(runId);
  if (!receipt) throw new Error("這次執行還沒有可保存的結果");
  const fingerprint = workflowExecutionFingerprint(workflow);
  if (run.graph_fingerprint && run.graph_fingerprint !== fingerprint) throw new Error("這次執行屬於舊版流程，請先用目前版本重新測試");
  const now = new Date().toISOString();
  const id = "scenario-" + randomUUID();
  const params = run.trigger_params_json && run.trigger_params_json.length <= 100_000 ? run.trigger_params_json : "{}";
  const controls = normalizeApprovalDecisions(workflow, approvalDecisions);
  const failures = normalizeForcedFailures(workflow, forcedFailures);
  getDb().prepare("INSERT INTO workflow_scenarios (id, workflow_id, name, graph_fingerprint, params_json, expected_json, controls_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, workflowId, safeName(name), fingerprint, encryptSecret(params), JSON.stringify(expectedFromReceipt(receipt)), JSON.stringify({ approvalDecisions: controls, forcedFailures: failures }), now, now);
  const row = getScenario(workflowId, id);
  if (!row) throw new Error("保存情境測試失敗");
  getDb().prepare("UPDATE runs SET scenario_id=? WHERE id=? AND workflow_id=?").run(id, runId, workflowId);
  return rowToSummary(row, fingerprint, { id: runId, status: "success", failed_node: null });
}

export function scenarioRunParams(row: ScenarioRow): Record<string, unknown> {
  const raw = decryptSecret(row.params_json);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* corrupted scenario input fails closed below */ }
  throw new Error("這個情境的輸入資料無法讀取，請刪除後重新保存");
}

export function scenarioResult(workflowId: string, row: ScenarioRow, runId: string): ScenarioRunResult {
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error("找不到這條流程");
  const scenario = rowToSummary(row, workflowExecutionFingerprint(workflow), { id: runId, status: "running", failed_node: null });
  const receipt = buildRunReceipt(runId);
  if (!receipt || receipt.workflowId !== workflowId) throw new Error("找不到這次情境執行");
  const terminal = ["success", "failed", "stopped"].includes(receipt.status);
  const expected = parseExpected(row.expected_json);
  return {
    scenario,
    complete: terminal,
    runId,
    status: receipt.status,
    matched: terminal && receipt.status === "success" ? compareExpected(expected, receipt).length === 0 : null,
    mismatches: terminal && receipt.status === "success" ? compareExpected(expected, receipt) : [],
    receipt,
  };
}

export function getScenarioRepairContext(workflowId: string, row: ScenarioRow, runId: string): ScenarioRepairContext | null {
  const workflow = getWorkflow(workflowId);
  const receipt = buildRunReceipt(runId);
  if (!workflow || !receipt || receipt.workflowId !== workflowId) return null;
  const expected = parseExpected(row.expected_json);
  const mismatches = receipt.status === "success" ? compareExpected(expected, receipt) : [];
  const failedNode = receipt.nodes.find((node) => node.status === "failed")?.nodeId ?? null;
  return {
    repairNodeId: failedNode ?? (mismatches.length > 0 ? firstMismatchNodeId(expected, receipt) : null),
    mismatches,
    status: receipt.status,
  };
}

export function getScenarioSuiteState(workflowId: string): ScenarioSuiteState {
  const scenarios = listScenarios(workflowId);
  const stale = scenarios.filter((scenario) => !scenario.matchesCurrentGraph).length;
  const passed = scenarios.filter((scenario) => scenario.matchesCurrentGraph && scenario.lastMatched === true).length;
  const failed = scenarios.filter((scenario) => scenario.matchesCurrentGraph && scenario.lastMatched === false).length;
  const pending = scenarios.length - stale - passed - failed;
  return { total: scenarios.length, passed, failed, pending, stale, allPassed: scenarios.length > 0 && stale === 0 && passed === scenarios.length };
}

export function runScenarioSuite(workflowId: string): ScenarioSuiteRunResult {
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error("找不到這條流程");
  const fingerprint = workflowExecutionFingerprint(workflow);
  const rows = getDb().prepare("SELECT id, workflow_id, name, graph_fingerprint, params_json, expected_json, created_at, updated_at, controls_json FROM workflow_scenarios WHERE workflow_id=? ORDER BY updated_at DESC LIMIT 50").all(workflowId) as ScenarioRow[];
  const result: ScenarioSuiteRunResult = { runIds: [], skippedStale: [], errors: [] };
  for (const row of rows) {
    if (row.graph_fingerprint !== fingerprint) {
      result.skippedStale.push(row.id);
      continue;
    }
    try {
      const runId = startWorkflowRun(workflowId, scenarioRunParams(row), { trigger: "manual", dryRun: true, scenarioApprovalDecisions: scenarioApprovalDecisions(row), scenarioForcedFailures: Object.fromEntries(scenarioForcedFailures(row).map((nodeId) => [nodeId, "scenario"])) });
      getDb().prepare("UPDATE runs SET scenario_id=? WHERE id=? AND workflow_id=?").run(row.id, runId, workflowId);
      result.runIds.push(runId);
    } catch (error) {
      result.errors.push({ scenarioId: row.id, error: error instanceof Error ? error.message : "無法重播情境" });
    }
  }
  return result;
}
