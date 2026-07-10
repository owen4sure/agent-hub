"use client";

import { useEffect, useState } from "react";
import { formatDate, humanizeCron } from "@/components/ui";
import { SCHEDULE_MODES, WEEKDAY_NAMES, buildCron, timeValid } from "@/lib/cron";

export function SchedulePanel({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
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
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [workflowId]);

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
    <div className="flex flex-col h-full">
      <div className="h-14 px-5 border-b flex items-center gap-2">
        <span className="text-sm font-medium">⏰ 排程自動執行</span>
        <button onClick={onClose} className="ml-auto faint hover:text-[var(--text)]" aria-label="關閉">✕</button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-3">
        <p className="text-xs muted leading-relaxed">設定好時間，之後不用手動按執行——時間一到就自動用「上一個期間」跑一次（例如每季 4 月觸發，就自動抓第一季 1～3 月的資料，日期它會自己算對）。</p>
        {schedules.length === 0 && <p className="text-sm faint py-2">目前沒有任何排程。</p>}
        {schedules.map((s) => (
          <div key={s.id} className="card p-3 flex items-center gap-2 text-sm">
            <button onClick={() => toggle(s)} aria-label={s.enabled ? "停用這個排程" : "啟用這個排程"} title={s.enabled ? "已啟用，點一下停用" : "已停用，點一下啟用"}>{s.enabled ? "🟢" : "⚪️"}</button>
            <div className="min-w-0">
              <div className="truncate">{humanizeCron(s.cron)}</div>
              {s.next_run_at && <div className="text-xs faint">下次 {formatDate(s.next_run_at)}</div>}
            </div>
            <button onClick={() => remove(s.id)} className="ml-auto text-xs" style={{ color: "var(--red)" }}>刪除</button>
          </div>
        ))}
      </div>

      <div className="border-t p-4 space-y-3">
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
    </div>
  );
}
