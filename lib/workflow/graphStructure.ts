import { getNodeDef } from "./registry";
import { lintGraph, validateConfigTypes, withSchemaDefaults } from "./graphLint";
import { autoLayout, separateOverlappingNodes } from "./layout";
import { getWorkflow, saveWorkflow } from "./store";
import type { WorkflowEdge, WorkflowNode } from "./types";

/**
 * 對話 AI 的「增量改圖」格式。它刻意不是整包 nodes/edges：模型只說它真的要增、刪、重接的部分，
 * 伺服器永遠以最新的整張圖為底合併，才不會拿到聊天開始時的舊快照把剛修好的設定蓋掉。
 */
export interface GraphStructureEdits {
  removeNodeIds?: string[];
  addNodes?: Array<Pick<WorkflowNode, "id" | "type" | "label" | "config"> & { position?: { x: number; y: number } }>;
  addEdges?: WorkflowEdge[];
  removeEdges?: WorkflowEdge[];
}

export interface StructureChange {
  label: string;
  detail: string;
}

export interface StructureEditResult {
  ok: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  changes: StructureChange[];
  problems: string[];
}

function edgeKey(edge: WorkflowEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.fromPort ?? ""}`;
}

function validNodeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

function validEdge(value: unknown): value is WorkflowEdge {
  return Boolean(value) && typeof value === "object" &&
    typeof (value as WorkflowEdge).from === "string" &&
    typeof (value as WorkflowEdge).to === "string" &&
    ((value as WorkflowEdge).fromPort === undefined || typeof (value as WorkflowEdge).fromPort === "string");
}

/**
 * 純函式的結構修改驗證。builder 用它在模型回覆還沒落盤前把具體錯誤餵回去；真正存檔的入口也用
 * 同一份規則，避免「AI 說改好了、API 才發現不能存」兩套標準漂移。
 */
export function planGraphStructureEdits(
  graph: Pick<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }, "nodes" | "edges">,
  raw: GraphStructureEdits | undefined,
): StructureEditResult {
  const originalNodes = graph.nodes;
  const originalEdges = graph.edges;
  const problems: string[] = [];
  const changes: StructureChange[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, nodes: originalNodes, edges: originalEdges, changes, problems: ["structure 必須是物件"] };
  }
  const allowed = new Set(["removeNodeIds", "addNodes", "addEdges", "removeEdges"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) problems.push(`structure 裡不認得「${key}」；只能用 removeNodeIds、addNodes、addEdges、removeEdges`);
  const removeIds = raw.removeNodeIds ?? [];
  const addNodes = raw.addNodes ?? [];
  const addEdges = raw.addEdges ?? [];
  const removeEdges = raw.removeEdges ?? [];
  if (!Array.isArray(removeIds) || !Array.isArray(addNodes) || !Array.isArray(addEdges) || !Array.isArray(removeEdges)) {
    problems.push("structure 的 removeNodeIds/addNodes/addEdges/removeEdges 必須都是陣列");
  }
  if (removeIds.length + addNodes.length + addEdges.length + removeEdges.length === 0) problems.push("structure 沒有任何實際修改");
  if (removeIds.length > 50 || addNodes.length > 30 || addEdges.length > 100 || removeEdges.length > 100) problems.push("一次結構修改的節點或連線數量過多");
  if (problems.length) return { ok: false, nodes: originalNodes, edges: originalEdges, changes, problems };

  const existing = new Map(originalNodes.map((node) => [node.id, node]));
  const triggerIds = new Set(originalNodes.filter((node) => node.type === "trigger").map((node) => node.id));
  const removed = new Set<string>();
  for (const id of removeIds) {
    if (!validNodeId(id)) { problems.push(`要刪除的節點 id「${String(id)}」格式不正確`); continue; }
    if (!existing.has(id)) { problems.push(`找不到要刪除的節點「${id}」`); continue; }
    if (triggerIds.has(id)) { problems.push("不能刪除流程的觸發起點"); continue; }
    if (removed.has(id)) { problems.push(`節點「${id}」被重複要求刪除`); continue; }
    removed.add(id);
  }
  let nodes = originalNodes.filter((node) => !removed.has(node.id));
  for (const id of removed) changes.push({ label: existing.get(id)?.label ?? id, detail: "已刪除這個步驟與相關連線" });

  const ids = new Set(nodes.map((node) => node.id));
  for (const rawNode of addNodes) {
    if (!rawNode || typeof rawNode !== "object") { problems.push("新增節點的內容必須是物件"); continue; }
    if (!validNodeId(rawNode.id)) { problems.push(`新增節點 id「${String(rawNode.id)}」格式不正確`); continue; }
    if (ids.has(rawNode.id)) { problems.push(`新增節點 id「${rawNode.id}」已存在，不能覆蓋既有步驟`); continue; }
    const def = getNodeDef(String(rawNode.type ?? ""));
    if (!def) { problems.push(`新增節點「${rawNode.id}」的型別「${String(rawNode.type)}」不存在`); continue; }
    if (def.type === "trigger") { problems.push("不能新增第二個觸發起點"); continue; }
    if (!rawNode.config || typeof rawNode.config !== "object" || Array.isArray(rawNode.config)) { problems.push(`新增節點「${rawNode.id}」的 config 必須是物件`); continue; }
    const allowedConfig = new Set(def.configSchema.map((field) => field.key));
    const config = Object.fromEntries(Object.entries(rawNode.config).filter(([key]) => allowedConfig.has(key)));
    const configErrors = validateConfigTypes(rawNode.id, config, def.configSchema);
    if (configErrors.length) { problems.push(...configErrors); continue; }
    const requested = rawNode.position;
    const position = requested && Number.isFinite(requested.x) && Number.isFinite(requested.y) && Math.abs(requested.x) <= 1_000_000 && Math.abs(requested.y) <= 1_000_000
      ? requested
      : { x: 0, y: 0 };
    const node: WorkflowNode = {
      id: rawNode.id,
      type: def.type,
      label: typeof rawNode.label === "string" && rawNode.label.trim() ? rawNode.label.trim().slice(0, 120) : def.label,
      config: withSchemaDefaults(config, def.configSchema),
      position,
    };
    nodes = [...nodes, node];
    ids.add(node.id);
    changes.push({ label: node.label, detail: "已新增這個步驟" });
  }
  if (problems.length) return { ok: false, nodes: originalNodes, edges: originalEdges, changes: [], problems };

  let edges = originalEdges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to));
  for (const edge of removeEdges) {
    if (!validEdge(edge)) { problems.push("要移除的連線格式不正確"); continue; }
    const key = edgeKey(edge);
    if (!edges.some((candidate) => edgeKey(candidate) === key)) { problems.push(`找不到要移除的連線 ${edge.from}→${edge.to}`); continue; }
    edges = edges.filter((candidate) => edgeKey(candidate) !== key);
    changes.push({ label: "流程連線", detail: `已移除 ${edge.from} → ${edge.to}${edge.fromPort ? `（${edge.fromPort}）` : ""}` });
  }
  for (const edge of addEdges) {
    if (!validEdge(edge) || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) {
      problems.push("新增的連線格式不正確，或起點／終點不存在");
      continue;
    }
    if (edges.some((candidate) => edgeKey(candidate) === edgeKey(edge))) { problems.push(`連線 ${edge.from}→${edge.to} 已存在`); continue; }
    edges = [...edges, { from: edge.from, to: edge.to, ...(edge.fromPort ? { fromPort: edge.fromPort } : {}) }];
    changes.push({ label: "流程連線", detail: `已接上 ${edge.from} → ${edge.to}${edge.fromPort ? `（${edge.fromPort}）` : ""}` });
  }
  if (problems.length) return { ok: false, nodes: originalNodes, edges: originalEdges, changes: [], problems };

  // 現有草稿本來就可能是壞圖，AI 正在修它時不能被無關的舊錯誤擋死；但此次修改絕不准新增錯誤。
  const baseline = new Set(lintGraph(originalNodes, originalEdges));
  const introduced = lintGraph(nodes, edges).filter((problem) => !baseline.has(problem));
  if (introduced.length) return { ok: false, nodes: originalNodes, edges: originalEdges, changes: [], problems: introduced };

  // 既有節點的位置完全尊重；只為新節點借自動版面的位置，再由唯一存檔入口保證不重疊。
  const oldPositions = new Map(originalNodes.map((node) => [node.id, node.position]));
  const suggested = autoLayout(nodes, edges);
  const positioned = nodes.map((node) => ({ ...node, position: oldPositions.get(node.id) ?? suggested[node.id] ?? node.position }));
  const separated = separateOverlappingNodes(positioned);
  nodes = separated.changed ? positioned.map((node) => ({ ...node, position: separated.positions[node.id] })) : positioned;
  return { ok: true, nodes, edges, changes, problems: [] };
}

export function applyGraphStructureEdits(workflowId: string, raw: GraphStructureEdits, opts: { apply?: boolean } = {}): StructureEditResult {
  const fresh = getWorkflow(workflowId);
  if (!fresh) throw new Error("workflow 不存在(可能剛被刪除)");
  const plan = planGraphStructureEdits(fresh, raw);
  if (plan.ok && opts.apply !== false) saveWorkflow({ ...fresh, nodes: plan.nodes, edges: plan.edges });
  return plan;
}
