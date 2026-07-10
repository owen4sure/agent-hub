"use client";

import { useState } from "react";
import { formatDate } from "@/components/ui";
import { statusColor } from "./nodeVisuals";
import type { RunRecord } from "./types";

interface NodeRunRow { node_id: string; status: string; attempt: number; started_at: string | null; finished_at: string | null }

/** sqlite 的 "YYYY-MM-DD HH:MM:SS" 對算秒差(兩個都同一格式，時區一致，差值正確) */
function durationSec(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = new Date(b.replace(" ", "T")).getTime() - new Date(a.replace(" ", "T")).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}
const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : s >= 10 ? `${Math.round(s)}秒` : `${s.toFixed(1)}秒`);

export function HistoryPanel({
  runs,
  nodeLabels,
  onClose,
  onPickFailedNode,
}: {
  runs: RunRecord[];
  /** node id → 顯示名稱(時間線用；找不到就顯示原 id) */
  nodeLabels: Record<string, string>;
  onClose: () => void;
  onPickFailedNode: (nodeId: string, runId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ id: number; node_id: string | null; ts: string; line: string }[] | null>(null);
  const [nodeRuns, setNodeRuns] = useState<NodeRunRow[] | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  async function toggleLogs(runId: string) {
    if (expanded === runId) { setExpanded(null); return; }
    setExpanded(runId);
    setLogs(null);
    setNodeRuns(null);
    setLogsLoading(true);
    try {
      const data = await (await fetch(`/api/runs/${runId}`)).json();
      setLogs(data.logs ?? []);
      setNodeRuns(data.nodeRuns ?? []);
    } finally {
      setLogsLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-5 border-b flex items-center gap-2">
        <span className="text-sm font-medium">📋 執行紀錄</span>
        <span className="badge badge-neutral">最近 {runs.length}</span>
        <button onClick={onClose} className="ml-auto faint hover:text-[var(--text)]">✕</button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-2.5">
        {runs.length === 0 && <p className="text-sm muted">還沒有執行紀錄。按「▶ 執行」跑一次就會出現在這。</p>}
        {runs.map((r) => {
          const failed = r.status === "failed";
          const success = r.status === "success";
          return (
            <div key={r.id} className="card p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColor(r.status) }} />
                <span className="text-sm font-medium">{success ? "成功" : failed ? "失敗" : r.status === "running" || r.status === "queued" ? "執行中" : r.status}</span>
                <span className="text-xs faint">{r.trigger_type === "schedule" ? "排程" : r.trigger_type === "watch" ? "資料夾監聽" : r.trigger_type === "webhook" ? "Webhook" : "手動"}</span>
                <span className="ml-auto text-xs faint">{formatDate(r.started_at)}</span>
              </div>
              {failed && (
                <div className="flex items-center gap-1.5">
                  {r.resolution === "ai-fixable" ? (
                    <span className="badge badge-accent">🤖 AI 可修</span>
                  ) : (
                    <span className="badge badge-amber">🙋 需人工處理</span>
                  )}
                </div>
              )}
              {r.reason && <p className="text-xs muted leading-relaxed">{r.reason}</p>}
              <div className="flex items-center gap-2">
                {failed && r.resolution === "ai-fixable" && r.failed_node && (
                  <button onClick={() => onPickFailedNode(r.failed_node!, r.id)} className="btn btn-ghost text-xs mt-1">
                    🔧 去修這一步
                  </button>
                )}
                <button onClick={() => toggleLogs(r.id)} className="btn btn-ghost text-xs mt-1">
                  {expanded === r.id ? "收起過程" : "看逐步過程"}
                </button>
              </div>
              {expanded === r.id && (
                <>
                  {/* 逐節點時間線：每步花多久一眼看完(比例條以最慢那步為 100%)——慢在哪一步不用去翻日誌 */}
                  {!logsLoading && nodeRuns && nodeRuns.length > 0 && (() => {
                    const withDur = nodeRuns.map((n) => ({ ...n, dur: durationSec(n.started_at, n.finished_at) }));
                    const max = Math.max(...withDur.map((n) => n.dur ?? 0), 0.001);
                    return (
                      <div className="rounded-md p-2 space-y-1" style={{ background: "var(--surface-2)" }}>
                        {withDur.map((n, i) => (
                          <div key={`${n.node_id}-${i}`} className="flex items-center gap-2 text-xs">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor(n.status) }} />
                            <span className="truncate w-28 shrink-0" title={nodeLabels[n.node_id] ?? n.node_id}>{nodeLabels[n.node_id] ?? n.node_id}</span>
                            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface)" }}>
                              {n.dur !== null && (
                                <div className="h-full rounded-full" style={{ width: `${Math.max((n.dur / max) * 100, 2)}%`, background: statusColor(n.status), opacity: 0.75 }} />
                              )}
                            </div>
                            <span className="faint shrink-0 w-14 text-right">{n.dur !== null ? fmtSec(n.dur) : "—"}</span>
                            {n.attempt > 1 && <span className="faint shrink-0" title={`重試了 ${n.attempt - 1} 次`}>×{n.attempt}</span>}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  <div className="rounded-md p-2 text-xs font-mono max-h-64 overflow-auto" style={{ background: "var(--surface-2)" }}>
                    {logsLoading && <p className="muted">載入中…</p>}
                    {!logsLoading && logs?.length === 0 && <p className="muted">這次執行沒有留下過程紀錄。</p>}
                    {!logsLoading && logs?.map((l) => (
                      <div key={l.id} className="whitespace-pre-wrap leading-relaxed">
                        <span className="faint">{l.ts.slice(11, 19)}</span> {l.line}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
