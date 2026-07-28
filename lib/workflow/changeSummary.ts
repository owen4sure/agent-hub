import { configuredSideEffects, NODE_SIDE_EFFECTS, type SideEffectTag } from "./sideEffects";
import type { Workflow, WorkflowNode } from "./types";

export interface NodeChange {
  id: string;
  label: string;
  type: string;
  changes: string[];
  effectsAdded: SideEffectTag[];
  effectsRemoved: SideEffectTag[];
}
export interface ChangeSummary {
  from: { name: string; nodeCount: number; edgeCount: number };
  to: { name: string; nodeCount: number; edgeCount: number };
  addedNodes: { id: string; label: string; type: string; effects: SideEffectTag[] }[];
  removedNodes: { id: string; label: string; type: string; effects: SideEffectTag[] }[];
  changedNodes: NodeChange[];
  addedEdges: { from: string; to: string; fromPort?: string }[];
  removedEdges: { from: string; to: string; fromPort?: string }[];
  triggerParamsChanged: boolean;
  riskEffectsAdded: SideEffectTag[];
  hasChanges: boolean;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
function effects(node: WorkflowNode): Set<SideEffectTag> {
  const fixed = NODE_SIDE_EFFECTS[node.type]?.effects ?? [];
  const configured = configuredSideEffects(node.type, node.config ?? {}).effects;
  return new Set([...fixed, ...configured]);
}
function edgeKey(edge: { from: string; to: string; fromPort?: string }): string {
  return edge.from + "\u0000" + edge.to + "\u0000" + (edge.fromPort ?? "");
}

/** 純比較，不執行流程、不讀取設定頁帳密；config 只用來判斷哪些類型變了。 */
export function summarizeWorkflowChange(before: Workflow, after: Workflow): ChangeSummary {
  const oldNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const newNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const addedNodes: ChangeSummary["addedNodes"] = [];
  const removedNodes: ChangeSummary["removedNodes"] = [];
  const changedNodes: NodeChange[] = [];
  for (const node of after.nodes) {
    const old = oldNodes.get(node.id);
    if (!old) { addedNodes.push({ id: node.id, label: node.label, type: node.type, effects: [...effects(node)] }); continue; }
    const changes: string[] = [];
    if (old.type !== node.type) changes.push("步驟類型");
    if (old.label !== node.label) changes.push("步驟名稱");
    if (!same(old.config, node.config)) changes.push("步驟設定");
    const oldEffects = effects(old);
    const newEffects = effects(node);
    const effectsAdded = [...newEffects].filter((effect) => !oldEffects.has(effect));
    const effectsRemoved = [...oldEffects].filter((effect) => !newEffects.has(effect));
    if (changes.length || effectsAdded.length || effectsRemoved.length) changedNodes.push({ id: node.id, label: node.label, type: node.type, changes, effectsAdded, effectsRemoved });
  }
  for (const node of before.nodes) if (!newNodes.has(node.id)) removedNodes.push({ id: node.id, label: node.label, type: node.type, effects: [...effects(node)] });
  const oldEdges = new Map(before.edges.map((edge) => [edgeKey(edge), edge]));
  const newEdges = new Map(after.edges.map((edge) => [edgeKey(edge), edge]));
  const addedEdges = after.edges.filter((edge) => !oldEdges.has(edgeKey(edge)));
  const removedEdges = before.edges.filter((edge) => !newEdges.has(edgeKey(edge)));
  const riskEffectsAdded = [...new Set([...addedNodes.flatMap((node) => node.effects), ...changedNodes.flatMap((node) => node.effectsAdded)])];
  const triggerParamsChanged = !same(before.triggerParams ?? [], after.triggerParams ?? []);
  return {
    from: { name: before.name, nodeCount: before.nodes.length, edgeCount: before.edges.length },
    to: { name: after.name, nodeCount: after.nodes.length, edgeCount: after.edges.length },
    addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, triggerParamsChanged, riskEffectsAdded,
    hasChanges: addedNodes.length > 0 || removedNodes.length > 0 || changedNodes.length > 0 || addedEdges.length > 0 || removedEdges.length > 0 || triggerParamsChanged,
  };
}
