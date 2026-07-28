"use client";

import { useEffect, useState } from "react";
import { formatScheduleNextRun, humanizeCron } from "@/components/ui";
import { SCHEDULE_MODES, WEEKDAY_NAMES, buildCron, timeValid } from "@/lib/cron";
import { MailSection, TelegramSection, LineSection, SafetyContractSection } from "./TriggerSections";

/** 觸發面板：排程 / 資料夾監聽 / Webhook / 收信 / Telegram / LINE 六種自動觸發方式都在這裡設定。 */
export function SchedulePanel({ workflowId, onClose, automationReadiness, automationPassport, onReadinessAction }: { workflowId: string; onClose: () => void; automationReadiness?: { ready: boolean; items: { title: string; detail: string; action: string; actionCode?: string }[] } | null; automationPassport?: { id: number; checkedAt: string; checkedBy: string; matchesCurrentGraph: boolean } | null; onReadinessAction?: (actionCode?: string) => void }) {
  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-5 border-b flex items-center gap-2 shrink-0">
        <span className="text-sm font-medium">⚡ 自動觸發</span>
        <button onClick={onClose} className="ml-auto faint hover:text-[var(--text)]" aria-label="關閉">✕</button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {automationReadiness && !automationReadiness.ready && (
          <div className="rounded-lg border p-3 text-xs leading-relaxed" style={{ borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))", background: "color-mix(in srgb, var(--amber) 8%, transparent)", color: "var(--text)" }}>
            <div className="font-medium mb-1" style={{ color: "var(--amber)" }}>⚠️ 自動觸發還有 {automationReadiness.items.length} 個啟用前檢查</div>
            <div className="space-y-2">
              {automationReadiness.items.map((item) => <div key={item.title} className="rounded-md border p-2" style={{ borderColor: "color-mix(in srgb, var(--amber) 25%, var(--border))" }}><div className="font-medium">{item.title}</div><div>{item.detail}</div><div className="faint">下一步：{item.action}</div>{onReadinessAction && <button type="button" className="btn btn-ghost text-xs mt-2" onClick={() => onReadinessAction(item.actionCode)}>{item.actionCode === "start-safe-test" ? "開始安全試跑" : item.actionCode === "open-settings" ? "前往設定" : item.actionCode === "open-n8n-review" ? "開啟遷移核對" : item.actionCode === "open-safety" ? "查看只讀保護" : "回到流程"}</button>}</div>)}
              {automationPassport && <div className="faint border-t pt-2 mt-2">檢查護照 #{automationPassport.id} · 最近檢查於 {automationPassport.checkedAt}（{automationPassport.checkedBy}）{automationPassport.matchesCurrentGraph ? " · 對應目前版本" : " · 不是目前版本，需重新檢查"}</div>}
            </div>
          </div>
        )}
        {automationReadiness?.ready && automationPassport && (
          <div className="rounded-lg border p-3 text-xs leading-relaxed" style={{ borderColor: "color-mix(in srgb, var(--green) 35%, var(--border))", background: "color-mix(in srgb, var(--green) 6%, transparent)" }}>
            <div className="font-medium" style={{ color: "var(--green)" }}>✓ 啟用護照已通過</div>
            <div>這一版流程已完成自動觸發檢查；最近檢查於 {automationPassport.checkedAt}（{automationPassport.checkedBy}）。</div>
          </div>
        )}
        <ScheduleSection workflowId={workflowId} />
        <HealthCheckSection workflowId={workflowId} />
        <WatchSection workflowId={workflowId} />
        <WebhookSection workflowId={workflowId} />
        <MailSection workflowId={workflowId} />
        <TelegramSection workflowId={workflowId} />
        <LineSection workflowId={workflowId} />
        <OnFailureSection workflowId={workflowId} />
        <SafetyContractSection workflowId={workflowId} />
      </div>
    </div>
  );
}

/* ---------- ①½ 安全健康巡檢 ---------- */

interface HealthCheckState {
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string | null;
  activeBatchId: string | null;
  lastStatus: string | null;
  lastSummary: string | null;
  lastFinishedAt: string | null;
  currentScenarioCount: number;
  staleScenarioCount: number;
  items: { id: string; scenarioName: string; status: string; matched: boolean | null; mismatches: string[]; error: string | null }[];
}

