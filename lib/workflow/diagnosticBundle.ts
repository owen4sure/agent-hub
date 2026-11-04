import { getSharedSecrets, getGlobalSettings } from "../settingsStore";
import { getDb } from "../db";
import { redactKnownSecrets } from "../exportSanitizer";
import { classifyFailure, getRun, getRunLogs } from "./engine";
import { getWorkflow } from "./store";
import { buildRunReceipt } from "./runReceipt";

export interface DiagnosticBundle {
  version: 1;
  kind: "agenthub-diagnostic";
  exportedAt: string;
  privacy: {
    rawInputs: false;
    rawOutputs: false;
    credentials: false;
    oneTimeOverrides: false;
  };
  workflow: {
    id: string;
    name: string;
    graphFingerprint: string | null;
    nodeCount: number;
    edgeCount: number;
    nodes: { id: string; type: string; label: string }[];
    edges: { from: string; to: string; fromPort?: string }[];
  };
  run: {
    id: string;
    status: string;
    triggerType: string;
    dryRun: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    reason: string | null;
    failure: { nodeId: string | null; resolution: string | null; category: string | null };
    inputShape: { keys: string[]; count: number };
  };
  trace: {
    nodeId: string;
    label: string;
    status: string;
    attempt: number;
    durationSeconds: number | null;
    outputShape: { fields: string[]; count: number };
    error: string | null;
  }[];
  logs: string[];
  receipt: ReceiptSummary | null;
}

interface ReceiptSummary {
  comparedTo: { runId: string; createdAt: string | null } | null;
  changeCount: number;
}

type RunRow = {
  id: string;
  workflow_id: string;
  status: string;
  trigger_type: string;
  dry_run: number;
  trigger_params_json: string | null;
  reason: string | null;
  resolution: string | null;
  failed_node: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  graph_fingerprint: string | null;
};

type NodeRun = {
  id: number;
  node_id: string;
  status: string;
  attempt: number | null;
  started_at: string | null;
  finished_at: string | null;
  output_json: string | null;
  error: string | null;
};

function safeText(value: string | null | undefined, secrets: Record<string, string>): string | null {
  if (!value) return null;
  let out = redactKnownSecrets(value, secrets);
  out = out.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "<email>");
  out = out.replace(/([?&](?:token|key|secret|password|auth)=)[^&\s]+/gi, "$1<redacted>");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>");
  return out.slice(0, 800);
}

function shape(raw: string | null): { fields: string[]; count: number } {
  if (!raw) return { fields: [], count: 0 };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { fields: ["結果"], count: 1 };
    const fields = Object.keys(parsed as Record<string, unknown>).slice(0, 80);
    return { fields, count: Object.keys(parsed as Record<string, unknown>).length };
  } catch {
    return { fields: ["結果（格式無法摘要）"], count: 1 };
  }
}

function inputShape(raw: string | null): { keys: string[]; count: number } {
  const result = shape(raw);
  return { keys: result.fields, count: result.count };
}

function duration(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = new Date(startedAt.replace(" ", "T")).getTime();
  const end = new Date(finishedAt.replace(" ", "T")).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 100) / 10 : null;
}

export function buildDiagnosticBundle(runId: string): DiagnosticBundle | null {
  const db = getDb();
  const run = db.prepare(`SELECT id, workflow_id, status, trigger_type, dry_run, trigger_params_json, reason, resolution, failed_node, error, started_at, finished_at, graph_fingerprint FROM runs WHERE id=?`).get(runId) as RunRow | undefined;
  if (!run) return null;
  const workflow = getWorkflow(run.workflow_id);
  if (!workflow) return null;
  const secrets = { ...getSharedSecrets(), ...(getGlobalSettings().apiKey ? { MODEL_API_KEY: getGlobalSettings().apiKey } : {}) };
  const { nodeRuns } = getRun(runId) as { nodeRuns: NodeRun[] };
  const labels = new Map(workflow.nodes.map((node) => [node.id, node.label]));
  const trace = nodeRuns.map((node) => {
    const classified = node.status === "failed" && node.error ? classifyFailure(node.error) : null;
    return {
      nodeId: node.node_id,
      label: labels.get(node.node_id) ?? node.node_id,
      status: node.status,
      attempt: node.attempt ?? 1,
      durationSeconds: duration(node.started_at, node.finished_at),
      outputShape: shape(node.output_json),
      error: safeText(node.error, secrets) ?? (classified ? `${classified.category}：${classified.resolution}` : null),
    };
  });
  const receipt = buildRunReceipt(runId);
  const logs = (getRunLogs(runId) as { ts: string | null; line: string | null }[]).slice(-160).map((row) => {
    const text = safeText(String(row.line ?? ""), secrets) ?? "";
    return `${String(row.ts ?? "").slice(0, 19)} ${text}`.trim();
  });
  const safeBundle: DiagnosticBundle = {
    version: 1,
    kind: "agenthub-diagnostic",
    exportedAt: new Date().toISOString(),
    privacy: { rawInputs: false, rawOutputs: false, credentials: false, oneTimeOverrides: false },
    workflow: {
      id: workflow.id,
      name: workflow.name,
      graphFingerprint: run.graph_fingerprint,
      nodeCount: workflow.nodes.length,
      edgeCount: workflow.edges.length,
      nodes: workflow.nodes.map((node) => ({ id: node.id, type: node.type, label: node.label })),
      edges: workflow.edges.map((edge) => ({ from: edge.from, to: edge.to, ...(edge.fromPort ? { fromPort: edge.fromPort } : {}) })),
    },
    run: {
      id: run.id,
      status: run.status,
      triggerType: run.trigger_type,
      dryRun: Boolean(run.dry_run),
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      reason: safeText(run.reason, secrets),
      failure: {
        nodeId: run.failed_node,
        resolution: run.resolution,
        category: run.error ? classifyFailure(run.error).category : null,
      },
      inputShape: inputShape(run.trigger_params_json),
    },
    trace,
    logs,
    receipt: receipt ? { comparedTo: receipt.comparedTo, changeCount: receipt.changes.length } : null,
  };
  return safeBundle;
}
