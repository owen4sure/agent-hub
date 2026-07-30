"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 稽核軌跡：把「誰(從哪個管道)、什麼時候、對哪個對象做了什麼」攤在畫面上。
 *
 * 這張卡刻意用白話呈現，因為它要回答的是**人**的問題(誰核准的、誰改了流程、誰看了帳密)，
 * 不是技術問題。動作代號(workflow.update 這種)一律轉成中文，時間顯示成「幾分鐘前」。
 * 只在使用者主動展開時才去查，不佔設定頁的載入時間。
 */

interface Entry {
  id: number;
  at: string;
  actor: string;
  actorLabel: string;
  action: string;
  actionLabel: string;
  target: string | null;
  detail: string | null;
}

const FILTERS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "approval", label: "核准/拒絕" },
  { key: "secret", label: "帳密" },
  { key: "workflow", label: "流程" },
  { key: "schedule", label: "排程" },
];

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return iso;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-TW");
}

export function AuditLogCard() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (action: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/audit-log?limit=100${action ? `&action=${encodeURIComponent(action)}` : ""}`);
      const data = (await res.json().catch(() => ({}))) as { entries?: Entry[]; total?: number; error?: string };
      if (!res.ok) throw new Error(data.error || "讀取失敗");
      setEntries(data.entries ?? []);
      setTotal(data.total ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "讀取失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load(filter);
  }, [open, filter, load]);

  return (
    <section className="card p-4">
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center justify-between text-left">
        <span>
          <span className="font-semibold">🧾 稽核軌跡</span>
          <span className="text-xs muted ml-2">誰、什麼時候、對什麼做了什麼</span>
        </span>
        <span className="muted text-sm">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs muted">
            記的是「人做的動作」——核准/拒絕、改流程、看帳密、手動觸發、改設定。
            執行過程本身在「執行紀錄」那頁。這台機器是單人使用、沒有帳號系統，所以這裡記得到的是
            <b>從哪個管道做的</b>(本機瀏覽器 / 腳本 / Telegram 按鈕 / 簽核連結)，不是哪個人。
          </p>

          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className="btn btn-ghost text-xs"
                style={filter === f.key ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined}
              >
                {f.label}
              </button>
            ))}
            <button type="button" onClick={() => void load(filter)} className="btn btn-ghost text-xs ml-auto">↻ 重新讀取</button>
          </div>

          {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}
          {loading && <p className="text-xs muted">讀取中…</p>}
          {!loading && entries.length === 0 && !error && (
            <p className="text-xs muted">還沒有紀錄。核准一次、改一次流程或看一次帳密之後，這裡就會有內容。</p>
          )}

          {entries.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="muted text-left">
                      <th className="py-1 pr-3 font-medium">時間</th>
                      <th className="py-1 pr-3 font-medium">做了什麼</th>
                      <th className="py-1 pr-3 font-medium">從哪裡</th>
                      <th className="py-1 pr-3 font-medium">對象</th>
                      <th className="py-1 font-medium">細節</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.id} className="border-t align-top">
                        <td className="py-1.5 pr-3 whitespace-nowrap" title={e.at}>{relativeTime(e.at)}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">{e.actionLabel}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap muted">{e.actorLabel}</td>
                        <td className="py-1.5 pr-3 font-mono break-all">{e.target ?? "—"}</td>
                        <td className="py-1.5 font-mono break-all muted">{e.detail ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {total !== null && <p className="text-xs faint">共 {total} 筆，顯示最近 {entries.length} 筆。</p>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
