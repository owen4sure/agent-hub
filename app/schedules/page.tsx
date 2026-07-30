"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader, EmptyState, formatScheduleNextRun, humanizeCron } from "@/components/ui";
import { SCHEDULE_MODES, WEEKDAY_NAMES, buildCron, parseCron, timeValid, type ScheduleForm } from "@/lib/cron";

interface ScheduleRow {
  id: string; workflowId: string; workflowName: string; enabled: number;
  cron: string; nextRunAt: string | null; orphan: boolean;
  /** 開著、但排程器每次都會跳過它的原因(草稿/缺帳密…)。null = 真的會跑 */
  blockedReason?: string | null;
}
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
  // 拖曳排序：預設依「下次執行時間」排(伺服器端算好送來)，使用者也可以拖曳「⠿」手動調整，
  // 手動排過的順序會存伺服器、優先於時間排序(見 /api/schedules 的合併邏輯)。
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // 上次按「全部暫停」實際關掉的那幾筆。有值才顯示「恢復」按鈕，而且恢復只動這幾筆
  // (不是打開全部——否則會把使用者早就刻意關掉的排程一起放回背景執行)。
  const [pausedBatch, setPausedBatch] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState("");

  async function load() {
    const [s, w, settings, bulk] = await Promise.all([
      fetch("/api/schedules").then((r) => r.json()),
      fetch("/api/workflows").then((r) => r.json()),
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/schedules/bulk").then((r) => r.json()).catch(() => ({ pausedBatch: [] })),
    ]);
    setSchedules(s.schedules ?? []);
    setWorkflows(w.workflows ?? []);
    setMaxConcurrent(settings.maxConcurrent ?? 1);
    setPausedBatch(bulk.pausedBatch ?? []);
  }

  async function bulkAction(action: "pause-all" | "resume") {
    setBulkBusy(true);
    setBulkNote("");
    try {
      const res = await fetch("/api/schedules/bulk", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as { paused?: number; resumed?: number; missing?: number; error?: string };
      if (!res.ok) { setActionError(data.error ?? "操作失敗"); return; }
      setActionError(null);
      setBulkNote(action === "pause-all"
        ? `已暫停 ${data.paused ?? 0} 個排程，背景不會再自己執行。原本就已暫停的沒有被動到。`
        : `已恢復 ${data.resumed ?? 0} 個排程${data.missing ? `（有 ${data.missing} 個已經被刪掉，跳過）` : ""}。只恢復剛才被「全部暫停」關掉的那幾個。`);
      await load();
    } finally {
      setBulkBusy(false);
    }
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

  async function handleScheduleDrop(targetId: string) {
    const sourceId = dragId;
    setDragId(null);
    setDropTargetId(null);
    if (!sourceId || sourceId === targetId || !schedules) return;
    const ids = schedules.map((s) => s.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, sourceId);
    const rank = new Map(ids.map((sid, i) => [sid, i]));
    setSchedules((rows) => rows && [...rows].sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999)));
    try {
      const res = await fetch("/api/schedules/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setActionError("排序沒有存成功，畫面已還原成伺服器的順序");
      load(); // 存失敗就撤回樂觀更新，畫面回到伺服器的真實順序
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
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="font-medium">所有排程</h2>
          {(schedules?.length ?? 0) > 0 && (
            <span className="text-xs muted">
              {schedules!.filter((s) => s.enabled && !s.blockedReason).length} 個會自動執行
              {schedules!.some((s) => !s.enabled) && ` · ${schedules!.filter((s) => !s.enabled).length} 個已暫停`}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {pausedBatch.length > 0 && (
              <button onClick={() => bulkAction("resume")} disabled={bulkBusy} className="btn btn-ghost text-xs">
                ▶ 恢復剛才暫停的 {pausedBatch.length} 個
              </button>
            )}
            {(schedules?.some((s) => s.enabled) ?? false) && (
              <button
                onClick={() => { if (confirm("要暫停全部排程嗎？\n\n背景就不會再自己執行任何流程，你仍然可以手動按「立即執行」。\n之後按「恢復」只會打開這次被關掉的，不會動到你原本就已經暫停的。")) void bulkAction("pause-all"); }}
                disabled={bulkBusy}
                className="btn btn-ghost text-xs"
                title="出門、放假、或正在改東西不想被背景執行打斷時用"
              >
                ⏸ 全部暫停
              </button>
            )}
          </div>
        </div>
        {bulkNote && <p className="text-xs" style={{ color: "var(--green)" }}>{bulkNote}</p>}
        <p className="text-xs faint">預設依「下次執行時間」由近到遠排序；拖曳左側「⠿」可以手動調整順序。暫停只是停掉「背景自動執行」，設定都會留著，隨時可以恢復。</p>
        {schedules === null && <p className="text-sm muted">載入中…</p>}
        {schedules !== null && schedules.length === 0 && (
          <EmptyState icon="⏰" title="還沒有任何排程" hint="到任一個流程按「⏰ 排程」設定時間，就會出現在這裡集中管理。" />
        )}
        {schedules?.map((s) => (
          <div
            key={s.id}
            className="card p-4 space-y-3"
            style={{
              ...(dropTargetId === s.id && dragId !== s.id ? { outline: "2px dashed var(--accent)", outlineOffset: "2px" } : {}),
              ...(dragId === s.id ? { opacity: 0.4 } : {}),
            }}
            onDragOver={(e) => { if (dragId) { e.preventDefault(); setDropTargetId(s.id); } }}
            onDragLeave={() => { if (dropTargetId === s.id) setDropTargetId(null); }}
            onDrop={(e) => { e.preventDefault(); handleScheduleDrop(s.id); }}
          >
            <div className="flex items-center gap-3 flex-wrap">
              <span
                draggable
                onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragId(s.id); }}
                onDragEnd={() => { setDragId(null); setDropTargetId(null); }}
                className="faint hover:text-[var(--text)] text-sm w-6 h-6 grid place-items-center rounded-md cursor-grab active:cursor-grabbing select-none shrink-0"
                title="拖到另一筆排程上調整順序"
                aria-label="拖曳排序"
              >
                ⠿
              </span>
              {/* 暫停/恢復刻意帶文字，不是只有一顆 emoji：原本是裸的 🟢 夾在拖曳把手跟名稱中間，
                  使用者根本看不出那是可以按的東西(他直接來問「能不能做暫停排程的功能」，
                  而功能其實一直都在)。找不到的功能等於不存在。 */}
              <button
                onClick={() => toggle(s)}
                className="btn btn-ghost text-xs shrink-0"
                title={s.enabled ? "暫停後背景不會再自己執行，設定會留著" : "恢復背景自動執行"}
                style={s.enabled ? undefined : { color: "var(--accent)" }}
              >
                {s.enabled ? "⏸ 暫停" : "▶ 恢復"}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  {s.orphan ? <span className="text-sm font-medium faint">{s.workflowName}</span>
                    : <Link href={`/workflows/${s.workflowId}`} className="text-sm font-medium hover:underline truncate">{s.workflowName}</Link>}
                  {!s.enabled && <span className="badge badge-neutral">已暫停</span>}
                  {s.enabled && s.blockedReason && <span className="badge" style={{ color: "var(--red)" }}>不會執行</span>}
                </div>
                <div className="text-xs muted mt-0.5">{humanizeCron(s.cron)}{s.nextRunAt && s.enabled && !s.blockedReason && <span className="faint"> · 下次 {formatScheduleNextRun(s.nextRunAt)}</span>}</div>
                {/* 「開著」不等於「真的會跑」。原本這種排程畫面上跟正常的一模一樣(綠燈+下次執行時間)，
                    但排程器每分鐘都會跳過它、只寫一行終端機警告——使用者永遠等不到那次執行也不知道為什麼。 */}
                {s.enabled && s.blockedReason && (
                  <p className="text-xs mt-1" style={{ color: "var(--red)" }}>⚠️ 這個排程時間到了也不會執行：{s.blockedReason}</p>
                )}
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
