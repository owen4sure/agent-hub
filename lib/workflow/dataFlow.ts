import { DATE_TOKENS } from "../relativeDate";
import { analyzeCustomCodeOutput } from "./graphLint";
import { getNodeDef } from "./registry";
import { workflowExecutionFingerprint } from "./fingerprint";
import type { Workflow, WorkflowNode } from "./types";

export type DataFlowFieldStatus = "available" | "unknown-source" | "missing" | "runtime";

export interface DataFlowField {
  name: string;
  sources: string[];
  status: DataFlowFieldStatus;
}

export interface DataFlowReference {
  token: string;
  status: DataFlowFieldStatus;
}

export interface DataFlowNode {
  order: number;
  id: string;
  label: string;
  type: string;
  inputs: DataFlowField[];
  outputs: DataFlowField[];
  references: DataFlowReference[];
}

export interface WorkflowDataFlow {
  graphFingerprint: string;
  nodes: DataFlowNode[];
  warnings: string[];
}

function outputNames(node: WorkflowNode): { names: string[]; unknown: boolean } {
  if (node.type === "custom-code") {
    const analysis = analyzeCustomCodeOutput(String(node.config?.code ?? ""));
    return analysis ? { names: analysis.declaredFields, unknown: false } : { names: [], unknown: true };
  }
  const outputs = getNodeDef(node.type)?.outputs ?? "";
  return {
    names: outputs.split(",").map((part) => part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1]).filter((x): x is string => Boolean(x)),
    unknown: false,
  };
}

function refsIn(node: WorkflowNode): string[] {
  const refs = new Set<string>();
  for (const match of JSON.stringify(node.config ?? {}).matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const token = match[1].trim();
    if (token) refs.add(token);
  }
  return [...refs];
}

function traversal(nodes: WorkflowNode[], children: Map<string, string[]>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
    for (const child of children.get(id) ?? []) visit(child);
  };
  for (const node of nodes.filter((n) => n.type === "trigger")) visit(node.id);
  for (const node of nodes) visit(node.id);
  return ordered;
}

/**
 * 純靜態的資料流說明：不執行 custom-code、不讀帳密、不把設定值送給模型。
 * unknown-source 是刻意保守的結果，避免把 AI/自訂程式可能產出的欄位說成不存在。
 */
export function buildWorkflowDataFlow(workflow: Workflow): WorkflowDataFlow {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    parents.set(edge.to, [...(parents.get(edge.to) ?? []), edge.from]);
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  }
  const secrets = new Set<string>();
  for (const node of workflow.nodes) for (const field of getNodeDef(node.type)?.secretFields?.(node.config ?? {}) ?? []) secrets.add(field.key);
  const dateTokens = new Set<string>(DATE_TOKENS);
  const memo = new Map<string, { fields: Map<string, DataFlowField>; unknown: boolean }>();

  const available = (id: string, trail: Set<string>): { fields: Map<string, DataFlowField>; unknown: boolean } => {
    if (memo.has(id)) return memo.get(id)!;
    if (trail.has(id)) return { fields: new Map(), unknown: true };
    const node = byId.get(id);
    if (!node) return { fields: new Map(), unknown: true };
    const nextTrail = new Set(trail).add(id);
    const fields = new Map<string, DataFlowField>();
    let unknown = false;
    for (const parentId of parents.get(id) ?? []) {
      const parent = byId.get(parentId);
      if (!parent) continue;
      const upstream = available(parentId, nextTrail);
      unknown ||= upstream.unknown;
      for (const [name, field] of upstream.fields) {
        const prior = fields.get(name);
        fields.set(name, { name, sources: [...new Set([...(prior?.sources ?? []), ...field.sources])], status: field.status });
      }
      if (parent.type === "trigger") {
        for (const name of ["filePath", "fileName"]) fields.set(name, { name, sources: [parent.label], status: "runtime" });
        if (parent.config?.mailWatch === "on") for (const name of ["from", "subject", "date", "body", "attachmentCount"]) fields.set(name, { name, sources: [parent.label], status: "runtime" });
        if (parent.config?.telegramWatch === "on") for (const name of ["message", "chatId", "fromName", "messageId"]) fields.set(name, { name, sources: [parent.label], status: "runtime" });
        if (parent.config?.lineWatch === "on") for (const name of ["message", "userId", "replyToken"]) fields.set(name, { name, sources: [parent.label], status: "runtime" });
        for (const param of workflow.triggerParams ?? []) fields.set(param.key, { name: param.key, sources: [parent.label], status: "runtime" });
      }
      const produced = outputNames(parent);
      unknown ||= produced.unknown;
      for (const name of produced.names) fields.set(name, { name, sources: [parent.label], status: "available" });
      if (parent.type === "set-variable" && typeof parent.config?.name === "string" && parent.config.name.trim()) fields.set(parent.config.name.trim(), { name: parent.config.name.trim(), sources: [parent.label], status: "available" });
      if (typeof parent.config?.outputKey === "string" && parent.config.outputKey.trim()) fields.set(parent.config.outputKey.trim(), { name: parent.config.outputKey.trim(), sources: [parent.label], status: "available" });
    }
    const result = { fields, unknown };
    memo.set(id, result);
    return result;
  };

  const nodes = traversal(workflow.nodes, children).map((id, index) => {
    const node = byId.get(id)!;
    const upstream = available(id, new Set());
    const inputs = [...upstream.fields.values()].sort((a, b) => a.name.localeCompare(b.name));
    const produced = outputNames(node);
    const outputs = produced.names.map((name) => ({ name, sources: [node.label], status: "available" as const }));
    const references = refsIn(node).map((token) => {
      const head = token.split(".")[0];
      const status: DataFlowFieldStatus = dateTokens.has(head) || token.startsWith("period.") || secrets.has(head) ? "runtime" : upstream.fields.has(head) ? upstream.fields.get(head)!.status : upstream.unknown ? "unknown-source" : "missing";
      return { token, status };
    });
    return { order: index + 1, id: node.id, label: node.label || node.type, type: node.type, inputs, outputs, references };
  });
  const warnings = nodes.flatMap((node) => node.references.filter((ref) => ref.status === "missing").map((ref) => `「${node.label}」引用了「${ref.token}」，但目前上游沒有這個欄位。`));
  return { graphFingerprint: workflowExecutionFingerprint(workflow), nodes, warnings };
}
