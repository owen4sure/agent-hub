"use client";

import { useEffect, useState } from "react";

interface VersionInfo { filename: string; timestamp: string; name: string; nodeCount: number }
interface ChangeSummary {
  from: { name: string; nodeCount: number; edgeCount: number };
  to: { name: string; nodeCount: number; edgeCount: number };
  addedNodes: { id: string; label: string; type: string; effects: string[] }[];
  removedNodes: { id: string; label: string; type: string; effects: string[] }[];
  changedNodes: { id: string; label: string; type: string; changes: string[]; effectsAdded: string[]; effectsRemoved: string[] }[];
  addedEdges: { from: string; to: string; fromPort?: string }[];
  removedEdges: { from: string; to: string; fromPort?: string }[];
  triggerParamsChanged: boolean;
  riskEffectsAdded: string[];
  hasChanges: boolean;
}

export function VersionsPanel({ workflowId, onClose, onRestored }: { workflowId: string; onClose: () => void; onRestored: () => void }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [error, setError] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ filename: string; summary: ChangeSummary } | null>(null);
  const [diffLoading, setDiffLoading] = useState<string | null>(null);

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

  async function showDiff(filename: string) {
    if (diff?.filename === filename) { setDiff(null); return; }
    setDiffLoading(filename);
    try {
      const res = await fetch("/api/workflows/" + workflowId + "/versions/" + encodeURIComponent(filename) + "/diff");
      if (!res.ok) throw new Error();
      const data = await res.json() as { filename: string; summary: ChangeSummary };
      setDiff(data);
    } catch {
      window.alert("無法讀取這個版本的差異，請再試一次。");
    } finally {
      setDiffLoading(null);
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
          <div key={v.filename} className="card p-3 space-y-2">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{v.name}</div>
                <div className="text-xs faint">{v.timestamp} · {v.nodeCount} 個節點</div>
              </div>
              <button onClick={() => showDiff(v.filename)} disabled={diffLoading === v.filename} className="btn btn-ghost text-xs shrink-0">
                {diffLoading === v.filename ? "比較中…" : diff?.filename === v.filename ? "收起差異" : "查看差異"}
              </button>
              <button onClick={() => restore(v.filename)} disabled={restoring === v.filename} className="btn btn-ghost text-xs shrink-0">
                {restoring === v.filename ? "還原中…" : "還原這個版本"}
              </button>
            </div>
            {diff?.filename === v.filename && <ChangeSummaryCard summary={diff.summary} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function ChangeSummaryCard({ summary }: { summary: ChangeSummary }) {
  if (!summary.hasChanges) return <div className="border-t pt-2 text-xs" style={{ color: "var(--green)" }}>✓ 和目前流程沒有執行上的差異（只有畫布位置或相同內容）。</div>;
  return <div className="border-t pt-2 space-y-2 text-xs leading-relaxed">
    <div className="font-medium">這個版本和目前流程的差異</div>
    <div className="flex flex-wrap gap-1.5">
      {summary.addedNodes.length > 0 && <span className="badge badge-neutral" style={{ color: "var(--green)" }}>新增 {summary.addedNodes.length} 步</span>}
      {summary.removedNodes.length > 0 && <span className="badge badge-neutral" style={{ color: "var(--red)" }}>刪除 {summary.removedNodes.length} 步</span>}
      {summary.changedNodes.length > 0 && <span className="badge badge-neutral" style={{ color: "var(--accent)" }}>修改 {summary.changedNodes.length} 步</span>}
      {summary.addedEdges.length > 0 && <span className="badge badge-neutral">新增 {summary.addedEdges.length} 條連線</span>}
      {summary.removedEdges.length > 0 && <span className="badge badge-neutral">移除 {summary.removedEdges.length} 條連線</span>}
      {summary.triggerParamsChanged && <span className="badge badge-neutral" style={{ color: "var(--amber)" }}>執行時參數改變</span>}
    </div>
    {summary.addedNodes.length > 0 && <div><span className="faint">新增：</span>{summary.addedNodes.map((node) => <span key={node.id} className="ml-1">{node.label}{node.effects.length > 0 ? "（會" + effectWords(node.effects) + "）" : ""}</span>)}</div>}
    {summary.removedNodes.length > 0 && <div><span className="faint">刪除：</span>{summary.removedNodes.map((node) => <span key={node.id} className="ml-1">{node.label}</span>)}</div>}
    {summary.changedNodes.length > 0 && <div><span className="faint">修改：</span>{summary.changedNodes.map((node) => <span key={node.id} className="ml-1">{node.label}（{node.changes.join("、")}{node.effectsAdded.length > 0 ? "，新增會" + effectWords(node.effectsAdded) : ""}）</span>)}</div>}
    {summary.riskEffectsAdded.length > 0 && <div className="rounded border p-2" style={{ color: "var(--amber)", borderColor: "color-mix(in srgb, var(--amber) 40%, var(--border))" }}>⚠️ 這個版本新增可能產生副作用的能力：{effectWords(summary.riskEffectsAdded)}。正式執行前仍會要求安全檢查。</div>}
  </div>;
}

function effectWords(effects: string[]): string {
  const labels: Record<string, string> = { email: "寄信", notify: "通知", "file-write": "產生檔案", "file-modify": "修改檔案", "remote-write": "寫入外部服務", "approval-request": "送簽核", delegated: "呼叫其他流程" };
  return effects.map((effect) => labels[effect] ?? effect).join("、");
}
