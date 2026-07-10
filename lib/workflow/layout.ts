import type { WorkflowNode, WorkflowEdge } from "./types";

const COL_GAP = 260; // 每一「欄」(執行深度)的水平間距
const ROW_GAP = 130; // 同一欄內節點的垂直間距
const ORIGIN_X = 80;
const ORIGIN_Y = 80;

/**
 * 由左到右的分層排列(像 n8n)：
 * - 欄(column) = 從起點算起的「最長路徑深度」，確保上游一定在左邊。
 * - 同一欄內的節點垂直等距排開、置中對齊。
 * 回傳每個 node 的新 position，整齊、對齊、標準化。
 */
export function autoLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): Record<string, { x: number; y: number }> {
  const ids = nodes.map((n) => n.id);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const outAdj = new Map(ids.map((id) => [id, [] as string[]]));
  for (const e of edges) {
    if (!indeg.has(e.to) || !outAdj.has(e.from)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    outAdj.get(e.from)!.push(e.to);
  }

  // 最長路徑深度(拓樸)決定欄位
  const depth = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const localIndeg = new Map(indeg);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const nxt of outAdj.get(id) ?? []) {
      depth.set(nxt, Math.max(depth.get(nxt) ?? 0, (depth.get(id) ?? 0) + 1));
      localIndeg.set(nxt, (localIndeg.get(nxt) ?? 1) - 1);
      if ((localIndeg.get(nxt) ?? 0) <= 0) queue.push(nxt);
    }
  }
  // 有環或孤立節點：附到最後一欄
  for (const id of ids) if (!order.includes(id)) depth.set(id, Math.max(0, ...ids.map((x) => depth.get(x) ?? 0)) + 1);

  // 依欄分組
  const byCol = new Map<number, string[]>();
  for (const id of ids) {
    const c = depth.get(id) ?? 0;
    if (!byCol.has(c)) byCol.set(c, []);
    byCol.get(c)!.push(id);
  }

  const maxRows = Math.max(...Array.from(byCol.values()).map((a) => a.length), 1);
  const totalHeight = (maxRows - 1) * ROW_GAP;

  const pos: Record<string, { x: number; y: number }> = {};
  for (const [col, colIds] of Array.from(byCol.entries()).sort((a, b) => a[0] - b[0])) {
    const colHeight = (colIds.length - 1) * ROW_GAP;
    const startY = ORIGIN_Y + (totalHeight - colHeight) / 2; // 每欄置中對齊
    colIds.forEach((id, row) => {
      pos[id] = { x: ORIGIN_X + col * COL_GAP, y: startY + row * ROW_GAP };
    });
  }
  return pos;
}
