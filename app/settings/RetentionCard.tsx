"use client";

// 這是瀏覽器端元件，絕對不能從 lib/auditLog 匯入任何東西——那個模組會拉進 lib/db(better-sqlite3)，
// 整個前端打包會直接失敗(Can't resolve 'fs')。文字就寫死在這裡。
import { useCallback, useEffect, useState } from "react";

/**
 * 資料保留期限設定。
 *
 * 兩個刻意的設計，都是因為「刪除不可逆」：
 * ①改天數不會立刻刪東西——不然使用者調整數字的過程中就把資料刪掉了。
 * ②畫面永遠先顯示「現在按清理會刪掉多少」，讓他按之前就看得到後果。
 */

interface Policy { debugArtifactDays: number; runRecordDays: number }
interface Preview { debugDirsRemoved: number; runsRemoved: number }

export function RetentionCard() {
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/retention");
      const data = (await res.json().catch(() => ({}))) as { policy?: Policy; preview?: Preview; error?: string };
      if (!res.ok) throw new Error(data.error || "讀取失敗");
      setPolicy(data.policy ?? null);
      setPreview(data.preview ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "讀取失敗");
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function save(next: Partial<Policy>) {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const res = await fetch("/api/retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = (await res.json().catch(() => ({}))) as { policy?: Policy; preview?: Preview; error?: string };
      if (!res.ok) throw new Error(data.error || "儲存失敗");
      setPolicy(data.policy ?? null);
      setPreview(data.preview ?? null);
      setMessage("已儲存。清理會在每天自動執行一次，也可以按下面的按鈕立刻清。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  async function sweepNow() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const res = await fetch("/api/retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runNow: true }),
      });
      const data = (await res.json().catch(() => ({}))) as { result?: Preview; error?: string };
      if (!res.ok) throw new Error(data.error || "清理失敗");
      setMessage(`已清理：除錯檔 ${data.result?.debugDirsRemoved ?? 0} 份、執行紀錄 ${data.result?.runsRemoved ?? 0} 筆。`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "清理失敗");
    } finally {
      setBusy(false);
    }
  }

  const nothingToDelete = preview !== null && preview.debugDirsRemoved === 0 && preview.runsRemoved === 0;

  return (
    <section className="card p-4">
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center justify-between text-left">
        <span>
          <span className="font-semibold">🗂️ 資料保留期限</span>
          <span className="text-xs muted ml-2">截圖、頁面內容、執行紀錄最多留多久</span>
        </span>
        <span className="muted text-sm">{open ? "▲" : "▼"}</span>
      </button>

      {open && policy && (
        <div className="mt-3 space-y-4">
          <p className="text-xs muted">
            每條流程本來就只保留<b>最近 20 次</b>執行(更舊的連截圖和產出檔一起自動刪掉)，所以磁碟不會無限長大。
            但「20 次」跟「多久」是兩件事——一條每月跑一次的流程，20 次等於快兩年的登入後截圖留在電腦裡。
            下面設定的是<b>時間</b>上限。
          </p>

          <div className="space-y-1">
            <label className="text-sm font-medium">除錯用的截圖與頁面內容</label>
            <p className="text-xs muted">
              失敗時存下來的畫面截圖與整頁內容。這是最敏感的一種資料(會包含登入後的畫面、名單、金額)，
              而它的用途只有「查最近為什麼失敗」。刪掉之後執行紀錄還在，只是沒有截圖可以看。
            </p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={3650}
                value={policy.debugArtifactDays}
                onChange={(e) => setPolicy({ ...policy, debugArtifactDays: Number(e.target.value) })}
                className="input w-24 text-sm"
              />
              <span className="text-sm muted">天後刪除（0 = 不按時間刪）</span>
              <button type="button" disabled={busy} onClick={() => void save({ debugArtifactDays: policy.debugArtifactDays })} className="btn btn-ghost text-xs">儲存</button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">執行紀錄與產出檔案</label>
            <p className="text-xs muted">
              整筆執行紀錄(含產出的報表檔)。預設<b>不</b>按時間刪——那是你的成果與軌跡，要不要丟掉由你決定。
            </p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={3650}
                value={policy.runRecordDays}
                onChange={(e) => setPolicy({ ...policy, runRecordDays: Number(e.target.value) })}
                className="input w-24 text-sm"
              />
              <span className="text-sm muted">天後刪除（0 = 不按時間刪）</span>
              <button type="button" disabled={busy} onClick={() => void save({ runRecordDays: policy.runRecordDays })} className="btn btn-ghost text-xs">儲存</button>
            </div>
          </div>

          <div className="border-t pt-3 space-y-2">
            <p className="text-xs">
              {nothingToDelete
                ? "目前沒有超過期限的資料，按清理不會刪掉任何東西。"
                : `現在按清理會刪掉：除錯檔 ${preview?.debugDirsRemoved ?? 0} 份、執行紀錄 ${preview?.runsRemoved ?? 0} 筆。`}
            </p>
            <button type="button" disabled={busy || nothingToDelete} onClick={() => void sweepNow()} className="btn btn-ghost text-xs">
              {busy ? "處理中…" : "🧹 立刻清理一次"}
            </button>
            <p className="text-xs faint">每天也會自動執行一次；清理動作會記進下面的「稽核軌跡」。</p>
          </div>

          {message && <p className="text-xs" style={{ color: "var(--green)" }}>{message}</p>}
          {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}
        </div>
      )}
    </section>
  );
}
