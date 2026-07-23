import type { WorkflowEdge, WorkflowNode } from "./types";
import { DRY_RUN_SKIPPED_WRITES_KEY } from "./dryRun";

/**
 * 「從這一步開始測」與「續跑」共用的純函式。
 * 使用者常常只是在流程尾巴加了新的一段(例如去簡報按重新整理)，只想確認新段能不能跑——
 * 不該被迫每次都從頭把登入/抓信/填表整條跑一遍。
 */

/** 起點 + 它的所有下游(BFS)。這個集合以外的節點一律沿用舊結果或跳過,不重新執行。 */
export function downstreamNodeIds(edges: WorkflowEdge[], startNodeId: string): string[] {
  const outAdj = new Map<string, string[]>();
  for (const e of edges) outAdj.set(e.from, [...(outAdj.get(e.from) ?? []), e.to]);
  const rerun = new Set<string>([startNodeId]);
  const bfs = [startNodeId];
  while (bfs.length) {
    for (const next of outAdj.get(bfs.shift()!) ?? []) {
      if (!rerun.has(next)) { rerun.add(next); bfs.push(next); }
    }
  }
  return [...rerun];
}

/** node_runs 一列(只取這裡用得到的欄位) */
export interface RunSeedRow {
  node_id: string;
  status: string;
  input_json: string | null;
  output_json: string | null;
  active_ports: string | null;
}

export interface RunSeeds {
  /** nodeId → 上次的合併輸出({...input,...output})，沿用節點直接拿這份餵下游 */
  seeds: Record<string, Record<string, unknown>>;
  /** 沿用節點上次選中的分支 port(if/switch)，不重放的話下游分支邏輯全失效 */
  seedPorts: Record<string, string[]>;
}

/**
 * 從某次執行的 node_runs 萃取「成功節點的合併輸出 + 選過的分支」。
 * resumeRun(失敗續跑/簽核恢復)與 startWorkflowRun 的 startAtNodeId(從中段起跑)共用，
 * active_ports 舊資料反推規則只能有這一份，兩邊才不會漂移。
 */
export function collectRunSeeds(nodes: WorkflowNode[], rows: RunSeedRow[]): RunSeeds {
  const parse = (s: string | null): Record<string, unknown> => {
    try { return s ? (JSON.parse(s) as Record<string, unknown>) : {}; } catch { return {}; }
  };
  const seeds: Record<string, Record<string, unknown>> = {};
  const seedPorts: Record<string, string[]> = {};
  const nodeTypeById = new Map(nodes.map((n) => [n.id, n.type]));
  for (const r of rows) {
    if (r.status !== "success") continue;
    const output = parse(r.output_json);
    // 這個標記代表「表面上 status=success，其實 custom-code 自己偵測到會寫出、內部攔下沒真的寫」
    // (只讀試跑常見)。這種假成功絕不能被之後的正式執行拿去當種子沿用——沿用等於讓真正的寫入
    // 永遠不會發生，卻整條 run 回報成功。沒有種子時這個節點會老實標記跳過，比假裝已完成安全。
    if (output[DRY_RUN_SKIPPED_WRITES_KEY]) continue;
    seeds[r.node_id] = { ...parse(r.input_json), ...output };
    if (r.active_ports) {
      try { seedPorts[r.node_id] = JSON.parse(r.active_ports) as string[]; } catch { /* 壞資料當沒有 */ }
    } else {
      // 舊資料沒存 active_ports：分支節點從輸出反推(if 的 result / switch 的 matched)，反推不出就不放
      const out = parse(r.output_json);
      const t = nodeTypeById.get(r.node_id);
      if (t === "if-condition" && typeof out.result === "boolean") seedPorts[r.node_id] = [out.result ? "true" : "false"];
      if (t === "switch" && typeof out.matched === "string") seedPorts[r.node_id] = [out.matched];
    }
  }
  return { seeds, seedPorts };
}
