"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, StatusDot, statusLabel, formatDate, EmptyState } from "@/components/ui";

/** 全域執行紀錄:所有流程的歷史執行一頁看完(以前只能一條一條點進去翻) */

interface GlobalRun {
  id: string;
  workflow_id: string;
  workflow_name: string;
  status: string;
  trigger_type: string;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
}

const TRIGGER_LABEL: Record<string, string> = {
  manual: "手動", schedule: "排程", watch: "資料夾監聽", webhook: "Webhook", form: "表單", error: "錯誤觸發",
};
const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "success", label: "成功" },
  { key: "failed", label: "失敗" },
  { key: "waiting", label: "⏸ 等簽核" },
  { key: "active", label: "進行中" },
];

export default function RunsPage() {
  const [runs, setRuns] = useState<GlobalRun[] | null>(null);
  const [error, setError] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/runs");
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (alive) { setRuns(data.runs ?? []); setError(false); }
      } catch {
        if (alive) setError(true);
      }
    };
    load();
    const t = setInterval(load, 8000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (runs ?? []).filter((r) => {
      if (statusFilter === "active" ? !["running", "queued"].includes(r.status) : statusFilter !== "all" && r.status !== statusFilter) return false;
      if (q && !r.workflow_name.toLowerCase().includes(q) && !(r.reason ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [runs, statusFilter, search]);

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      <PageHeader title="執行紀錄" subtitle="所有流程的歷史執行一頁看完;點任一筆進流程頁看逐步細節" />

      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 搜尋流程名稱/原因…" className="input text-sm max-w-[260px]" aria-label="搜尋執行紀錄" />
        <div className="flex items-center gap-1.5 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button key={f.key} onClick={() => setStatusFilter(f.key)} className="btn btn-ghost text-xs" style={statusFilter === f.key ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm" style={{ color: "var(--red)" }}>載入失敗,稍後會自動重試。</p>}
      {runs === null && !error && <p className="text-sm muted">載入中…</p>}
      {runs !== null && visible.length === 0 && (
        <EmptyState icon="☰" title="沒有符合條件的執行紀錄" hint="流程執行過後,每一筆都會出現在這裡(每條流程保留最近 20 筆)。" />
      )}

      <div className="space-y-2">
        {visible.map((r) => (
          <Link key={r.id} href={`/workflows/${r.workflow_id}`} className="card card-hover p-3.5 flex items-center gap-3 block">
            <StatusDot status={r.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium truncate">{r.workflow_name}</span>
                <span className="badge badge-neutral shrink-0">{TRIGGER_LABEL[r.trigger_type] ?? r.trigger_type}</span>
                <span className="shrink-0 text-xs" style={{ color: r.status === "failed" ? "var(--red)" : r.status === "success" ? "var(--green)" : "var(--amber)" }}>
                  {statusLabel(r.status)}
                </span>
              </div>
              {r.reason && <p className="text-xs muted mt-0.5 truncate">{r.reason}</p>}
            </div>
            <span className="text-xs faint shrink-0">{formatDate(r.started_at)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
