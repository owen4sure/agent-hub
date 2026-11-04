import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { cancelRun, getRun, startWorkflowRun } from "./engine";
import { workflowExecutionFingerprint } from "./fingerprint";
import { getWorkflow } from "./store";
import { getScenario, scenarioApprovalDecisions, scenarioForcedFailures, scenarioResult, scenarioRunParams } from "./scenarioTests";

export const HEALTH_CHECK_INTERVALS = [15, 60, 360, 1440] as const;
export type HealthCheckInterval = typeof HEALTH_CHECK_INTERVALS[number];

type HealthCheckRow = {
  workflow_id: string;
  enabled: number;
  interval_minutes: number;
  next_run_at: string | null;
  active_batch_id: string | null;
  last_batch_id: string | null;
  last_status: string | null;
  last_summary: string | null;
  last_graph_fingerprint: string | null;
  last_finished_at: string | null;
  updated_at: string;
};

type HealthRunRow = {
  id: string;
  batch_id: string;
  workflow_id: string;
  scenario_id: string;
  run_id: string | null;
  status: string;
  matched: number | null;
  mismatches_json: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export interface HealthCheckItem {
  id: string;
  scenarioId: string;
  scenarioName: string;
  status: string;
  matched: boolean | null;
  mismatches: string[];
  error: string | null;
  runId: string | null;
  finishedAt: string | null;
}

export interface HealthCheckView {
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string | null;
  activeBatchId: string | null;
  lastBatchId: string | null;
  lastStatus: string | null;
  lastSummary: string | null;
  lastGraphFingerprint: string | null;
  lastFinishedAt: string | null;
  currentGraphFingerprint: string | null;
  currentScenarioCount: number;
  staleScenarioCount: number;
  items: HealthCheckItem[];
}

export interface HealthCheckStartResult {
  batchId: string;
  runIds: string[];
  skippedStale: string[];
  errors: { scenarioId: string; error: string }[];
  status: string;
}

/** 自動觸發閘門只讀既有設定；沒有開過巡檢的舊流程不建立空白資料列。 */
export function getHealthCheckGate(workflowId: string): { enabled: boolean; lastStatus: string | null } | null {
  const row = getDb().prepare("SELECT enabled, last_status FROM workflow_health_checks WHERE workflow_id=?").get(workflowId) as { enabled: number; last_status: string | null } | undefined;
  return row ? { enabled: row.enabled === 1, lastStatus: row.last_status } : null;
}

export function normalizeHealthCheckInterval(value: unknown): HealthCheckInterval | null {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return HEALTH_CHECK_INTERVALS.includes(n as HealthCheckInterval) ? n as HealthCheckInterval : null;
}

function parseMismatches(raw: string | null | undefined): string[] {
  try {
    const value = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
  } catch { return []; }
}

function ensureRow(workflowId: string): HealthCheckRow {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM workflow_health_checks WHERE workflow_id=?").get(workflowId) as HealthCheckRow | undefined;
  if (existing) return existing;
  db.prepare("INSERT INTO workflow_health_checks (workflow_id, updated_at) VALUES (?, datetime('now'))").run(workflowId);
  return db.prepare("SELECT * FROM workflow_health_checks WHERE workflow_id=?").get(workflowId) as HealthCheckRow;
}

function itemFromRow(row: HealthRunRow): HealthCheckItem {
  const scenario = getScenario(row.workflow_id, row.scenario_id);
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    scenarioName: scenario?.name ?? "已刪除情境",
    status: row.status,
    matched: row.matched === null ? null : row.matched === 1,
    mismatches: parseMismatches(row.mismatches_json),
    error: row.error,
    runId: row.run_id,
    finishedAt: row.finished_at,
  };
}

export function getHealthCheckView(workflowId: string): HealthCheckView {
  const workflow = getWorkflow(workflowId);
  let row = ensureRow(workflowId);
  // UI polling與下一次 scheduler tick都可能先看到 run 已完成；讀取狀態時順手做一次
  // 確定性收尾，避免健康卡永遠停在「巡檢中」而要等下一個整分鐘心跳。
  if (row.active_batch_id) {
    evaluateBatch(row.active_batch_id);
    row = ensureRow(workflowId);
  }
  const fingerprint = workflow ? workflowExecutionFingerprint(workflow) : null;
  const scenarioRows = getDb().prepare("SELECT id, graph_fingerprint FROM workflow_scenarios WHERE workflow_id=?").all(workflowId) as { id: string; graph_fingerprint: string }[];
  const batchId = row.active_batch_id ?? row.last_batch_id;
  const items = batchId
    ? (getDb().prepare("SELECT * FROM workflow_health_runs WHERE batch_id=? ORDER BY created_at ASC").all(batchId) as HealthRunRow[]).map(itemFromRow)
    : [];
  return {
    enabled: row.enabled === 1,
    intervalMinutes: normalizeHealthCheckInterval(row.interval_minutes) ?? 1440,
    nextRunAt: row.next_run_at,
    activeBatchId: row.active_batch_id,
    lastBatchId: row.last_batch_id,
    lastStatus: row.last_status,
    lastSummary: row.last_summary,
    lastGraphFingerprint: row.last_graph_fingerprint,
    lastFinishedAt: row.last_finished_at,
    currentGraphFingerprint: fingerprint,
    currentScenarioCount: scenarioRows.filter((item) => item.graph_fingerprint === fingerprint).length,
    staleScenarioCount: scenarioRows.filter((item) => item.graph_fingerprint !== fingerprint).length,
    items,
  };
}

