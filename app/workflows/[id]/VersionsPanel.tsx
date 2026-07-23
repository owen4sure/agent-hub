"use client";

import { useEffect, useState } from "react";

interface VersionInfo { filename: string; timestamp: string; name: string; nodeCount: number }

export function VersionsPanel({ workflowId, onClose, onRestored }: { workflowId: string; onClose: () => void; onRestored: () => void }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [error, setError] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/workflows/${workflowId}/versions`);
      if (!res.ok) throw new Error();
      const d = await res.json();
      setVersions(d.versions ?? []);
      setError(false);
    } catch {
      setError(true);
    }
  }
  useEffect(() => {
    // Reload when the selected workflow changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // load is intentionally scoped to this panel and keyed by workflowId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  async function restore(filename: string) {
    if (!window.confirm("確定要還原到這個版本嗎？目前的內容會先自動備份一份，還原這個動作本身也可以再復原。")) return;
    setRestoring(filename);
    try {
      const res = await fetch(`/api/workflows/${workflowId}/versions/${encodeURIComponent(filename)}/restore`, { method: "POST" }).catch(() => null);
      if (!res || !res.ok) { window.alert("還原失敗，請再試一次。"); return; }
      const data = (await res.json().catch(() => ({}))) as { warning?: string };
      // 備份只還原流程圖本身，不含排程/Webhook/LINE 這類觸發設定——這次還原的版本若用了不同的
      // 執行參數、且這條流程目前有作用中的自動觸發，後端會回一句警告，這裡要讓使用者看到。
      if (data.warning) window.alert(data.warning);
      onRestored();
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-5 border-b flex items-center gap-2 shrink-0">
        <span className="text-sm font-medium">🕓 版本歷史</span>
        <button onClick={onClose} className="ml-auto faint hover:text-[var(--text)]" aria-label="關閉">✕</button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-3">
        <p className="text-xs muted leading-relaxed">AI 每次改流程圖/改節點設定之前，都會先把「當時的樣子」存一份備份。改壞了、或想拿回之前的版本，都可以在這裡還原。</p>
        {error && <p className="text-sm" style={{ color: "var(--red)" }}>載入版本紀錄失敗，請重試。</p>}
        {!versions && !error && <p className="text-sm muted">載入中…</p>}
        {versions?.length === 0 && <p className="text-sm faint py-2">目前還沒有版本備份(AI 還沒改過這個流程)。</p>}
        {versions?.map((v) => (
          <div key={v.filename} className="card p-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{v.name}</div>
              <div className="text-xs faint">{v.timestamp} · {v.nodeCount} 個節點</div>
            </div>
            <button onClick={() => restore(v.filename)} disabled={restoring === v.filename} className="btn btn-ghost text-xs shrink-0">
              {restoring === v.filename ? "還原中…" : "還原這個版本"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