const HEALTH_INTERVAL_LABELS: Record<number, string> = { 15: "每 15 分鐘", 60: "每小時", 360: "每 6 小時", 1440: "每天" };

function HealthCheckSection({ workflowId }: { workflowId: string }) {
  const [health, setHealth] = useState<HealthCheckState | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const response = await fetch(`/api/workflows/${workflowId}/health-check`);
    const data = response.ok ? await response.json() : null;
    if (data?.healthCheck) setHealth(data.healthCheck as HealthCheckState);
  }
  useEffect(() => {
    // 這張卡只讀自己的流程狀態；流程切換時重新載入，避免顯示上一條流程的巡檢結果。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  async function save(enabled: boolean) {
    if (!health) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/health-check`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, intervalMinutes: health.intervalMinutes }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "無法更新安全巡檢");
      setHealth(data.healthCheck as HealthCheckState);
      setMessage(enabled ? "已啟用；之後只會安全重播情境，不會寫入或發送資料。" : "已停用自動巡檢；已保存的情境不會被刪除。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "無法更新安全巡檢");
    } finally { setSaving(false); }
  }

  async function runNow() {
    setRunning(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/health-check`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "無法開始安全巡檢");
      setMessage("已開始安全巡檢；讀取與計算會真的進行，但寫入、寄送和通知都會被攔住。");
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const latest = await fetch(`/api/workflows/${workflowId}/health-check`).then((r) => r.json());
        if (latest.healthCheck) {
          setHealth(latest.healthCheck as HealthCheckState);
          if (!latest.healthCheck.activeBatchId) break;
        }
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "無法開始安全巡檢");
    } finally { setRunning(false); }
  }

  if (!health) return null;
  const statusText = health.activeBatchId ? "巡檢進行中" : health.lastStatus === "passed" ? "最近一次全部通過" : health.lastStatus === "failed" ? "最近一次發現退化" : health.lastStatus === "stale" ? "需要重新保存情境" : "尚未巡檢";
  const statusColor = health.activeBatchId || health.lastStatus === "passed" ? "var(--green)" : health.lastStatus === "failed" ? "var(--red)" : "var(--amber)";
  return (
    <section className="card p-3" aria-label="安全健康巡檢">
      <SectionTitle icon="🛡️" title="安全健康巡檢" badge={<StateBadge on={health.enabled} onText="自動守護中" offText="未啟用" />} />
      <p className="text-xs muted leading-relaxed mb-3">平台會定期重播你已保存的正確情境，確認流程改版後仍做對；只讀取與計算，絕不寫入、寄信或發送通知。</p>
      <div className="rounded-md border p-2 text-xs mb-3" style={{ borderColor: `color-mix(in srgb, ${statusColor} 35%, var(--border))` }}>
        <div className="font-medium" style={{ color: statusColor }}>{statusText}</div>
        <div className="faint mt-1">目前版本有 {health.currentScenarioCount} 個可檢查情境{health.staleScenarioCount ? `，另有 ${health.staleScenarioCount} 個舊版情境` : ""}。</div>
        {health.lastSummary && <div className="mt-1">{health.lastSummary}</div>}
      </div>
      <div className="flex items-center gap-2 mb-3">
        <select aria-label="健康巡檢頻率" className="input text-sm flex-1" value={health.intervalMinutes} onChange={(e) => setHealth({ ...health, intervalMinutes: Number(e.target.value) })}>
          {Object.entries(HEALTH_INTERVAL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button className="btn btn-ghost text-xs" disabled={saving || health.enabled} onClick={() => save(true)}>啟用巡檢</button>
        {health.enabled && <button className="btn btn-ghost text-xs" disabled={saving} onClick={() => save(false)}>停用</button>}
      </div>
      <div className="flex gap-2">
        <button className="btn btn-ghost text-xs" disabled={running || Boolean(health.activeBatchId) || health.currentScenarioCount === 0} onClick={runNow}>{running ? "巡檢中…" : "現在檢查一次"}</button>
        {health.currentScenarioCount === 0 && <span className="faint text-xs self-center">先保存至少一個成功情境</span>}
      </div>
      {health.items.length > 0 && !health.activeBatchId && <div className="mt-3 space-y-1">{health.items.slice(0, 8).map((item) => <div key={item.id} className="text-xs flex gap-2"><span>{item.status === "passed" ? "✓" : item.status === "stale" ? "⚠" : "✕"}</span><span>{item.scenarioName}</span>{item.mismatches[0] && <span className="faint truncate">— {item.mismatches[0]}</span>}</div>)}</div>}
      {message && <p className="text-xs mt-3" role="status">{message}</p>}
    </section>
  );
}

export function SectionTitle({ icon, title, badge }: { icon: string; title: string; badge?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="text-sm font-medium">{icon} {title}</span>
      {badge}
    </div>
  );
}

export function StateBadge({ on, onText, offText }: { on: boolean; onText: string; offText: string }) {
  return (
    <span className="text-xs px-1.5 py-0.5 rounded-full" style={on
      ? { background: "color-mix(in srgb, var(--green) 14%, transparent)", color: "var(--green)" }
      : { background: "var(--surface-2)", color: "var(--text-faint)" }}>
      {on ? onText : offText}
    </span>
  );
}

/* ---------- ① 排程 ---------- */

function ScheduleSection({ workflowId }: { workflowId: string }) {
  const [schedules, setSchedules] = useState<{ id: string; enabled: number; cron: string; next_run_at: string | null }[]>([]);
  const [mode, setMode] = useState("quarter");
  const [time, setTime] = useState("09:00");
  const [day, setDay] = useState("1");
  const [weekday, setWeekday] = useState("1");
  const [advanced, setAdvanced] = useState(false);
  const [custom, setCustom] = useState("0 9 1 1,4,7,10 *");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function load() {
    const d = await (await fetch(`/api/workflows/${workflowId}/schedules`)).json();
    setSchedules(d.schedules ?? []);
  }
  useEffect(() => {
    // Reload when the selected workflow changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // load is intentionally scoped to this section and keyed by workflowId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  const buildCronStr = (): string => (advanced ? custom : buildCron({ mode, time, day, weekday }));
  const timeOk = timeValid(time);
  async function add() {
    if (!advanced && !timeOk) return; // 時間被清空/不合法時不送出，避免存進垃圾 cron
    setSaving(true);
    setSaveError(null);
    try {
      // 後端會驗證 cron 格式(自訂 cron 亂打會回 400)，錯誤要顯示出來，不能默默吞掉
      const res = await fetch(`/api/workflows/${workflowId}/schedules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cron: buildCronStr(), params: {} }) });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setSaveError(d?.error ?? "排程建立失敗");
        return;
      }
      await load();
    } catch {
      setSaveError("無法連到伺服器，請再試一次");
    } finally { setSaving(false); }
  }
  async function toggle(s: { id: string; enabled: number }) {
    await fetch(`/api/schedules/${s.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !s.enabled }) });
    load();
  }
  async function remove(id: string) {
    await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    load();
  }

  // 即時預覽：直接把要存的 cron 用 humanizeCron 講成人話，確保「設定時看到的字」= 「存好後清單顯示的字」
  const showDay = mode === "monthly" || mode === "quarter" || mode === "bimonth";

  return (
    <section>
      <SectionTitle icon="⏰" title="排程" badge={<StateBadge on={schedules.some((s) => s.enabled)} onText="啟用中" offText="未設定" />} />
      <p className="text-xs muted leading-relaxed mb-2">時間一到就自動用「上一個期間」跑一次（例如每季 4 月觸發，就自動抓第一季 1～3 月的資料，日期它會自己算對）。</p>
      <div className="space-y-2 mb-3">
        {schedules.map((s) => (
          <div key={s.id} className="card p-3 flex items-center gap-2 text-sm">
            <button onClick={() => toggle(s)} aria-label={s.enabled ? "停用這個排程" : "啟用這個排程"} title={s.enabled ? "已啟用，點一下停用" : "已停用，點一下啟用"}>{s.enabled ? "🟢" : "⚪️"}</button>
            <div className="min-w-0">
              <div className="truncate">{humanizeCron(s.cron)}</div>
              {s.next_run_at && <div className="text-xs faint">下次 {formatScheduleNextRun(s.next_run_at)}</div>}
            </div>
            <button onClick={() => remove(s.id)} className="ml-auto text-xs" style={{ color: "var(--red)" }}>刪除</button>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        {!advanced ? (
          <>
            <div>
              <div className="text-xs faint mb-1.5">多久跑一次？</div>
              <div className="flex flex-wrap gap-1.5">
                {SCHEDULE_MODES.map(([v, l]) => (
                  <button key={v} onClick={() => setMode(v)} className="btn btn-ghost text-sm"
                    style={mode === v ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : undefined}>{l}</button>
                ))}
              </div>
            </div>

            {mode === "weekly" && (
              <div>
                <div className="text-xs faint mb-1.5">星期幾？</div>
                <select value={weekday} onChange={(e) => setWeekday(e.target.value)} className="input">
                  {WEEKDAY_NAMES.map((l, i) => <option key={i} value={i}>星期{l}</option>)}
                </select>
              </div>
            )}
            {showDay && (
              <div>
                <div className="text-xs faint mb-1.5">每個月的幾號？</div>
                <select value={day} onChange={(e) => setDay(e.target.value)} className="input">
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d} 號</option>)}
                </select>
              </div>
            )}
            <div>
              <div className="text-xs faint mb-1.5">幾點執行？</div>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="input" style={!timeOk ? { borderColor: "var(--red)" } : undefined} />
              {!timeOk && <p className="text-xs mt-1" style={{ color: "var(--red)" }}>請選一個時間。</p>}
            </div>

            {timeOk && (
              <div className="card px-3 py-2 text-sm" style={{ background: "var(--surface-2)", borderColor: "var(--accent)" }}>
                <span className="faint text-xs">設定後：</span> <span className="font-medium">{humanizeCron(buildCronStr())}</span> <span className="faint text-xs">自動執行</span>
              </div>
            )}
          </>
        ) : (
          <div>
            <div className="text-xs faint mb-1.5">自訂 cron（給熟悉的人用，格式：分 時 日 月 星期）</div>
            <input value={custom} onChange={(e) => setCustom(e.target.value)} className="input font-mono" placeholder="0 9 1 1,4,7,10 *" />
            <p className="text-xs faint mt-1">目前：{humanizeCron(custom)}</p>
          </div>
        )}

        <button onClick={add} disabled={saving || (!advanced && !timeOk)} className="btn btn-primary w-full justify-center">{saving ? "新增中…" : "＋ 新增這個排程"}</button>
        {saveError && <p className="text-xs" style={{ color: "var(--red)" }}>{saveError}</p>}
        <div className="flex items-center justify-between text-xs faint">
          <span>需要電腦開著才會準時觸發，關機/睡眠時不會跑。</span>
          <button onClick={() => setAdvanced(!advanced)} className="underline shrink-0 ml-2">{advanced ? "← 用簡單設定" : "進階"}</button>
        </div>
      </div>
    </section>
  );
}

/* ---------- ② 資料夾監聽 ---------- */

function WatchSection({ workflowId }: { workflowId: string }) {
  const [watchPath, setWatchPath] = useState("");
  const [watchPattern, setWatchPattern] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [savedPattern, setSavedPattern] = useState("");
  const [wfStatus, setWfStatus] = useState<"draft" | "official">("draft");
  const [builtin, setBuiltin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await (await fetch(`/api/workflows/${workflowId}`)).json();
        if (!alive || !d.workflow) return;
        const trigger = (d.workflow.nodes ?? []).find((n: { type: string }) => n.type === "trigger");
        const path = String(trigger?.config?.watchPath ?? "");
        const pattern = String(trigger?.config?.watchPattern ?? "");
        setWatchPath(path); setSavedPath(path);
        setWatchPattern(pattern); setSavedPattern(pattern);
        setWfStatus(d.workflow.status === "official" ? "official" : "draft");
        setBuiltin(Boolean(d.workflow.builtin));
      } catch { /* 讀不到就維持空白，儲存時後端會回真正的錯誤 */ }
    })();
    return () => { alive = false; };
  }, [workflowId]);

  const dirty = watchPath !== savedPath || watchPattern !== savedPattern;
  const active = savedPath.trim().length > 0;

  async function save() {
    setSaving(true); setError(null); setJustSaved(false);
    try {
      const res = await fetch(`/api/workflows/${workflowId}/trigger-config`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watchPath, watchPattern }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setError(d?.error ?? "儲存失敗"); return; }
      setSavedPath(d.watchPath ?? watchPath.trim());
      setSavedPattern(d.watchPattern ?? watchPattern.trim());
      setWatchPath(d.watchPath ?? watchPath.trim());
      setWatchPattern(d.watchPattern ?? watchPattern.trim());
      setJustSaved(true);
    } catch {
      setError("無法連到伺服器，請再試一次");
    } finally { setSaving(false); }
  }

  return (
    <section className="border-t pt-4">
      <SectionTitle icon="📁" title="資料夾監聽" badge={<StateBadge on={active && wfStatus === "official"} onText="監聽中" offText={active ? "待設為正式" : "未設定"} />} />
      <p className="text-xs muted leading-relaxed mb-2">盯著一個資料夾；有新檔案放進去時，就把那份檔案交給這條流程處理。</p>
      <div className="space-y-2">
        <div>
          <div className="text-xs faint mb-1.5">要監聽哪個資料夾？（完整路徑）</div>
          <input value={watchPath} onChange={(e) => setWatchPath(e.target.value)} className="input font-mono text-xs" placeholder="/Users/你的名字/Downloads/收件匣" disabled={builtin} />
        </div>
        <div>
          <div className="text-xs faint mb-1.5">只理會檔名包含…（留空＝任何檔案）</div>
          <input value={watchPattern} onChange={(e) => setWatchPattern(e.target.value)} className="input text-sm" placeholder="例如 .xlsx 或 月報" disabled={builtin} />
        </div>
        {dirty && (
          <button onClick={save} disabled={saving} className="btn btn-primary w-full justify-center">{saving ? "儲存中…" : "儲存監聽設定"}</button>
        )}
        {justSaved && !dirty && <p className="text-xs" style={{ color: "var(--green)" }}>✓ 已儲存。</p>}
        {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}
        {builtin && <p className="text-xs faint">內建範例不能改設定，先按「複製流程」再設。</p>}
        {active && wfStatus !== "official" && !builtin && (
          <p className="text-xs leading-relaxed" style={{ color: "var(--cat-trigger)" }}>⚠️ 監聽只對「正式」流程生效——先按右上角「⋯ → 設為正式」才會開始盯資料夾（避免還在測試中的流程被誤觸發）。</p>
        )}
        {active && (
          <p className="text-xs faint leading-relaxed">啟用當下資料夾裡「已經存在」的檔案不會觸發，只有之後新進來的檔案才會（每 10 秒檢查一次，等檔案寫完才跑）。</p>
        )}
      </div>
    </section>
  );
}