export function updateHealthCheck(workflowId: string, enabled: boolean, intervalMinutes: unknown): HealthCheckView {
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error("找不到這條流程");
  const interval = normalizeHealthCheckInterval(intervalMinutes);
  if (!interval) throw new Error("巡檢頻率只能選 15 分鐘、1 小時、6 小時或每天");
  const view = getHealthCheckView(workflowId);
  if (enabled && workflow.status !== "official") throw new Error("流程要先設為正式，才能啟用自動健康巡檢");
  if (enabled && view.currentScenarioCount === 0) throw new Error("請先用目前版本保存至少一個成功情境，巡檢才知道什麼叫做正確");
  getDb().prepare(`
    UPDATE workflow_health_checks
    SET enabled=?, interval_minutes=?, next_run_at=CASE WHEN ?=1 THEN datetime('now', '+' || ? || ' minutes') ELSE NULL END, updated_at=datetime('now')
    WHERE workflow_id=?
  `).run(enabled ? 1 : 0, interval, enabled ? 1 : 0, interval, workflowId);
  return getHealthCheckView(workflowId);
}

function claimBatch(workflowId: string, scheduled: boolean): { batchId: string; row: HealthCheckRow } {
  const db = getDb();
  const row = ensureRow(workflowId);
  if (row.active_batch_id) throw new Error("健康巡檢正在進行，請等這次完成");
  if (scheduled && row.enabled !== 1) throw new Error("健康巡檢尚未啟用");
  const batchId = "health-" + randomUUID();
  const claimed = db.prepare(`
    UPDATE workflow_health_checks
    SET active_batch_id=?, last_status='running', last_summary='正在安全重播已保存情境', updated_at=datetime('now'),
        next_run_at=CASE WHEN enabled=1 THEN datetime('now', '+' || interval_minutes || ' minutes') ELSE next_run_at END
    WHERE workflow_id=? AND active_batch_id IS NULL
  `).run(batchId, workflowId);
  if (claimed.changes !== 1) throw new Error("另一個 Agent Hub 進程剛開始了這條巡檢，請稍後查看結果");
  return { batchId, row: db.prepare("SELECT * FROM workflow_health_checks WHERE workflow_id=?").get(workflowId) as HealthCheckRow };
}

function finishBatchIfReady(batchId: string): boolean {
  const db = getDb();
  const check = db.prepare("SELECT * FROM workflow_health_checks WHERE active_batch_id=?").get(batchId) as HealthCheckRow | undefined;
  if (!check) return false;
  const rows = db.prepare("SELECT * FROM workflow_health_runs WHERE batch_id=? ORDER BY created_at ASC").all(batchId) as HealthRunRow[];
  if (rows.some((row) => !["passed", "failed", "stale"].includes(row.status))) return false;
  const hasStale = rows.some((row) => row.status === "stale");
  const passed = rows.length > 0 && !hasStale && rows.every((row) => row.status === "passed" && row.matched === 1);
  const failed = rows.filter((row) => row.status === "failed").length;
  const summary = rows.length === 0
    ? "目前版本沒有可重播的情境，請先保存成功情境"
    : hasStale ? `有 ${rows.filter((row) => row.status === "stale").length} 個情境屬於舊版，請用目前版本重新保存`
      : passed ? `全部 ${rows.length} 個情境通過安全巡檢`
      : `${failed} 個情境沒有通過，請查看第一個失敗情境的白話差異`;
  const status = rows.length === 0 || hasStale ? "stale" : passed ? "passed" : "failed";
  db.prepare(`UPDATE workflow_health_checks SET active_batch_id=NULL, last_batch_id=?, last_status=?, last_summary=?, last_graph_fingerprint=?, last_finished_at=datetime('now'), updated_at=datetime('now') WHERE active_batch_id=?`).run(batchId, status, summary, check.last_graph_fingerprint, batchId);
  return true;
}

