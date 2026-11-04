import type { WorkflowNode, WorkflowEdge } from "./types";

const ORIGIN_X = 80;
const ORIGIN_Y = 80;
// 2026-07-21 使用者實測後明確要的排法(直接依他截圖裡的真實座標核對出來的規律)：
// 執行順序上每一步都跟前一步「左右錯開一小段＋上下交錯」，連續不斷往右延伸，不折行。
// 這不是「欄數太多才折成蛇形」，是每一步都這樣錯位——步距／交錯幅度就是照他截圖裡
// 真實存在的節點量出來的(trigger→readPeriod→calcDates→readReportWindow→calcReportDate
// 之間 dx≈108~113、dy≈125~129)。
const STEP_X = 115;
const SWING_Y = 130;

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

/** 依執行順序把每一步左右錯開、上下交錯，連續往右延伸，不折行(見上方 STEP_X/SWING_Y 說明)。 */
function zigzagLayout(order: string[]): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  order.forEach((id, index) => {
    pos[id] = { x: ORIGIN_X + index * STEP_X, y: ORIGIN_Y + (index % 2 === 0 ? 0 : SWING_Y) };
  });
  return pos;
}

/** 2026-07-14 版本用過的單一橫排座標；現在改當作「舊排法」，只用於辨識並升級既有畫布。 */
function oldSingleRowLayout(order: string[]): Record<string, { x: number; y: number }> {
  const OLD_COL_GAP = 215;
  const pos: Record<string, { x: number; y: number }> = {};
  order.forEach((id, index) => {
    pos[id] = { x: ORIGIN_X + index * OLD_COL_GAP, y: ORIGIN_Y };
  });
  return pos;
}

/** 更早期版本用過的座標，只用於精準辨識並升級既有自動排列。 */
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
 * 依實際執行順序(拓樸排序)把每一個節點都錯開排列，連續往右延伸、不折行；有真正分支
 * (同時有多個節點準備好執行)時，這些節點依序排在拓樸序裡、各自佔自己的一步，一樣左右
 * 錯開＋上下交錯，不特別把它們疊在同一欄——這樣不會有「同一欄裡哪個節點才是接續下一步」
 * 的對齊問題，也不會有蛇形折行時線斜插過不相干節點的風險(2026-07-21 都實測踩過)。
 *
 * 有真正分支(一個節點同時有多個孩子)時，不能把每個孩子都硬塞進同一條錯位序列——
 * 那樣同一個分岔點的孩子會被拆到序列裡不相鄰的位置，連線得跨過中間不相干的節點
 * (2026-07-21 用真實流程「依檔案格式分流」三條分支實測踩過)。改成先走出一條「主幹」：
 * 每次分岔優先挑「還有下游」的那個孩子繼續走主幹，其餘孩子(通常是死路分支)不佔用
 * 主幹的序列位置，另外貼在它們主幹上的父節點旁邊。最後統一過一次
 * separateOverlappingNodes 當保險，不靠手動量的偏移量猜對，實際重疊了就會自動錯開。
 */
export function autoLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): Record<string, { x: number; y: number }> {
  const ids = nodes.map((n) => n.id);
  const outAdj = new Map(ids.map((id) => [id, [] as string[]]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) {
    if (!indeg.has(e.to) || !outAdj.has(e.from)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    outAdj.get(e.from)!.push(e.to);
  }

  const starts = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const trunk: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = starts[0] ?? ids[0];
  while (current && !visited.has(current)) {
    trunk.push(current);
    visited.add(current);
    const children: string[] = outAdj.get(current) ?? [];
    const withDownstream: string | undefined = children.find((c) => !visited.has(c) && (outAdj.get(c)?.length ?? 0) > 0);
    const next: string | undefined = withDownstream ?? children.find((c) => !visited.has(c));
    current = next;
  }
  const trunkSet = new Set(trunk);
  const pos: Record<string, { x: number; y: number }> = {};
  trunk.forEach((id, index) => {
    pos[id] = { x: ORIGIN_X + index * STEP_X, y: ORIGIN_Y + (index % 2 === 0 ? 0 : SWING_Y) };
  });

  // 側枝(分岔點裡沒被選為主幹的孩子，包含這條分支底下再展開的節點)：貼在它已經有
  // 位置的父節點右邊，交錯遠離主幹本身、彼此也錯開，避免疊在一起或疊到主幹下一步。
  const sideQueue = ids.filter((id) => !trunkSet.has(id));
  const sideOffsetUsed = new Map<string, number>();
  let guard = 0;
  while (sideQueue.length && guard++ < ids.length * ids.length + 10) {
    const id = sideQueue.shift()!;
    const parentId = edges.find((e) => e.to === id && pos[e.from])?.from;
    if (!parentId) { sideQueue.push(id); continue; }
    const parentPos = pos[parentId];
    const used = sideOffsetUsed.get(parentId) ?? 0;
    sideOffsetUsed.set(parentId, used + 1);
    const direction = used % 2 === 0 ? 1 : -1;
    const magnitude = Math.floor(used / 2) + 2; // 至少隔開 2 個 SWING_Y，不會跟主幹下一步的位置擠在一起
    pos[id] = { x: parentPos.x + STEP_X, y: parentPos.y + direction * magnitude * SWING_Y };
  }
  // 真正孤立/找不到已定位父節點的節點(多個獨立起點、環)：接在主幹尾端，至少不遺漏。
  let tailIndex = trunk.length;
  for (const id of ids) if (!pos[id]) pos[id] = { x: ORIGIN_X + tailIndex * STEP_X, y: ORIGIN_Y + (tailIndex++ % 2 === 0 ? 0 : SWING_Y) };

  const { positions } = separateOverlappingNodes(ids.map((id) => ({ id, type: "", label: "", config: {}, position: pos[id] })));
  return positions;
}

/**
 * 曾經發布過的幾種舊排法都只精準辨識確定的歷史自動座標，升級成現在的錯位排法；
 * 使用者自己排的多列位置完全不碰。
 */
export function compactLegacyLongChain(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Record<string, { x: number; y: number }> | null {
  const order = simpleChainSequence(nodes, edges);
  if (!order) return null;
  const desired = zigzagLayout(order);
  if (nodes.every((node) => node.position?.x === desired[node.id]?.x && node.position?.y === desired[node.id]?.y)) return null;

  // 精準辨識所有曾發布過的舊排法，全部升級成現在的排法。
  const singleRow = oldSingleRowLayout(order);
  if (nodes.every((node) => node.position?.x === singleRow[node.id]?.x && node.position?.y === singleRow[node.id]?.y)) {
    return desired;
  }
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
  // 曾經由系統產生過的單列長鏈同步到目前的排法；不碰使用者自己排成多列的圖。
  return width > 310 * 5 && height < 150 ? desired : null;
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
