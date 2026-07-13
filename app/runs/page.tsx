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
  email: "收信觸發", telegram: "Telegram 訊息", line: "LINE 訊息",
};
const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "success", label: "成功" },
  { key: "failed", label: "失敗" },
  { key: "waiting", label: "⏸ 等簽核" },
  { key: "active", label: "進行中" },
];

/** 狀態 → 左側細條顏色(一眼掃出成功/失敗/等待) */
function railColor(status: string): string {
  return status === "failed" ? "var(--red)"
    : status === "success" ? "var(--green)"
    : status === "waiting" ? "var(--amber)"
    : status === "running" || status === "queued" ? "var(--accent)"
    : "var(--text-faint)";
}

/** 相對時間(剛剛 / N 分鐘前 / N 小時前),超過一天就交給 formatDate 顯示日期 */
function timeAgo(iso: string, now: number): string {
  const t = Date.parse(iso.includes("Z") || iso.includes("+") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  if (diff < 0) return "剛剛";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "剛剛";
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  return "";
}

export default function RunsPage() {
  const [runs, setRuns] = useState<GlobalRun[] | null>(null);
  const [error, setError] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  // 相對時間的基準時間戳,只在 effect(fetch tick)裡更新——不在 render 中呼叫 Date.now()(react 純度規則)
  const [now, setNow] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/runs");
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (alive) { setRuns(data.runs ?? []); setNow(Date.now()); setError(false); }
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

      {/* 連成一張表的活動流:細分隔線 + 左側狀態色條,比一格一格浮卡更好掃、更耐看 */}
      {visible.length > 0 && (
        <div className="card overflow-hidden rise-in">
          {visible.map((r, i) => {
            const rel = timeAgo(r.started_at, now);
            return (
              <Link
                key={r.id}
                href={`/workflows/${r.workflow_id}`}
                className="flex items-center gap-3 pl-4 pr-4 py-3 relative transition-colors hover:bg-[var(--surface-2)]"
                style={{ borderTop: i === 0 ? "none" : "1px solid var(--border)" }}
              >
                <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full" style={{ background: railColor(r.status) }} />
                <StatusDot status={r.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium truncate">{r.workflow_name}</span>
                    <span className="badge badge-neutral shrink-0">{TRIGGER_LABEL[r.trigger_type] ?? r.trigger_type}</span>
                    <span className="shrink-0 text-xs font-medium" style={{ color: railColor(r.status) }}>
                      {statusLabel(r.status)}
                    </span>
                  </div>
                  {r.reason && <p className="text-xs muted mt-0.5 truncate">{r.reason}</p>}
                </div>
                <span className="text-xs faint shrink-0 text-right tabular-nums" title={formatDate(r.started_at)}>
                  {rel || formatDate(r.started_at)}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