function evaluateBatch(batchId: string): void {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM workflow_health_runs WHERE batch_id=? AND status NOT IN ('passed','failed','stale')").all(batchId) as HealthRunRow[];
  for (const row of rows) {
    if (!row.run_id) {
      db.prepare("UPDATE workflow_health_runs SET status='failed', error=?, finished_at=datetime('now') WHERE id=?").run(row.error ?? "安全巡檢沒有成功啟動這個情境", row.id);
      continue;
    }
    const run = getRun(row.run_id).run as { status: string; reason: string | null; error: string | null } | undefined;
    if (!run || ["queued", "running"].includes(run.status)) continue;
    if (run.status === "waiting") {
      cancelRun(row.run_id, "健康巡檢不會等待真人簽核；請保存核准／拒絕情境後再巡檢");
      db.prepare("UPDATE workflow_health_runs SET status='failed', matched=0, error=?, finished_at=datetime('now') WHERE id=?").run("這個情境需要真人簽核，巡檢不會替你做決定", row.id);
      continue;
    }
    if (run.status !== "success") {
      db.prepare("UPDATE workflow_health_runs SET status='failed', matched=0, error=?, finished_at=datetime('now') WHERE id=?").run((run.reason ?? run.error ?? "情境執行失敗").slice(0, 500), row.id);
      continue;
    }
    try {
      const scenario = getScenario(row.workflow_id, row.scenario_id);
      if (!scenario) throw new Error("保存的情境已不存在");
      const result = scenarioResult(row.workflow_id, scenario, row.run_id);
      const mismatches = result.mismatches.slice(0, 20);
      db.prepare("UPDATE workflow_health_runs SET status=?, matched=?, mismatches_json=?, error=?, finished_at=datetime('now') WHERE id=?").run(result.matched ? "passed" : "failed", result.matched ? 1 : 0, JSON.stringify(mismatches), result.matched ? null : "安全巡檢發現結果和保存情境不同", row.id);
    } catch (error) {
      db.prepare("UPDATE workflow_health_runs SET status='failed', matched=0, error=?, finished_at=datetime('now') WHERE id=?").run(error instanceof Error ? error.message.slice(0, 500) : "無法核對情境結果", row.id);
    }
  }
  finishBatchIfReady(batchId);
}

export function startHealthCheck(workflowId: string, scheduled = false): HealthCheckStartResult {
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error("找不到這條流程");
  const fingerprint = workflowExecutionFingerprint(workflow);
  const { batchId } = claimBatch(workflowId, scheduled);
  const db = getDb();
  const scenarios = db.prepare("SELECT id, graph_fingerprint FROM workflow_scenarios WHERE workflow_id=? ORDER BY updated_at DESC LIMIT 50").all(workflowId) as { id: string; graph_fingerprint: string }[];
  const skippedStale = scenarios.filter((scenario) => scenario.graph_fingerprint !== fingerprint).map((scenario) => scenario.id);
  const current = scenarios.filter((scenario) => scenario.graph_fingerprint === fingerprint);
  const runIds: string[] = [];
  const errors: { scenarioId: string; error: string }[] = [];
  for (const scenario of current) {
    const id = "health-run-" + randomUUID();
    let runId: string | null = null;
    let error: string | null = null;
    try {
      const row = getScenario(workflowId, scenario.id);
      if (!row) throw new Error("保存的情境已不存在");
      runId = startWorkflowRun(workflowId, scenarioRunParams(row), {
        trigger: "health-check",
        dryRun: true,
        scenarioApprovalDecisions: scenarioApprovalDecisions(row),
        scenarioForcedFailures: Object.fromEntries(scenarioForcedFailures(row).map((nodeId) => [nodeId, "health-check"])),
      });
      db.prepare("UPDATE runs SET scenario_id=? WHERE id=? AND workflow_id=?").run(scenario.id, runId, workflowId);
      runIds.push(runId);
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 500) : "無法開始安全巡檢";
      errors.push({ scenarioId: scenario.id, error });
    }
    db.prepare("INSERT INTO workflow_health_runs (id,batch_id,workflow_id,scenario_id,run_id,status,error,created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))").run(id, batchId, workflowId, scenario.id, runId, runId ? "queued" : "failed", error);
  }
  db.prepare("UPDATE workflow_health_checks SET last_graph_fingerprint=?, updated_at=datetime('now') WHERE workflow_id=?").run(fingerprint, workflowId);
  for (const scenarioId of skippedStale) {
    db.prepare("INSERT INTO workflow_health_runs (id,batch_id,workflow_id,scenario_id,status,error,created_at) VALUES (?,?,?,?,?,?,datetime('now'))").run("health-run-" + randomUUID(), batchId, workflowId, scenarioId, "stale", "這個情境屬於舊版流程，請用目前版本重新保存");
  }
  evaluateBatch(batchId);
  return { batchId, runIds, skippedStale, errors, status: (db.prepare("SELECT last_status FROM workflow_health_checks WHERE workflow_id=?").get(workflowId) as { last_status: string | null }).last_status ?? "running" };
}

export function sweepHealthChecks(): void {
  const db = getDb();
  const active = db.prepare("SELECT active_batch_id FROM workflow_health_checks WHERE active_batch_id IS NOT NULL").all() as { active_batch_id: string }[];
  for (const row of active) evaluateBatch(row.active_batch_id);
  const due = db.prepare("SELECT workflow_id FROM workflow_health_checks WHERE enabled=1 AND active_batch_id IS NULL AND next_run_at IS NOT NULL AND next_run_at <= datetime('now')").all() as { workflow_id: string }[];
  for (const row of due) {
    try { startHealthCheck(row.workflow_id, true); } catch (error) { console.error("[scheduler] 健康巡檢啟動失敗:", error); }
  }
}
