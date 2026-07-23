"use client";

import { useEffect, useState } from "react";
import { formatDate } from "@/components/ui";
import { statusColor } from "./nodeVisuals";
import type { RunRecord } from "./types";

interface CoverageReport {
  total: number;
  covered: number;
  complete: boolean;
  ports: { nodeId: string; nodeLabel: string; port: string; portLabel: string; covered: boolean }[];
}

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
  focusRunId,
  onClose,
  onPickFailedNode,
  onResume,
}: {
  runs: RunRecord[];
  /** node id → 顯示名稱(時間線用；找不到就顯示原 id) */
  nodeLabels: Record<string, string>;
  /** 從全域執行紀錄點進來時，直接展開那一筆，而不是只落在流程首頁。 */
  focusRunId?: string | null;
  onClose: () => void;
  onPickFailedNode: (nodeId: string, runId: string) => void;
  /** 失敗的執行「從失敗那步續跑」(前面成功的步驟沿用上次結果) */
  onResume: (runId: string) => Promise<string | null>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ id: number; node_id: string | null; ts: string; line: string }[] | null>(null);
  const [nodeRuns, setNodeRuns] = useState<NodeRunRow[] | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [resuming, setResuming] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<{ runId: string; msg: string } | null>(null);
  // 分支覆蓋率:圖上的每個分支出口歷史上走過了沒——「成功一次」只證明一條路能走
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  useEffect(() => {
    let alive = true;
    const wfId = window.location.pathname.split("/workflows/")[1]?.split("/")[0];
    if (!wfId) return;
    fetch(`/api/workflows/${wfId}/coverage`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d && typeof d.total === "number") setCoverage(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [runs.length]);

  useEffect(() => {
    if (!focusRunId) return;
    let alive = true;
    queueMicrotask(() => { if (alive) { setExpanded(focusRunId); setLogsLoading(true); setLogs(null); setNodeRuns(null); } });
    fetch(`/api/runs/${focusRunId}`)
      .then(async (r) => r.ok ? r.json() : Promise.reject(new Error()))
      .then((data) => { if (alive) { setLogs(data.logs ?? []); setNodeRuns(data.nodeRuns ?? []); } })
      .catch(() => { if (alive) { setLogs([]); setNodeRuns([]); } })
      .finally(() => { if (alive) setLogsLoading(false); });
    return () => { alive = false; };
  }, [focusRunId]);

  async function handleResume(runId: string) {
    setResuming(runId);
    setResumeError(null);
    try {
      const err = await onResume(runId);
      if (err) setResumeError({ runId, msg: err });
    } finally {
      setResuming(null);
    }
  }

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
        {coverage && coverage.total > 0 && (
          <div className="card p-3 space-y-1.5" style={coverage.complete ? { borderColor: "color-mix(in srgb, var(--green) 45%, var(--border))" } : undefined}>
            <p className="text-xs font-medium flex items-center gap-2">
              🧪 分支覆蓋
              <span className="badge" style={coverage.complete ? { color: "var(--green)", borderColor: "var(--green)" } : { color: "var(--amber)", borderColor: "var(--amber)" }}>
                {coverage.complete ? "完整驗證" : `${coverage.covered}/${coverage.total} 已走過`}
              </span>
            </p>
            {!coverage.complete && (
              <>
                <p className="text-[11px] faint leading-relaxed">成功一次只代表其中一條路能跑——下面「○」的分支還沒被任何一次執行走過,建議做出對應情境測一下(例如按拒絕、給超標的金額)。</p>
                <div className="space-y-0.5">
                  {coverage.ports.map((p) => (
                    <div key={`${p.nodeId}-${p.port}`} className="flex items-center gap-2 text-xs">
                      <span style={{ color: p.covered ? "var(--green)" : "var(--text-faint)" }}>{p.covered ? "✓" : "○"}</span>
                      <span className="truncate">{p.nodeLabel}</span>
                      <span className="faint">→ {p.portLabel}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {runs.length === 0 && <p className="text-sm muted">還沒有執行紀錄。按「▶ 執行」跑一次就會出現在這。</p>}
        {runs.map((r) => {
          const failed = r.status === "failed";
          const success = r.status === "success";
          const waiting = r.status === "waiting";
          return (
            <div key={r.id} className="card p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColor(r.status) }} />
                <span className="text-sm font-medium">{success ? "成功" : failed ? "失敗" : waiting ? "⏸ 等簽核中" : r.status === "running" || r.status === "queued" ? "執行中" : r.status}</span>
                <span className="text-xs faint">{r.trigger_type === "schedule" ? "排程" : r.trigger_type === "watch" ? "資料夾監聽" : r.trigger_type === "webhook" ? "Webhook" : r.trigger_type === "form" ? "表單" : r.trigger_type === "error" ? "錯誤觸發" : r.trigger_type === "email" ? "收信觸發" : r.trigger_type === "telegram" ? "Telegram 訊息" : r.trigger_type === "line" ? "LINE 訊息" : r.trigger_type === "retry" ? "失敗自動重跑" : "手動"}</span>
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
              <div className="flex items-center gap-2 flex-wrap">
                {failed && r.resolution === "ai-fixable" && r.failed_node && (
                  <button onClick={() => onPickFailedNode(r.failed_node!, r.id)} className="btn btn-ghost text-xs mt-1">
                    🔧 去修這一步
                  </button>
                )}
                {failed && r.failed_node && (
                  <button
                    onClick={() => handleResume(r.id)}
                    disabled={resuming === r.id}
                    className="btn btn-ghost text-xs mt-1"
                    title="前面成功的步驟沿用上次結果，只從失敗那步接著跑(需要登入狀態的部分會自動一併重跑)"
                  >
                    {resuming === r.id ? "續跑中…" : "▶ 從失敗那步續跑"}
                  </button>
                )}
                <button onClick={() => toggleLogs(r.id)} className="btn btn-ghost text-xs mt-1">
                  {expanded === r.id ? "收起過程" : "看逐步過程"}
                </button>
              </div>
              {resumeError?.runId === r.id && (
                <p className="text-xs" style={{ color: "var(--red)" }}>{resumeError.msg}</p>
              )}
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
