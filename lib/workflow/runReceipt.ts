import path from "node:path";
import { getDb } from "../db";
import { getWorkflow } from "./store";

export type ReceiptValueKind = "text" | "number" | "boolean" | "list" | "object" | "null" | "file";

export interface ReceiptField {
  name: string;
  kind: ReceiptValueKind;
  detail: string;
}

export interface ReceiptNode {
  nodeId: string;
  label: string;
  status: string;
  fields: ReceiptField[];
  ports: string[];
}

export interface ReceiptChange {
  nodeId: string;
  label: string;
  field: string;
  before: string;
  after: string;
}

export interface RunReceipt {
  runId: string;
  workflowId: string;
  status: string;
  createdAt: string | null;
  graphFingerprint: string | null;
  nodes: ReceiptNode[];
  comparedTo: { runId: string; createdAt: string | null } | null;
  changes: ReceiptChange[];
}

type RunRow = {
  id: string;
  workflow_id: string;
  status: string;
  started_at: string | null;
  graph_fingerprint: string | null;
};

type NodeRunRow = {
  node_id: string;
  status: string;
  output_json: string | null;
  active_ports: string | null;
};

type FieldMap = Map<string, ReceiptField>;

function kindOf(value: unknown): ReceiptValueKind {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    return /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9]{1,8}$/.test(value) ? "file" : "text";
  }
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "list";
  return "object";
}

function detailOf(value: unknown): string {
  if (value === null || value === undefined) return "空值";
  if (typeof value === "string") return "文字 " + value.length + " 字";
  if (typeof value === "number") return "已算出數字";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return "共有 " + value.length + " 筆";
  if (typeof value === "object") return "共有 " + Object.keys(value as Record<string, unknown>).length + " 個欄位";
  return "已產生";
}

function fieldsFromJson(raw: string | null): ReceiptField[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [{ name: "結果", kind: kindOf(parsed), detail: detailOf(parsed) }];
    }
    return Object.entries(parsed as Record<string, unknown>).slice(0, 80).map(([name, value]) => ({
      name,
      kind: kindOf(value),
      detail: value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).filename === "string"
        ? "檔案：" + path.basename(String((value as Record<string, unknown>).filename))
        : detailOf(value),
    }));
  } catch {
    return [{ name: "結果", kind: "text", detail: "有輸出但格式無法摘要" }];
  }
}

function fieldSignature(field: ReceiptField): string {
  return field.kind + "|" + field.detail;
}

function nodeLabel(workflow: ReturnType<typeof getWorkflow>, nodeId: string): string {
  return workflow?.nodes.find((node) => node.id === nodeId)?.label || nodeId;
}

function rowsToNodes(workflow: ReturnType<typeof getWorkflow>, rows: NodeRunRow[]): ReceiptNode[] {
  return rows.map((row) => ({
    nodeId: row.node_id,
    label: nodeLabel(workflow, row.node_id),
    status: row.status,
    fields: fieldsFromJson(row.output_json),
    ports: parsePorts(row.active_ports),
  }));
}

function parsePorts(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((port): port is string => typeof port === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function fieldMap(nodes: ReceiptNode[]): Map<string, FieldMap> {
  return new Map(nodes.map((node) => [node.nodeId, new Map(node.fields.map((field) => [field.name, field]))]));
}

function compareNodes(current: ReceiptNode[], previous: ReceiptNode[]): ReceiptChange[] {
  const currentMap = fieldMap(current);
  const previousMap = fieldMap(previous);
  const labels = new Map([...current, ...previous].map((node) => [node.nodeId, node.label]));
  const nodeIds = new Set([...currentMap.keys(), ...previousMap.keys()]);
  const changes: ReceiptChange[] = [];
  for (const nodeId of nodeIds) {
    const now = currentMap.get(nodeId) || new Map<string, ReceiptField>();
    const before = previousMap.get(nodeId) || new Map<string, ReceiptField>();
    const names = new Set([...now.keys(), ...before.keys()]);
    for (const name of names) {
      const currentField = now.get(name);
      const previousField = before.get(name);
      if (!currentField || !previousField || fieldSignature(currentField) !== fieldSignature(previousField)) {
        changes.push({
          nodeId,
          label: labels.get(nodeId) || nodeId,
          field: name,
          before: previousField ? previousField.kind + "／" + previousField.detail : "未產生",
          after: currentField ? currentField.kind + "／" + currentField.detail : "本次未產生",
        });
      }
      if (changes.length >= 120) return changes;
    }
  }
  return changes;
}

export function buildRunReceipt(runId: string): RunReceipt | null {
  const db = getDb();
  const run = db.prepare("SELECT id, workflow_id, status, started_at, graph_fingerprint FROM runs WHERE id=?").get(runId) as RunRow | undefined;
  if (!run) return null;
  const workflow = getWorkflow(run.workflow_id);
  const rows = db.prepare("SELECT node_id, status, output_json, active_ports FROM node_runs WHERE run_id=? ORDER BY id").all(runId) as NodeRunRow[];
  const previous = db.prepare("SELECT id, started_at FROM runs WHERE workflow_id=? AND id<>? AND status='success' ORDER BY started_at DESC LIMIT 1").get(run.workflow_id, runId) as { id: string; started_at: string | null } | undefined;
  const currentNodes = rowsToNodes(workflow, rows);
  let previousNodes: ReceiptNode[] = [];
  if (previous) {
    const previousRows = db.prepare("SELECT node_id, status, output_json, active_ports FROM node_runs WHERE run_id=? ORDER BY id").all(previous.id) as NodeRunRow[];
    previousNodes = rowsToNodes(workflow, previousRows);
  }
  return {
    runId: run.id,
    workflowId: run.workflow_id,
    status: run.status,
    createdAt: run.started_at,
    graphFingerprint: run.graph_fingerprint,
    nodes: currentNodes,
    comparedTo: previous ? { runId: previous.id, createdAt: previous.started_at } : null,
    changes: previous ? compareNodes(currentNodes, previousNodes) : [],
  };
}
