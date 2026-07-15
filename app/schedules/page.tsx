"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader, EmptyState, formatDate, humanizeCron } from "@/components/ui";
import { SCHEDULE_MODES, WEEKDAY_NAMES, buildCron, parseCron, timeValid, type ScheduleForm } from "@/lib/cron";

interface ScheduleRow { id: string; workflowId: string; workflowName: string; enabled: number; cron: string; nextRunAt: string | null; orphan: boolean }
interface WorkflowRow { id: string; name: string; status: string; nodeCount: number; needsRunInput?: boolean; triggers?: { schedule: boolean; watch: boolean; webhook: boolean } }

export default function SchedulesPage() {
  const router = useRouter();
  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function load() {
    const [s, w, settings] = await Promise.all([
      fetch("/api/schedules").then((r) => r.json()),
      fetch("/api/workflows").then((r) => r.json()),
      fetch("/api/settings").then((r) => r.json()),
    ]);
    setSchedules(s.schedules ?? []);
    setWorkflows(w.workflows ?? []);
    setMaxConcurrent(settings.maxConcurrent ?? 1);
  }
  useEffect(() => {
    // Initial client-side synchronization with the local API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  async function setConcurrency(n: number) {
    const previous = maxConcurrent;
    setMaxConcurrent(n);
    const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxConcurrent: n }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setMaxConcurrent(previous);
      setActionError((data as { error?: string }).error ?? "執行模式儲存失敗");
    } else setActionError(null);
  }
  async function toggle(s: ScheduleRow) {
    const response = await fetch(`/api/schedules/${s.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !s.enabled }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setActionError((data as { error?: string }).error ?? "排程狀態更新失敗");
      return;
    }
    setActionError(null);
    load();
  }
  async function remove(sid: string) {
    if (!confirm("確定刪除這個排程嗎？")) return;
    const response = await fetch(`/api/schedules/${sid}`, { method: "DELETE" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setActionError((data as { error?: string }).error ?? "刪除排程失敗");
      return;
    }
    setActionError(null);
    load();
  }
  async function runNow(workflowId: string) {
    const workflow = workflows.find((item) => item.id === workflowId);
    if (workflow?.needsRunInput) {
      router.push(`/workflows/${workflowId}?run=1`);
      return;
    }
    setRunning((r) => ({ ...r, [workflowId]: true }));
    try {
      const response = await fetch(`/api/workflows/${workflowId}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) setActionError((data as { error?: string }).error ?? "流程啟動失敗");
      else setActionError(null);
    } catch {
      setActionError("連不上伺服器，流程沒有啟動");
    } finally {
      setTimeout(() => setRunning((r) => ({ ...r, [workflowId]: false })), 1200);
    }
  }
  async function runAll() {
    setRunningAll(true);
    try {
      // 一次把所有正式流程丟進佇列；實際同時跑幾個由上面的「順序/併行」設定決定
      const failures: string[] = [];
      for (const w of officialWorkflows.filter((item) => !item.needsRunInput)) {
        const response = await fetch(`/api/workflows/${w.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }) });
        if (!response.ok) failures.push(w.name);
      }
      const skipped = officialWorkflows.filter((item) => item.needsRunInput).length;
      setActionError(failures.length > 0
        ? `${failures.join("、")} 啟動失敗；其他可執行流程已排入`
        : skipped > 0 ? `已排入可直接執行的流程；另有 ${skipped} 條需要先填資料，未自動執行` : null);
    } catch {
      setActionError("排入流程時連線中斷；請到執行紀錄確認哪些已啟動，再重試其餘流程");
    } finally {
      setTimeout(() => setRunningAll(false), 1500);
    }
  }

  const officialWorkflows = workflows.filter((w) => w.status === "official");
  const sequential = maxConcurrent <= 1;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-8 space-y-8">
      <PageHeader title="排程 & 執行" subtitle="集中管理所有排程、一鍵執行任何流程，不用一個一個點進去" />
      {actionError && <div className="card px-4 py-3 text-sm" style={{ borderColor: "var(--amber)", color: "var(--text)" }}>{actionError}</div>}

      {/* 併發模式 */}
      <section className="card p-5">
        <h2 className="font-medium">同時觸發時怎麼跑？</h2>
        <p className="text-sm muted mt-0.5 mb-3">多個排程剛好同時到、或按「全部執行」時，要一個一個依序跑、還是同時併行。</p>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setConcurrency(1)} className="btn btn-ghost"
            style={sequential ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : undefined}>依序（一次一個）</button>
          <button onClick={() => setConcurrency(3)} className="btn btn-ghost"
            style={!sequential ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : undefined}>併行（最多同時 {sequential ? 3 : maxConcurrent} 個）</button>
        </div>
        <p className="text-xs faint mt-2">依序最省資源也不會互搶瀏覽器；併行比較快但同時開多個瀏覽器較吃記憶體。同一個流程永遠不會自己疊著跑。</p>
      </section>

      {/* 所有排程 */}
      <section className="space-y-3">
        <h2 className="font-medium">所有排程</h2>
        {schedules === null && <p className="text-sm muted">載入中…</p>}
        {schedules !== null && schedules.length === 0 && (
          <EmptyState icon="⏰" title="還沒有任何排程" hint="到任一個流程按「⏰ 排程」設定時間，就會出現在這裡集中管理。" />
        )}
        {schedules?.map((s) => (
          <div key={s.id} className="card p-4 space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={() => toggle(s)} aria-label={s.enabled ? "暫停" : "啟用"} title={s.enabled ? "執行中，點一下暫停" : "已暫停，點一下啟用"} className="text-lg shrink-0">{s.enabled ? "🟢" : "⏸"}</button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {s.orphan ? <span className="text-sm font-medium faint">{s.workflowName}</span>
                    : <Link href={`/workflows/${s.workflowId}`} className="text-sm font-medium hover:underline truncate">{s.workflowName}</Link>}
                  {!s.enabled && <span className="badge badge-neutral">已暫停</span>}
                </div>
                <div className="text-xs muted mt-0.5">{humanizeCron(s.cron)}{s.nextRunAt && s.enabled && <span className="faint"> · 下次 {formatDate(s.nextRunAt)}</span>}</div>
              </div>
              {!s.orphan && (
                <button onClick={() => runNow(s.workflowId)} disabled={running[s.workflowId]} className="btn btn-ghost text-xs shrink-0" title="需要填資料時會先帶你到執行設定">{running[s.workflowId] ? "已開始" : workflows.find((w) => w.id === s.workflowId)?.needsRunInput ? "填資料執行" : "▶ 立即執行"}</button>
              )}
              <button onClick={() => setEditing(editing === s.id ? null : s.id)} className="btn btn-ghost text-xs shrink-0">編輯</button>
              <button onClick={() => remove(s.id)} className="btn btn-ghost text-xs shrink-0" style={{ color: "var(--red)" }}>刪除</button>
            </div>
            {editing === s.id && <ScheduleEditor cron={s.cron} onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} sid={s.id} />}
          </div>
        ))}
      </section>

      {/* 其他自動觸發(監聽/Webhook)——這頁自稱「集中管理」，不能只看得到排程 */}
      {officialWorkflows.some((w) => w.triggers?.watch || w.triggers?.webhook) && (
        <section className="space-y-3">
          <h2 className="font-medium">監聽 / Webhook 啟用中</h2>
          {officialWorkflows.filter((w) => w.triggers?.watch || w.triggers?.webhook).map((w) => (
            <div key={w.id} className="card p-3 flex items-center gap-3">
              <Link href={`/workflows/${w.id}`} className="text-sm font-medium hover:underline truncate flex-1">{w.name}</Link>
              {w.triggers?.watch && <span className="text-xs shrink-0" title="有新檔案丟進監聽資料夾就自動跑">📁 監聽中</span>}
              {w.triggers?.webhook && <span className="text-xs shrink-0" title="外部工具 POST 專屬網址就觸發">🔗 Webhook</span>}
              <Link href={`/workflows/${w.id}`} className="btn btn-ghost text-xs shrink-0" title="到流程頁的 ⚡ 觸發面板調整">設定</Link>
            </div>
          ))}
        </section>
      )}

      {/* 一鍵執行任何流程 */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="font-medium">一鍵執行</h2>
          {officialWorkflows.length > 0 && (
            <button onClick={runAll} disabled={runningAll} className="btn btn-ghost text-xs ml-auto" title="只執行已有完整預設值的流程；需要填資料的會跳過">{runningAll ? "正在排入…" : `▶ 執行可直接跑的流程（${sequential ? "依序" : "併行"}）`}</button>
          )}
        </div>
        {officialWorkflows.length === 0 && <p className="text-sm muted">目前沒有正式流程。草稿請到流程頁測試。</p>}
        {officialWorkflows.map((w) => (
          <div key={w.id} className="card p-3 flex items-center gap-3">
            <Link href={`/workflows/${w.id}`} className="text-sm font-medium hover:underline truncate flex-1">{w.name}</Link>
            <span className="text-xs faint shrink-0">{w.nodeCount} 節點</span>
            <button onClick={() => runNow(w.id)} disabled={running[w.id]} className="btn btn-primary text-xs shrink-0" title={w.needsRunInput ? "先填這次要用的資料再執行" : "用完整預設值立即執行"}>{running[w.id] ? "已開始" : w.needsRunInput ? "填資料執行" : "▶ 立即執行"}</button>
          </div>
        ))}
      </section>
    </div>
  );
}

function ScheduleEditor({ cron, sid, onSaved, onCancel }: { cron: string; sid: string; onSaved: () => void; onCancel: () => void }) {
  const parsed = parseCron(cron);
  const [form, setForm] = useState<ScheduleForm>(parsed ?? { mode: "monthly", time: "09:00", day: "1", weekday: "1" });
  const [saving, setSaving] = useState(false);
  const showDay = form.mode === "monthly" || form.mode === "quarter" || form.mode === "bimonth";
  const valid = timeValid(form.time);

  async function save() {
    if (!valid) return;
    setSaving(true);
    try {
      await fetch(`/api/schedules/${sid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cron: buildCron(form) }) });
      onSaved();
    } finally { setSaving(false); }
  }

  return (
    <div className="border-t pt-3 space-y-3">
      {!parsed && <p className="text-xs" style={{ color: "var(--amber)" }}>這是進階 cron 設定，用下面的簡單選項儲存會覆蓋它。</p>}
      <div>
        <div className="text-xs faint mb-1.5">多久跑一次？</div>
        <div className="flex flex-wrap gap-1.5">
          {SCHEDULE_MODES.map(([v, l]) => (
            <button key={v} onClick={() => setForm((f) => ({ ...f, mode: v }))} className="btn btn-ghost text-sm"
              style={form.mode === v ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : undefined}>{l}</button>
          ))}
        </div>
      </div>
      {form.mode === "weekly" && (
        <div>
          <div className="text-xs faint mb-1.5">星期幾？</div>
          <select value={form.weekday} onChange={(e) => setForm((f) => ({ ...f, weekday: e.target.value }))} className="input">
            {WEEKDAY_NAMES.map((l, i) => <option key={i} value={i}>星期{l}</option>)}
          </select>
        </div>
      )}
      {showDay && (
        <div>
          <div className="text-xs faint mb-1.5">每個月的幾號？</div>
          <select value={form.day} onChange={(e) => setForm((f) => ({ ...f, day: e.target.value }))} className="input">
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d} 號</option>)}
          </select>
        </div>
      )}
      <div>
        <div className="text-xs faint mb-1.5">幾點執行？</div>
        <input type="time" value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} className="input" style={!valid ? { borderColor: "var(--red)" } : undefined} />
      </div>
      <div className="card px-3 py-2 text-sm" style={{ background: "var(--surface-2)", borderColor: "var(--accent)" }}>
        <span className="faint text-xs">改成：</span> <span className="font-medium">{valid ? humanizeCron(buildCron(form)) : "（請先選時間）"}</span>
      </div>
      <div className="flex gap-2">
        <button onClick={save} disabled={saving || !valid} className="btn btn-primary text-sm">{saving ? "儲存中…" : "儲存"}</button>
        <button onClick={onCancel} className="btn btn-ghost text-sm">取消</button>
      </div>
    </div>
  );
}
