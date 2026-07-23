import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm muted mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap sm:shrink-0">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, tone, icon }: { label: string; value: ReactNode; tone?: "green" | "red" | "accent"; icon?: string }) {
  const color = tone === "green" ? "var(--green)" : tone === "red" ? "var(--red)" : tone === "accent" ? "var(--accent)" : "var(--text)";
  return (
    <div className="card px-4 py-3.5 flex-1 min-w-[130px] flex items-center gap-3">
      {icon && (
        <span
          className="grid place-items-center w-10 h-10 rounded-xl text-lg shrink-0"
          style={{
            background: tone ? `color-mix(in srgb, ${color} 14%, transparent)` : "var(--surface-2)",
            border: `1px solid ${tone ? `color-mix(in srgb, ${color} 28%, transparent)` : "var(--border)"}`,
            boxShadow: tone ? `0 4px 14px -6px color-mix(in srgb, ${color} 55%, transparent)` : "none",
          }}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <div className="text-xs faint">{label}</div>
        <div className="text-[26px] leading-none font-semibold mt-1 tracking-tight tabular-nums" style={{ color }}>{value}</div>
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, hint, action }: { icon: string; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="card border-dashed flex flex-col items-center text-center py-14 px-6">
      <div className="text-4xl mb-3">{icon}</div>
      <p className="font-medium">{title}</p>
      {hint && <p className="text-sm muted mt-1 max-w-sm">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
  const color =
    status === "success" ? "var(--green)" : status === "failed" ? "var(--red)" : status === "running" || status === "queued" || status === "waiting" ? "var(--amber)" : "var(--border-strong)";
  const pulse = status === "running" || status === "queued" || status === "waiting";
  return (
    <span
      className={`inline-block rounded-full ${pulse ? "animate-pulse" : ""}`}
      style={{ width: size, height: size, background: color }}
    />
  );
}

export function statusLabel(status: string): string {
  return { success: "成功", failed: "失敗", running: "執行中", queued: "排隊中", pending: "待執行", skipped: "略過", waiting: "⏸ 等簽核" }[status] ?? status;
}

/** 統一的日期顯示：把 SQLite 的 "YYYY-MM-DD HH:mm:ss"(UTC) 顯示成好讀的本地時間 */
export function formatDate(s?: string | null): string {
  if (!s) return "";
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 排程的 next_run_at 是 lib/scheduler.ts 的 computeNextRun/taipeiParts 早就換算好的「台北本地時間」
 * naive 字串(跟 SQLite datetime('now') 那種真正的 UTC 時間戳記完全不同來源)，不能套用上面 formatDate()
 * 的「當作 UTC 再轉本地」邏輯——那會把本來就已經是本地時間的值再多加一次 +8 小時。
 * 真實踩過的事故：排程設「早上 9:00」，套用 formatDate 後畫面顯示「17:00」，使用者以為排程時間跑掉了，
 * 其實只是顯示層多轉了一次時區，真正觸發時間(scheduler tick 全程用同一套台北 naive 字串比對)完全正確。
 * 這裡只重排分隔符號，不做任何時區換算。 */
export function formatScheduleNextRun(s?: string | null): string {
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return s;
  const [, y, mo, d, h, mi] = m;
  return `${y}/${mo}/${d} ${h}:${mi}`;
}

/** 把 "09:00" 這種 24 小時字串講成「早上 9:00」讓非工程背景的人一看就懂 */
export function friendlyTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return hhmm;
  const mm = String(m).padStart(2, "0");
  if (h === 0) return `凌晨 12:${mm}`;
  if (h < 6) return `凌晨 ${h}:${mm}`;
  if (h < 12) return `早上 ${h}:${mm}`;
  if (h === 12) return `中午 12:${mm}`;
  if (h < 18) return `下午 ${h - 12}:${mm}`;
  return `晚上 ${h - 12}:${mm}`;
}

/** 把 cron 表達式翻成好讀的中文(涵蓋本平台產生的幾種模式) */
export function humanizeCron(cron: string): string {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [min, hour, day, month, wk] = p;
  const isInt = (s: string) => /^\d+$/.test(s);
  // 分/時必須是單純數字才能講成「早上 9:00」；遇到 */15、1-5 這種進階寫法就原樣顯示，不硬翻成亂碼
  if (!isInt(min) || !isInt(hour)) return cron;
  const t = friendlyTime(`${hour.padStart(2, "0")}:${min.padStart(2, "0")}`);
  const wkNames = ["日", "一", "二", "三", "四", "五", "六"];
  if (day === "*" && month === "*" && wk === "*") return `每天 ${t}`;
  if (isInt(wk) && day === "*") return `每週${wkNames[Number(wk) % 7] ?? wk} ${t}`;
  if (isInt(day) && month === "1,4,7,10") return `每季（1、4、7、10 月）${day} 號 ${t}`;
  if (isInt(day) && month === "1,3,5,7,9,11") return `每兩個月 ${day} 號 ${t}`;
  if (isInt(day) && month === "*") return `每月 ${day} 號 ${t}`;
  return cron;
}