/* ---------- ③ Webhook ---------- */

function WebhookSection({ workflowId }: { workflowId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await (await fetch(`/api/workflows/${workflowId}/webhook`)).json();
        if (!alive) return;
        setEnabled(Boolean(d.enabled));
        setUrl(d.url ?? null);
      } catch { /* 讀不到就顯示未啟用，按啟用時後端會回真正的錯誤 */ }
    })();
    return () => { alive = false; };
  }, [workflowId]);

  async function call(method: "POST" | "DELETE") {
    setBusy(true); setError(null); setCopied(false);
    try {
      const res = await fetch(`/api/workflows/${workflowId}/webhook`, { method });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setError(d?.error ?? "操作失敗"); return; }
      setEnabled(Boolean(d.enabled));
      setUrl(d.url ?? null);
    } catch {
      setError("無法連到伺服器，請再試一次");
    } finally { setBusy(false); }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("複製失敗，請直接選取網址複製");
    }
  }

  return (
    <section className="border-t pt-4">
      <SectionTitle icon="🔗" title="由另一個工具開始" badge={<StateBadge on={enabled} onText="啟用中" offText="未啟用" />} />
      <p className="text-xs muted leading-relaxed mb-2">如果你有手機捷徑、另一個程式或另一條流程要啟動這條流程，開啟後把下面的專屬網址貼給它即可。不確定要不要用這個功能時，直接在對話問 AI。</p>
      {!enabled ? (
        <button onClick={() => call("POST")} disabled={busy} className="btn btn-primary w-full justify-center">{busy ? "啟用中…" : "建立專屬啟動網址"}</button>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-1.5">
            <input readOnly value={url ?? ""} className="input font-mono text-xs flex-1 min-w-0" onFocus={(e) => e.currentTarget.select()} />
            <button onClick={copy} className="btn btn-ghost shrink-0 text-sm">{copied ? "✓ 已複製" : "複製"}</button>
          </div>
          <div className="pt-1">
            <div className="text-xs faint mb-1">📝 表單網址(同一把鑰匙的「人類版」——用瀏覽器開，填表送出即觸發)</div>
            <div className="flex gap-1.5">
              <input readOnly value={url ? url.replace("/api/hooks/", "/form/") : ""} className="input font-mono text-xs flex-1 min-w-0" onFocus={(e) => e.currentTarget.select()} />
              <button onClick={async () => { if (url) { await navigator.clipboard.writeText(url.replace("/api/hooks/", "/form/")); setCopied(true); setTimeout(() => setCopied(false), 1500); } }} className="btn btn-ghost shrink-0 text-sm">複製</button>
            </div>
            <p className="text-xs faint mt-1">用瀏覽器打開這個網址，填完表單送出後就會開始執行。沒有特別需要時不必使用它。</p>
          </div>
          <p className="text-xs faint leading-relaxed">網址本身就是鑰匙，別貼到公開的地方；不小心外流就按「重新產生」，舊網址立刻失效。伺服器只聽本機，所以只有這台電腦上的程式打得到。</p>
          <div className="flex gap-1.5">
            <button
              onClick={() => { if (confirm("重新產生後，舊網址立刻失效，用舊網址的工具要換新的。確定？")) call("POST"); }}
              disabled={busy} className="btn btn-ghost flex-1 justify-center text-sm">重新產生</button>
            <button
              onClick={() => { if (confirm("停用後這個網址就打不通了。確定停用？")) call("DELETE"); }}
              disabled={busy} className="btn btn-ghost flex-1 justify-center text-sm" style={{ color: "var(--red)" }}>停用</button>
          </div>
        </div>
      )}
      {error && <p className="text-xs mt-2" style={{ color: "var(--red)" }}>{error}</p>}
    </section>
  );
}

