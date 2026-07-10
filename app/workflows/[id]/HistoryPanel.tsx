"use client";

import { useState } from "react";
import { formatDate } from "@/components/ui";
import { statusColor } from "./nodeVisuals";
import type { RunRecord } from "./types";

export function HistoryPanel({
  runs,
  onClose,
  onPickFailedNode,
}: {
  runs: RunRecord[];
  onClose: () => void;
  onPickFailedNode: (nodeId: string, runId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ id: number; node_id: string | null; ts: string; line: string }[] | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  async function toggleLogs(runId: string) {
    if (expanded === runId) { setExpanded(null); return; }
    setExpanded(runId);
    setLogs(null);
    setLogsLoading(true);
    try {
      const data = await (await fetch(`/api/runs/${runId}`)).json();
      setLogs(data.logs ?? []);
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
                <span className="text-xs faint">{r.trigger_type === "schedule" ? "排程" : "手動"}</span>
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
                <div className="rounded-md p-2 text-xs font-mono max-h-64 overflow-auto" style={{ background: "var(--surface-2)" }}>
                  {logsLoading && <p className="muted">載入中…</p>}
                  {!logsLoading && logs?.length === 0 && <p className="muted">這次執行沒有留下過程紀錄。</p>}
                  {!logsLoading && logs?.map((l) => (
                    <div key={l.id} className="whitespace-pre-wrap leading-relaxed">
                      <span className="faint">{l.ts.slice(11, 19)}</span> {l.line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
