import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm muted mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, tone, icon }: { label: string; value: ReactNode; tone?: "green" | "red" | "accent"; icon?: string }) {
  const color = tone === "green" ? "var(--green)" : tone === "red" ? "var(--red)" : tone === "accent" ? "var(--accent)" : "var(--text)";
  return (
    <div className="card px-4 py-3 flex-1 min-w-[130px] flex items-center gap-3">
      {icon && (
        <span
          className="grid place-items-center w-9 h-9 rounded-lg text-base shrink-0"
          style={{
            background: tone ? `color-mix(in srgb, ${color} 12%, transparent)` : "var(--surface-2)",
            border: `1px solid ${tone ? `color-mix(in srgb, ${color} 25%, transparent)` : "var(--border)"}`,
          }}
        >
          {icon}
        </span>
      )}
      <div>
        <div className="text-xs faint">{label}</div>
        <div className="text-xl font-semibold mt-0.5 tracking-tight" style={{ color }}>{value}</div>
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
