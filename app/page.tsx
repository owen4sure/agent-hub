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
  group?: string;
  lastRun?: { status: string; started_at: string } | null;
  triggers?: { schedule: boolean; watch: boolean; webhook: boolean; email?: boolean; telegram?: boolean; line?: boolean };
}
interface Overview {
  officialCount: number;
  draftCount: number;
  todayCounts: Record<string, number>;
  running: { id: string; workflow_id: string; name: string }[];
  recentScheduleFailures: { id: string; workflow_id: string; name: string; reason: string | null; started_at: string }[];
  pendingApprovals?: { id: string; workflow_id: string; workflow_name: string; message: string; token: string; created_at: string; expires_at: string }[];
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
    // Initial client-side synchronization with the local API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const [deciding, setDeciding] = useState<Record<string, boolean>>({});
  const [decideError, setDecideError] = useState<Record<string, string>>({});
  // 首頁簽核卡直接按核准/拒絕(要填備註就開「詳情」的簽核頁)
  async function decideApprovalCard(id: string, action: "approve" | "reject") {
    setDeciding((d) => ({ ...d, [id]: true }));
    setDecideError((e) => ({ ...e, [id]: "" }));
    try {
      const res = await fetch(`/api/approvals/${id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDecideError((e) => ({ ...e, [id]: (data as { error?: string }).error ?? "簽核失敗，請再試一次" }));
        return;
      }
      load(); // 卡片消失+執行中區塊會出現這條流程
    } catch {
      setDecideError((e) => ({ ...e, [id]: "連不上伺服器，請再試一次" }));
    } finally {
      setDeciding((d) => ({ ...d, [id]: false }));
    }
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

  // ── 搜尋+群組(工作/私人…):流程一多就靠這兩個找東西 ──
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [groupMenuFor, setGroupMenuFor] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  // 群組區塊可收合(Owen:「一多就看著砸」)——收合狀態存 localStorage,重整/下次來還記得
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("agenthub_collapsed_groups") ?? "[]") as string[];
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsedGroups(new Set(saved));
    } catch {}
  }, []);
  function toggleGroupCollapsed(title: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      localStorage.setItem("agenthub_collapsed_groups", JSON.stringify([...next]));
      return next;
    });
  }
  useEffect(() => {
    if (!groupMenuFor) return;
    // 點選單「外面」才關。不能靠選單內 stopPropagation 擋——Next App Router 的 React 根就是
    // document,這個監聽器跟 React 的事件代理掛在同一個節點,stopPropagation 攔不住同節點的
    // 兄弟監聽器(踩過的真實 bug:點到「新群組名稱」輸入框選單就關掉,名字永遠打不進去)。
    // 改用檢查點擊落點:落在選單內/🗂 按鈕上一律不關。
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest(".menu") || t.closest("button[aria-label='移到群組']"))) return;
      setGroupMenuFor(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [groupMenuFor]);

  const groups = [...new Set(official.map((w) => w.group).filter((g): g is string => Boolean(g)))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  const q = search.trim().toLowerCase();
  const visible = official.filter(
    (w) =>
      (!q || w.name.toLowerCase().includes(q) || (w.description ?? "").toLowerCase().includes(q)) &&
      (!groupFilter || w.group === groupFilter),
  );
  // 分區:有名字的群組照字母序,「未分組」永遠最後(沒有任何群組時只有一區、不顯示標題)
  const sections = [
    ...groups.filter((g) => !groupFilter || g === groupFilter).map((g) => ({ title: g, items: visible.filter((w) => w.group === g) })),
    ...(!groupFilter ? [{ title: "未分組", items: visible.filter((w) => !w.group) }] : []),
  ].filter((s) => s.items.length > 0);

  async function assignGroup(wfId: string, group: string) {
    setGroupMenuFor(null);
    setNewGroupName("");
    try {
      await fetch(`/api/workflows/${wfId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group }),
      });
      load();
    } catch { /* 下一輪 load 會對回真實狀態 */ }
  }

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

      {(overview?.pendingApprovals?.length ?? 0) > 0 && (
        <div className="card px-4 py-3 mb-6 space-y-3" style={{ borderColor: "var(--amber)" }}>
          <div className="text-sm font-medium" style={{ color: "var(--amber)" }}>🙋 有流程停下來等你簽核</div>
          {overview!.pendingApprovals!.map((a) => (
            <div key={a.id} className="space-y-1.5">
              <div className="flex items-start gap-2 text-sm">
                <div className="min-w-0 flex-1">
                  <Link href={`/workflows/${a.workflow_id}`} className="font-medium hover:underline">{a.workflow_name}</Link>
                  <span className="faint"> · {formatDate(a.created_at)}</span>
                  <p className="text-xs muted mt-0.5 whitespace-pre-wrap line-clamp-3">{a.message}</p>
                </div>
                <button onClick={() => decideApprovalCard(a.id, "approve")} disabled={deciding[a.id]} className="btn btn-primary text-xs shrink-0">
                  {deciding[a.id] ? "處理中…" : "✅ 核准"}
                </button>
                <button onClick={() => decideApprovalCard(a.id, "reject")} disabled={deciding[a.id]} className="btn btn-ghost text-xs shrink-0">❌ 拒絕</button>
                <a href={`/approve/${a.token}`} target="_blank" rel="noreferrer" className="text-xs faint hover:text-[var(--text)] shrink-0 mt-1" title="開簽核頁(可填備註)">詳情</a>
              </div>
              {decideError[a.id] && <p className="text-xs" style={{ color: "var(--red)" }}>{decideError[a.id]}</p>}
            </div>
          ))}
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
          hint="按「新建 workflow」用白話跟 AI 建一個流程。"
          action={<button onClick={createNew} className="btn btn-primary">＋ 新建 workflow</button>}
        />
      )}

      {/* 搜尋+群組篩選:流程一多就靠這排找東西 */}
      {official.length > 0 && (
        <div className="flex items-center gap-2 mb-5 flex-wrap">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 搜尋流程名稱/說明…"
            className="input text-sm max-w-[260px]"
            aria-label="搜尋流程"
          />
          {groups.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <button onClick={() => setGroupFilter(null)} className="btn btn-ghost text-xs" style={groupFilter === null ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>全部</button>
              {groups.map((g) => (
                <button key={g} onClick={() => setGroupFilter((cur) => (cur === g ? null : g))} className="btn btn-ghost text-xs" style={groupFilter === g ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>
                  🗂 {g}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {sections.map(({ title, items }) => {
        const showHeader = groups.length > 0 || title !== "未分組";
        const collapsed = showHeader && collapsedGroups.has(title);
        return (
        <div key={title} className="mb-8">
          {showHeader && (
            <button
              onClick={() => toggleGroupCollapsed(title)}
              className="text-sm font-semibold mb-3 flex items-center gap-2 hover:text-[var(--text)]"
              style={{ color: "var(--text-muted)" }}
              aria-expanded={!collapsed}
            >
              <span className="text-xs faint w-3 inline-block">{collapsed ? "▸" : "▾"}</span>
              🗂 {title} <span className="faint font-normal">{items.length}</span>
            </button>
          )}
          {!collapsed && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((w) => (
          <article key={w.id} className="card card-hover p-5 relative">
            <Link href={`/workflows/${w.id}`} className="absolute inset-0 rounded-[var(--radius-md)] z-0" aria-label={`開啟流程：${w.name}`} />
            <div className="flex items-start gap-3 mb-2 relative z-[1] pointer-events-none">
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
                  {w.triggers?.email && <span title="收信觸發已開啟，符合條件的新 email 會自動觸發">📨 收信</span>}
                  {w.triggers?.telegram && <span title="Telegram 訊息觸發已開啟，傳訊息給 bot 就自動執行">✈️ Telegram</span>}
                  {w.triggers?.line && <span title="LINE 訊息觸發已啟用，傳訊息給官方帳號就自動執行">💬 LINE</span>}
                </p>
              </div>
              {!w.builtin && (
                <button
                  onClick={(e) => { e.stopPropagation(); setGroupMenuFor((cur) => (cur === w.id ? null : w.id)); }}
                  className="faint hover:text-[var(--text)] text-sm shrink-0 px-1 pointer-events-auto relative z-10"
                  title="移到群組(工作/私人…)"
                  aria-label="移到群組"
                >
                  🗂
                </button>
              )}
            </div>
            {groupMenuFor === w.id && (
              <div className="menu absolute right-3 top-12 z-30" onClick={(e) => e.stopPropagation()}>
                <p className="text-[11px] faint px-2.5 pt-1.5 pb-1">移到群組</p>
                {groups.map((g) => (
                  <button key={g} className="menu-item" onClick={() => assignGroup(w.id, g)}>
                    <span>🗂</span> {g} {w.group === g && <span className="ml-auto" style={{ color: "var(--accent)" }}>✓</span>}
                  </button>
                ))}
                {w.group && (
                  <button className="menu-item" onClick={() => assignGroup(w.id, "")}>
                    <span>✕</span> 移出群組
                  </button>
                )}
                <div className="menu-sep" />
                <div className="flex items-center gap-1 px-1.5 pb-1">
                  <input
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && newGroupName.trim()) assignGroup(w.id, newGroupName.trim()); }}
                    placeholder="新群組名稱…"
                    className="input text-xs py-1"
                  />
                  <button
                    onClick={() => { if (newGroupName.trim()) assignGroup(w.id, newGroupName.trim()); }}
                    className="btn btn-ghost text-xs shrink-0"
                  >
                    建立
                  </button>
                </div>
              </div>
            )}
            <p className="text-sm muted line-clamp-2 min-h-[2.5rem] relative z-[1] pointer-events-none">{w.description || <span className="faint">（還沒有說明——點進去跟 AI 對話時會自動補上）</span>}</p>
            <div className="flex items-center gap-2 mt-4 pt-3 border-t text-xs relative z-[1] pointer-events-none">
              {w.lastRun ? (
                <span className="flex items-center gap-1.5" style={{ color: w.lastRun.status === "failed" ? "var(--red)" : w.lastRun.status === "success" ? "var(--green)" : "var(--text-faint)" }}>
                  <StatusDot status={w.lastRun.status} size={6} />
                  {statusLabel(w.lastRun.status)} · {formatDate(w.lastRun.started_at)}
                </span>
              ) : (
                <span className="faint">還沒執行過</span>
              )}
              <button onClick={(e) => runNow(e, w.id)} disabled={running[w.id]} title="用預設參數立即執行(有可調參數的流程會用預設值；要指定請點進流程頁按執行)" className="btn btn-ghost text-xs ml-auto shrink-0 pointer-events-auto relative z-10">{running[w.id] ? "已開始" : "▶ 執行"}</button>
            </div>
          </article>
            ))}
          </div>
          )}
        </div>
        );
      })}
    </div>
  );
}
