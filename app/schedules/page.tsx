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
  // 沒有排程的正式流程，展開「加排程」表單時記住是哪一條(workflowId)——跟 editing 分開，
  // 一個是改既有排程的 cron、一個是幫還沒有排程的流程新增第一筆。
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
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
  const draftCount = workflows.filter((w) => w.status === "draft").length;
  const sequential = maxConcurrent <= 1;
  // 之前這頁分成「所有排程」+「一鍵執行」兩份清單，後者其實把前者列過的正式流程又列了一次
  // (2026-08 UI/UX 審計 M3)。合成一份：有排程的流程照舊顯示完整排程資訊，沒有排程的顯示
  // 「未設定排程」+「立即執行」+「加排程」，同一條流程只會出現一次。
  const scheduledWorkflowIds = new Set((schedules ?? []).map((s) => s.workflowId));
  const unscheduledOfficial = officialWorkflows.filter((w) => !scheduledWorkflowIds.has(w.id));
  // 使用者原話：「要把有在執行的和暫停的分開擺放」——之前混在同一份清單裡，只靠卡片上一顆小小的
  // 「已暫停」badge 分辨，暫停的排程夾在還在跑的中間，掃過去很容易誤以為某條也還在自動執行。
  // 拖曳排序(handleScheduleDrop)仍然操作同一個 schedules 陣列，只是渲染時依 enabled 分兩組顯示，
  // 排序邏輯不用跟著拆。
  const activeSchedules = (schedules ?? []).filter((s) => s.enabled);
  const pausedSchedules = (schedules ?? []).filter((s) => !s.enabled);

  function renderScheduleCard(s: ScheduleRow) {
    // s.enabled 是資料庫存的 0/1(number)，不是真正的 boolean——`s.enabled && X` 在 enabled=0 時
    // 短路的結果是數字 0(不是 false)，React 會把它當成合法子元素直接印出來，畫面上多一個裸的
    // 「0」字元(2026-08 分「執行中/已暫停」兩組時才真的被看見：已暫停的排程本來混在清單裡不顯眼，
    // 現在獨立成一區，這個舊 bug 反而變得很明顯)。先轉成真正的 boolean 再參與判斷式。
    const enabled = Boolean(s.enabled);
    return (
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
            title={enabled ? "暫停後背景不會再自己執行，設定會留著" : "恢復背景自動執行"}
            style={enabled ? undefined : { color: "var(--accent)" }}
          >
            {enabled ? "⏸ 暫停" : "▶ 恢復"}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {s.orphan ? <span className="text-sm font-medium faint">{s.workflowName}</span>
                : <Link href={`/workflows/${s.workflowId}`} className="text-sm font-medium hover:underline truncate">{s.workflowName}</Link>}
              {!enabled && <span className="badge badge-neutral">已暫停</span>}
              {enabled && s.blockedReason && <span className="badge" style={{ color: "var(--red)" }}>不會執行</span>}
            </div>
            <div className="text-xs muted mt-0.5">{humanizeCron(s.cron)}{s.nextRunAt && enabled && !s.blockedReason && <span className="faint"> · 下次 {formatScheduleNextRun(s.nextRunAt)}</span>}</div>
            {/* 「開著」不等於「真的會跑」。原本這種排程畫面上跟正常的一模一樣(綠燈+下次執行時間)，
                但排程器每分鐘都會跳過它、只寫一行終端機警告——使用者永遠等不到那次執行也不知道為什麼。 */}
            {enabled && s.blockedReason && (
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
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-8 space-y-8">
      <PageHeader title="排程 & 執行" subtitle="集中管理所有流程何時自動執行，也能直接手動跑一次" />
      {actionError && <div className="card px-4 py-3 text-sm" style={{ borderColor: "var(--amber)", color: "var(--text)" }}>{actionError}</div>}

      {/* 所有流程：有排程的顯示完整排程資訊，沒有的顯示「未設定排程」+ 執行/加排程 */}
      <section className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="font-medium">所有流程</h2>
          {(schedules?.length ?? 0) > 0 && (
            <span className="text-xs muted">
              {schedules!.filter((s) => s.enabled && !s.blockedReason).length} 個會自動執行
              {schedules!.some((s) => !s.enabled) && ` · ${schedules!.filter((s) => !s.enabled).length} 個已暫停`}
              {unscheduledOfficial.length > 0 && ` · ${unscheduledOfficial.length} 條還沒設排程`}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {officialWorkflows.length > 0 && (
              <button onClick={runAll} disabled={runningAll} className="btn btn-ghost text-xs" title="只執行已有完整預設值的流程；需要填資料的會跳過">
                {runningAll ? "正在排入…" : `▶ 執行可直接跑的流程（${sequential ? "依序" : "併行"}）`}
              </button>
            )}
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
        <p className="text-xs faint">有排程的依「下次執行時間」由近到遠排序，拖曳左側「⠿」可以手動調整順序；暫停只是停掉「背景自動執行」，設定都會留著，隨時可以恢復。</p>
        {schedules === null && <p className="text-sm muted">載入中…</p>}
        {schedules !== null && schedules.length === 0 && officialWorkflows.length === 0 && (
          draftCount > 0 ? (
            <EmptyState icon="⏰" title="還沒有任何正式流程" hint={`你有 ${draftCount} 個草稿——到草稿頁按「設為正式」，就會出現在這裡集中管理。`} action={<Link href="/drafts" className="btn btn-primary">去看草稿</Link>} />
          ) : (
            <EmptyState icon="⏰" title="還沒有任何正式流程" hint="先建立一條流程，設為正式後就會出現在這裡集中管理。" action={<Link href="/" className="btn btn-primary">＋ 建立新流程</Link>} />
          )
        )}
        {activeSchedules.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs font-medium faint">▶ 執行中（{activeSchedules.length}）</h3>
            {activeSchedules.map(renderScheduleCard)}
          </div>
        )}
        {pausedSchedules.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs font-medium faint">⏸ 已暫停（{pausedSchedules.length}）</h3>
            {pausedSchedules.map(renderScheduleCard)}
          </div>
        )}
        {unscheduledOfficial.length > 0 && (
          <div className="space-y-3">
            {(schedules?.length ?? 0) > 0 && <h3 className="text-xs font-medium faint">還沒設排程（{unscheduledOfficial.length}）</h3>}
            {unscheduledOfficial.map((w) => (
              <div key={w.id} className="card p-4 space-y-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="w-6 h-6 shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <Link href={`/workflows/${w.id}`} className="text-sm font-medium hover:underline truncate">{w.name}</Link>
                    <div className="text-xs faint mt-0.5">未設定排程</div>
                  </div>
                  <button onClick={() => runNow(w.id)} disabled={running[w.id]} className="btn btn-ghost text-xs shrink-0" title="需要填資料時會先帶你到執行設定">{running[w.id] ? "已開始" : w.needsRunInput ? "填資料執行" : "▶ 立即執行"}</button>
                  <button onClick={() => setCreatingFor(creatingFor === w.id ? null : w.id)} className="btn btn-ghost text-xs shrink-0">{creatingFor === w.id ? "取消" : "+ 加排程"}</button>
                </div>
                {creatingFor === w.id && <ScheduleEditor workflowId={w.id} onSaved={() => { setCreatingFor(null); load(); }} onCancel={() => setCreatingFor(null)} />}
              </div>
            ))}
          </div>
        )}
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

      {/* 併發模式——進階設定，平常不用調，收進摺疊區並移到頁尾 */}
      <details className="card p-5">
        <summary className="cursor-pointer font-medium">同時觸發時怎麼跑？（進階）</summary>
        <div className="mt-3">
          <p className="text-sm muted mb-3">多個排程剛好同時到、或按「執行可直接跑的流程」時，要一個一個依序跑、還是同時併行。</p>
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setConcurrency(1)} className="btn btn-ghost"
              style={sequential ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : undefined}>依序（一次一個）</button>
            <button onClick={() => setConcurrency(3)} className="btn btn-ghost"
              style={!sequential ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : undefined}>併行（最多同時 {sequential ? 3 : maxConcurrent} 個）</button>
          </div>
          <p className="text-xs faint mt-2">依序最省資源也不會互搶瀏覽器；併行比較快但同時開多個瀏覽器較吃記憶體。同一個流程永遠不會自己疊著跑。</p>
        </div>
      </details>
    </div>
  );
}

function ScheduleEditor({ cron, sid, workflowId, onSaved, onCancel }: { cron?: string; sid?: string; workflowId?: string; onSaved: () => void; onCancel: () => void }) {
  const parsed = cron ? parseCron(cron) : null;
  const [form, setForm] = useState<ScheduleForm>(parsed ?? { mode: "monthly", time: "09:00", day: "1", weekday: "1" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showDay = form.mode === "monthly" || form.mode === "quarter" || form.mode === "bimonth";
  const valid = timeValid(form.time);

  async function save() {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const res = sid
        ? await fetch(`/api/schedules/${sid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cron: buildCron(form) }) })
        : await fetch(`/api/workflows/${workflowId}/schedules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cron: buildCron(form), params: {} }) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error ?? "儲存失敗");
        return;
      }
      onSaved();
    } finally { setSaving(false); }
  }

  return (
    <div className="border-t pt-3 space-y-3">
      {sid && !parsed && <p className="text-xs" style={{ color: "var(--amber)" }}>這是進階 cron 設定，用下面的簡單選項儲存會覆蓋它。</p>}
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
        <span className="faint text-xs">{sid ? "改成：" : "排程："}</span> <span className="font-medium">{valid ? humanizeCron(buildCron(form)) : "（請先選時間）"}</span>
      </div>
      {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving || !valid} className="btn btn-primary text-sm">{saving ? "儲存中…" : sid ? "儲存" : "新增排程"}</button>
        <button onClick={onCancel} className="btn btn-ghost text-sm">取消</button>
      </div>
    </div>
  );
}
