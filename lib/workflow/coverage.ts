import { getDb } from "../db";
import { getWorkflow } from "./store";
import type { WorkflowNode, WorkflowEdge } from "./types";

/**
 * 分支覆蓋率(GPT 體檢 #4):複雜流程「成功跑過一次」只證明其中一條路能走。
 * 這裡對照「圖上有哪些分支出口」vs「歷史執行真的走過哪些」,讓使用者知道
 * 拒絕路徑/失敗分支到底驗過了沒——全部走過才敢說「完整驗證」。
 */

export interface BranchPortCoverage {
  nodeId: string;
  nodeLabel: string;
  port: string;
  /** 給人看的出口名(核准/拒絕/出錯時/選項文字…) */
  portLabel: string;
  covered: boolean;
}

export interface CoverageReport {
  total: number;
  covered: number;
  /** 只有 total>0 且全蓋才 true(沒有分支的線性流程回 false,由 UI 決定顯示「無分支」) */
  complete: boolean;
  ports: BranchPortCoverage[];
}

function portLabel(port: string): string {
  if (port === "true") return "是";
  if (port === "false") return "否";
  if (port === "approved") return "✅ 核准";
  if (port === "rejected") return "❌ 拒絕";
  if (port === "error") return "🆘 出錯時";
  return port;
}

/** 純函式:從圖+「歷史走過的 (nodeId, port) 集合」算覆蓋(可單元測試) */
export function computeCoverage(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  seen: Set<string>, // `${nodeId} ${port}`
): CoverageReport {
  const labelById = new Map(nodes.map((n) => [n.id, n.label]));
  const ports: BranchPortCoverage[] = [];
  const dedup = new Set<string>();
  for (const e of edges) {
    if (!e.fromPort) continue; // 沒標 port 的一般連線不是「分支出口」
    const key = `${e.from} ${e.fromPort}`;
    if (dedup.has(key)) continue;
    dedup.add(key);
    ports.push({
      nodeId: e.from,
      nodeLabel: labelById.get(e.from) ?? e.from,
      port: e.fromPort,
      portLabel: portLabel(e.fromPort),
      covered: seen.has(key),
    });
  }
  const covered = ports.filter((p) => p.covered).length;
  return { total: ports.length, covered, complete: ports.length > 0 && covered === ports.length, ports };
}

/** 查這條流程的歷史執行,收集每個分支節點實際走過的 port(node_runs.active_ports) */
export function getWorkflowCoverage(workflowId: string): CoverageReport | null {
  const wf = getWorkflow(workflowId);
  if (!wf) return null;
  const rows = getDb()
    .prepare(
      `SELECT nr.node_id, nr.active_ports FROM node_runs nr
       JOIN runs r ON r.id = nr.run_id
       WHERE r.workflow_id = ? AND nr.active_ports IS NOT NULL`,
    )
    .all(workflowId) as { node_id: string; active_ports: string }[];
  const seen = new Set<string>();
  for (const r of rows) {
    try {
      for (const p of JSON.parse(r.active_ports) as string[]) seen.add(`${r.node_id} ${p}`);
    } catch { /* 壞資料略過 */ }
  }
  return computeCoverage(wf.nodes, wf.edges, seen);
}