/* ---------- ④ 失敗備援：這條流程失敗時自動執行另一條流程 ---------- */

function OnFailureSection({ workflowId }: { workflowId: string }) {
  const [current, setCurrent] = useState<string>("");
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [wfRes, listRes] = await Promise.all([
          fetch(`/api/workflows/${workflowId}`),
          fetch(`/api/workflows`),
        ]);
        const wfData = await wfRes.json();
        const listData = await listRes.json();
        setCurrent(wfData.workflow?.onFailureWorkflow ?? "");
        setOptions(
          ((listData.workflows ?? []) as { id: string; name: string }[]).filter((w) => w.id !== workflowId),
        );
      } catch { /* 載入失敗下面存檔時會再報錯 */ }
    })();
  }, [workflowId]);

  async function save(value: string) {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onFailureWorkflow: value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "儲存失敗");
      setCurrent(value);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <SectionTitle icon="🆘" title="失敗時自動執行" badge={<StateBadge on={Boolean(current)} onText="已設定" offText="未設定" />} />
      <p className="text-xs muted leading-relaxed mb-2">
        這條流程執行失敗時，自動執行選定的備援流程(例如「發告警通知」或「改走備用來源」)。
        備援流程可以用 {"{{failedWorkflow}}"}/{"{{failedStep}}"}/{"{{error}}"} 拿到失敗現場資訊。
      </p>
      <select
        className="input w-full text-sm"
        value={current}
        disabled={saving}
        onChange={(e) => save(e.target.value)}
        aria-label="失敗時自動執行的流程"
      >
        <option value="">不自動執行(只發通知)</option>
        {options.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </select>
      {saved && <p className="text-xs mt-1.5" style={{ color: "var(--green)" }}>✓ 已儲存</p>}
      {error && <p className="text-xs mt-1.5" style={{ color: "var(--red)" }}>{error}</p>}
    </section>
  );
}
