"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader, StatCard, StatusDot, EmptyState, statusLabel, formatDate } from "@/components/ui";

interface WorkflowSummary {
  id: string;
  name: string;
  status: "draft" | "official";
  builtin: boolean;
  description: string;
  nodeCount: number;
  lastRun?: { status: string; started_at: string } | null;
  triggers?: { schedule: boolean; watch: boolean; webhook: boolean };
}
interface Overview {
  officialCount: number;
  draftCount: number;
  todayCounts: Record<string, number>;
  running: { id: string; workflow_id: string; name: string }[];
  recentScheduleFailures: { id: string; workflow_id: string; name: string; reason: string | null; started_at: string }[];
}
interface FixProposal {
  id: string;
  runId: string;
  workflowId: string;
  workflowName: string;
  nodeLabel: string;
  error: string | null;
  createdAt: string;
}

export default function HomePage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);

  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const [dismissedFailures, setDismissedFailures] = useState<string[]>([]);
  const [proposals, setProposals] = useState<FixProposal[]>([]);
  const [applying, setApplying] = useState<Record<string, boolean>>({});
  const [applyResult, setApplyResult] = useState<Record<string, { ok: boolean; error?: string }>>({});

  async function loadProposals() {
    try { setProposals((await (await fetch("/api/fix-proposals")).json()).proposals ?? []); } catch {}
  }

  async function load() {
    try {
      const [w, o] = await Promise.all([fetch("/api/workflows"), fetch("/api/overview")]);
      if (!w.ok || !o.ok) throw new Error();
      setWorkflows((await w.json()).workflows);
      setOverview(await o.json());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }
  useEffect(() => {
    load();
    loadProposals();
    try { setDismissedFailures(JSON.parse(localStorage.getItem("agenthub_dismissed_failures") ?? "[]")); } catch {}
    const t = setInterval(async () => { try { setOverview(await (await fetch("/api/overview")).json()); } catch {} }, 5000);
    return () => clearInterval(t);
  }, []);

  async function applyProposal(id: string) {
    setApplying((a) => ({ ...a, [id]: true }));
    try {
      const res = await (await fetch(`/api/fix-proposals/${id}/apply`, { method: "POST" })).json();
      setApplyResult((r) => ({ ...r, [id]: { ok: !!res.ok, error: res.error } }));
      if (res.ok) {
        setProposals((ps) => ps.filter((p) => p.id !== id));
        load();
      }
    } finally {
      setApplying((a) => ({ ...a, [id]: false }));
    }
  }
  async function dismissProposal(id: string) {
    await fetch(`/api/fix-proposals/${id}/dismiss`, { method: "POST" });
    setProposals((ps) => ps.filter((p) => p.id !== id));
  }

  function dismissFailure(runId: string) {
    const next = [...dismissedFailures, runId];
    setDismissedFailures(next);
    localStorage.setItem("agenthub_dismissed_failures", JSON.stringify(next));
  }

  async function createNew() {
    if (creating) return;
    setCreating(true);
    setCreateError(false);
    try {
      const res = await fetch("/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const data = await res.json();
      if (!res.ok || !data.id) throw new Error();
      router.push(`/workflows/${data.id}`);
    } catch {
      setCreateError(true);
      setCreating(false);
    }
  }

  const [running, setRunning] = useState<Record<string, boolean>>({});
  // 卡片上直接一鍵執行，不用點進去。按了不導頁(擋掉 Link)。
  async function runNow(e: React.MouseEvent, wfId: string) {
    e.preventDefault();
    e.stopPropagation();
    setRunning((r) => ({ ...r, [wfId]: true }));
    try {
      await fetch(`/api/workflows/${wfId}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }) });
    } finally {
      setTimeout(() => { setRunning((r) => ({ ...r, [wfId]: false })); load(); }, 1200);
    }
  }

  const official = workflows?.filter((w) => w.status === "official") ?? [];

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <PageHeader
        title="Workflows"
        subtitle="用白話跟 AI 建立自動化流程，一鍵執行與監控"
        actions={<button onClick={createNew} disabled={creating} className="btn btn-primary">{creating ? "建立中…" : "＋ 新建 workflow"}</button>}
      />
      {loadError && <div className="card px-4 py-3 mb-4 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>載入失敗，請確認伺服器是否正常，<button onClick={load} className="underline">重試</button>。</div>}
      {createError && <div className="card px-4 py-3 mb-4 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>建立失敗，請確認伺服器是否正常後再試一次。</div>}

      {overview && (
        <div className="flex flex-wrap gap-3 mb-6">
          <StatCard label="正式流程" value={overview.officialCount} icon="◈" tone="accent" />
          <StatCard label="草稿" value={overview.draftCount} icon="✎" />
          <StatCard label="今日成功" value={overview.todayCounts.success ?? 0} tone="green" icon="✓" />
          <StatCard label="今日失敗" value={overview.todayCounts.failed ?? 0} tone={overview.todayCounts.failed ? "red" : undefined} icon={overview.todayCounts.failed ? "✕" : "—"} />
        </div>
      )}

      {proposals.length > 0 && (
        <div className="card px-4 py-3 mb-6 space-y-3" style={{ borderColor: "var(--accent)" }}>
          <div className="text-sm font-medium" style={{ color: "var(--accent)" }}>🤖 AI 已經想好怎麼修，一鍵套用+重跑驗證</div>
          {proposals.map((p) => (
            <div key={p.id} className="space-y-1.5">
              <div className="flex items-start gap-2 text-sm">
                <div className="min-w-0 flex-1">
                  <Link href={`/workflows/${p.workflowId}`} className="font-medium hover:underline">{p.workflowName}</Link>
                  <span className="faint"> · 「{p.nodeLabel}」這步 · {formatDate(p.createdAt)}</span>
                  {p.error && <p className="text-xs muted mt-0.5 line-clamp-2">{p.error}</p>}
                </div>
                <button onClick={() => applyProposal(p.id)} disabled={applying[p.id]} className="btn btn-primary text-xs shrink-0">
                  {applying[p.id] ? "套用+重跑中…" : "✅ 套用並重跑"}
                </button>
                <button onClick={() => dismissProposal(p.id)} className="btn btn-ghost text-xs shrink-0">忽略</button>
              </div>
              {applyResult[p.id] && (
                <p className="text-xs" style={{ color: applyResult[p.id].ok ? "var(--green)" : "var(--red)" }}>
                  {applyResult[p.id].ok ? "✅ 套用後重跑成功！" : `⚠️ 套用後重跑還是失敗：${applyResult[p.id].error ?? ""}`}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {overview && overview.recentScheduleFailures.filter((f) => !dismissedFailures.includes(f.id)).length > 0 && (
        <div className="card px-4 py-3 mb-6 space-y-2" style={{ borderColor: "var(--red)" }}>
          <div className="text-sm font-medium" style={{ color: "var(--red)" }}>⚠️ 有排程執行失敗，沒有人看過</div>
          {overview.recentScheduleFailures.filter((f) => !dismissedFailures.includes(f.id)).map((f) => (
            <div key={f.id} className="flex items-start gap-2 text-sm">
              <div className="min-w-0 flex-1">
                <Link href={`/workflows/${f.workflow_id}`} className="font-medium hover:underline">{f.name}</Link>
                <span className="faint"> · {formatDate(f.started_at)}</span>
                <p className="text-xs muted mt-0.5 line-clamp-2">{f.reason}</p>
              </div>
              <button onClick={() => dismissFailure(f.id)} className="text-xs faint hover:text-[var(--text)] shrink-0">已讀，隱藏</button>
            </div>
          ))}
        </div>
      )}

      {overview && overview.running.length > 0 && (
        <div className="card px-4 py-3 mb-6 flex items-center gap-2 text-sm" style={{ borderColor: "var(--amber)" }}>
          <StatusDot status="running" />
          <span className="muted">執行中：</span>
          {overview.running.map((r) => (
            <Link key={r.id} href={`/workflows/${r.workflow_id}`} className="font-medium hover:underline" style={{ color: "var(--accent)" }}>
              {r.name}
            </Link>
          ))}
        </div>
      )}

      {workflows === null && <p className="text-sm muted">載入中…</p>}
      {workflows !== null && official.length === 0 && (
        <EmptyState
          icon="◈"
          title="還沒有正式 workflow"
          hint="按「新建 workflow」用白話跟 AI 建一個流程，或到「草稿 & 範例」複製內建範例來改。"
          action={<button onClick={createNew} className="btn btn-primary">＋ 新建 workflow</button>}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {official.map((w) => (
          <Link key={w.id} href={`/workflows/${w.id}`} className="card card-hover p-5 block">
            <div className="flex items-start gap-3 mb-2">
              <span
                className="grid place-items-center w-9 h-9 rounded-lg text-base shrink-0"
                style={{ background: "var(--accent-soft)", border: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)" }}
              >
                ◈
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium tracking-tight truncate">{w.name}</span>
                  {w.builtin && <span className="badge badge-neutral shrink-0">內建範例</span>}
                </div>
                <p className="text-xs faint mt-0.5 flex items-center gap-1.5">
                  <span>{w.nodeCount} 個步驟</span>
                  {w.triggers?.schedule && <span title="有啟用的排程，時間到自動執行">⏰ 排程</span>}
                  {w.triggers?.watch && <span title="正在監聽資料夾，新檔案會自動觸發">📁 監聽</span>}
                  {w.triggers?.webhook && <span title="Webhook 已啟用，外部工具可觸發">🔗 Webhook</span>}
                </p>
              </div>
            </div>
            <p className="text-sm muted line-clamp-2 min-h-[2.5rem]">{w.description || <span className="faint">（還沒有說明——點進去跟 AI 對話時會自動補上）</span>}</p>
            <div className="flex items-center gap-2 mt-4 pt-3 border-t text-xs">
              {w.lastRun ? (
                <span className="flex items-center gap-1.5" style={{ color: w.lastRun.status === "failed" ? "var(--red)" : w.lastRun.status === "success" ? "var(--green)" : "var(--text-faint)" }}>
                  <StatusDot status={w.lastRun.status} size={6} />
                  {statusLabel(w.lastRun.status)} · {formatDate(w.lastRun.started_at)}
                </span>
              ) : (
                <span className="faint">還沒執行過</span>
              )}
              <button onClick={(e) => runNow(e, w.id)} disabled={running[w.id]} title="用預設參數立即執行(有可調參數的流程會用預設值；要指定請點進流程頁按執行)" className="btn btn-ghost text-xs ml-auto shrink-0">{running[w.id] ? "已開始" : "▶ 執行"}</button>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
