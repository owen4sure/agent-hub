import type { WorkflowNode, WorkflowEdge } from "./types";

const COL_GAP = 215; // n8n 式緊湊節點寬 170px，保留 45px 給連線、箭頭與插入按鈕
const ROW_GAP = 150; // 主線可緊湊，但分支上下仍要保留清楚且不重疊的安全距離
const ORIGIN_X = 80;
const ORIGIN_Y = 80;

/** 單一長鏈的真實執行順序；有分支、匯流、環或少於 7 步時回 null。 */
export function simpleChainSequence(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] | null {
  if (nodes.length < 7 || edges.length !== nodes.length - 1) return null;
  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) return null;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  if ([...incoming.values()].some((count) => count > 1) || [...outgoing.values()].some((list) => list.length > 1)) return null;
  const starts = nodes.filter((node) => incoming.get(node.id) === 0);
  if (starts.length !== 1) return null;
  const order: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = starts[0].id;
  while (current && !seen.has(current)) {
    order.push(current);
    seen.add(current);
    current = outgoing.get(current)?.[0];
  }
  return order.length === nodes.length ? order : null;
}

function horizontalLongChainLayout(order: string[]): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  order.forEach((id, index) => {
    // 長流程不再為了「全塞進一個 viewport」折成蛇形；固定左→右，閱讀方向與執行方向完全一致。
    pos[id] = { x: ORIGIN_X + index * COL_GAP, y: ORIGIN_Y };
  });
  return pos;
}

/** 2026-07-14 早期版本用過的座標，只用於精準辨識並升級既有自動排列。 */
function legacySnakeLayout(
  order: string[],
  columns: number,
  colGap = 310,
  rowGap = 155,
): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  order.forEach((id, index) => {
    const row = Math.floor(index / columns);
    const inRow = index % columns;
    const column = row % 2 === 0 ? inRow : columns - 1 - inRow;
    pos[id] = { x: ORIGIN_X + column * colGap, y: ORIGIN_Y + row * rowGap };
  });
  return pos;
}

/**
 * 由左到右的分層排列(像 n8n)：
 * - 欄(column) = 從起點算起的「最長路徑深度」，確保上游一定在左邊。
 * - 同一欄內的節點垂直等距排開、置中對齊。
 * 回傳每個 node 的新 position，整齊、對齊、標準化。
 */
export function autoLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): Record<string, { x: number; y: number }> {
  const chain = simpleChainSequence(nodes, edges);
  if (chain) return horizontalLongChainLayout(chain);

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

/**
 * 曾經把長流程折成兩／三欄蛇形，數字上不重疊但閱讀方向左右折返、窄畫面還會上下裁切。
 * 只辨識確定的歷史自動座標，升級成單一左→右流程線；使用者自己排的多列位置完全不碰。
 */
export function compactLegacyLongChain(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Record<string, { x: number; y: number }> | null {
  const order = simpleChainSequence(nodes, edges);
  if (!order) return null;
  const desired = horizontalLongChainLayout(order);
  if (nodes.every((node) => node.position?.x === desired[node.id]?.x && node.position?.y === desired[node.id]?.y)) return null;

  // 精準辨識所有曾發布過的蛇形自動座標，全部升級成單向流程線。
  const threeColumn = legacySnakeLayout(order, 3);
  if (nodes.every((node) => node.position?.x === threeColumn[node.id]?.x && node.position?.y === threeColumn[node.id]?.y)) {
    return desired;
  }
  const narrowTwoColumn = legacySnakeLayout(order, 2);
  if (nodes.every((node) => node.position?.x === narrowTwoColumn[node.id]?.x && node.position?.y === narrowTwoColumn[node.id]?.y)) {
    return desired;
  }
  const roomyTwoColumn155 = legacySnakeLayout(order, 2, 380, 155);
  const roomyTwoColumn150 = legacySnakeLayout(order, 2, 380, 150);
  const fittedTwoColumn150 = legacySnakeLayout(order, 2, 360, 150);
  if ([roomyTwoColumn155, roomyTwoColumn150, fittedTwoColumn150].some((legacy) =>
    nodes.every((node) => node.position?.x === legacy[node.id]?.x && node.position?.y === legacy[node.id]?.y)
  )) {
    return desired;
  }
  const xs = nodes.map((node) => node.position?.x).filter(Number.isFinite) as number[];
  const ys = nodes.map((node) => node.position?.y).filter(Number.isFinite) as number[];
  if (xs.length !== nodes.length || ys.length !== nodes.length) return desired;
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  // 曾經由系統產生過的單列長鏈同步到目前的緊湊欄距；不碰使用者自己排成多列的圖。
  return width > 310 * 5 && height < ROW_GAP ? desired : null;
}

const NODE_WIDTH = 190;
const NODE_HEIGHT = 105;
const COLLISION_GAP = 20;

/**
 * 保留現有排列意圖，只把真正重疊的節點往下錯開。
 * 用固定的保守卡片尺寸做確定性檢查，不依賴瀏覽器量測，server/client 都可共用。
 */
export function separateOverlappingNodes(nodes: WorkflowNode[]): { positions: Record<string, { x: number; y: number }>; changed: boolean } {
  const placed: { id: string; x: number; y: number }[] = [];
  const positions: Record<string, { x: number; y: number }> = {};
  let changed = false;
  for (const node of nodes) {
    const x = Number.isFinite(node.position?.x) ? node.position.x : ORIGIN_X;
    let y = Number.isFinite(node.position?.y) ? node.position.y : ORIGIN_Y;
    let guard = 0;
    while (guard++ < nodes.length + 2) {
      const conflicts = placed.filter((p) =>
        Math.abs(x - p.x) < NODE_WIDTH + COLLISION_GAP && Math.abs(y - p.y) < NODE_HEIGHT + COLLISION_GAP,
      );
      if (!conflicts.length) break;
      y = Math.max(...conflicts.map((p) => p.y + NODE_HEIGHT + COLLISION_GAP));
    }
    if (x !== node.position?.x || y !== node.position?.y) changed = true;
    positions[node.id] = { x, y };
    placed.push({ id: node.id, x, y });
  }
  return { positions, changed };
}
