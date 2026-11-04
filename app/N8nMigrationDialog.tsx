"use client";

import { useRef, useState } from "react";

export interface N8nImportResult {
  id: string;
  clearedCodeCount: number;
  clearedCredentialCount: number;
  reviewCount: number;
  unsupportedCount: number;
}

interface Analysis {
  name: string;
  nodeCount: number;
  unmappedConnectionCount: number;
  mappedCount: number;
  reviewCount: number;
  unsupportedCount: number;
  credentialNames: string[];
  riskSummary: string[];
  findings: { name: string; status: "mapped" | "review" | "unsupported"; suggestedAgentHubType: string | null; notes: string[] }[];
}

export function N8nMigrationDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (result: N8nImportResult) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"analyze" | "convert" | null>(null);

  async function readFile(file: File) {
    setError(null);
    if (file.size > 2 * 1024 * 1024) { setError("檔案超過 2MB，請先從 n8n 匯出單一流程"); return; }
    setRaw(await file.text());
    setAnalysis(null);
  }

  async function analyze() {
    setBusy("analyze"); setError(null);
    try {
      const res = await fetch("/api/n8n/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "分析失敗");
      setAnalysis(data.analysis);
    } catch (e) { setError(e instanceof Error ? e.message : "分析失敗"); }
    finally { setBusy(null); }
  }

  async function convert() {
    setBusy("convert"); setError(null);
    try {
      const res = await fetch("/api/n8n/convert", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
      const data = await res.json();
      if (!res.ok || !data.id) throw new Error(data.error ?? "轉換失敗");
      onCreated({ id: data.id, clearedCodeCount: data.clearedCodeCount ?? 0, clearedCredentialCount: data.clearedCredentialCount ?? 0, reviewCount: data.reviewCount ?? 0, unsupportedCount: data.unsupportedCount ?? 0 });
    } catch (e) { setError(e instanceof Error ? e.message : "轉換失敗"); }
    finally { setBusy(null); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,.45)" }}>
      <div className="card w-full max-w-2xl max-h-[90vh] flex flex-col" style={{ boxShadow: "var(--shadow-lg)" }}>
        <div className="h-14 px-5 border-b flex items-center gap-2 shrink-0">
          <span className="font-medium">🔁 安全轉換 n8n 流程</span>
          <button onClick={onClose} className="ml-auto faint hover:text-[var(--text)]" aria-label="關閉">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-sm">
          <div className="rounded-xl border p-3 text-xs leading-relaxed" style={{ borderColor: "color-mix(in srgb, var(--accent) 35%, var(--border))" }}>
            這是安全轉換，不是照單全收：帳密、credential、原始 Code、排程與不支援節點不會直接執行。轉換後會建立一份「外部匯入草稿」，你可以先檢查、補設定，再演練。
          </div>
          <label className="btn btn-ghost inline-flex cursor-pointer">選擇 n8n JSON<input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) void readFile(file); }} /></label>
          <textarea value={raw} onChange={(e) => { setRaw(e.target.value); setAnalysis(null); }} className="input w-full min-h-40 font-mono text-xs" placeholder="也可以直接貼上 n8n workflow JSON" />
          <div className="flex items-center gap-2">
            <button onClick={analyze} disabled={!raw.trim() || busy !== null} className="btn btn-primary">{busy === "analyze" ? "分析中…" : "🔎 先分析風險"}</button>
            {analysis && <button onClick={convert} disabled={busy !== null} className="btn btn-ghost">{busy === "convert" ? "轉換中…" : "建立安全草稿"}</button>}
          </div>
          {error && <div className="rounded-lg border p-3 text-xs" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{error}</div>}
          {analysis && (
            <div className="space-y-3">
              <div className="font-medium">「{analysis.name}」分析結果</div>
              <div className="grid grid-cols-4 gap-2 text-xs">
                <div className="rounded-lg p-2" style={{ background: "var(--surface-2)" }}>步驟<br /><b>{analysis.nodeCount}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface-2)" }}>可映射<br /><b style={{ color: "var(--green)" }}>{analysis.mappedCount}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface-2)" }}>需確認<br /><b style={{ color: "var(--amber)" }}>{analysis.reviewCount}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface-2)" }}>不支援<br /><b style={{ color: "var(--red)" }}>{analysis.unsupportedCount}</b></div>
              </div>
              {analysis.credentialNames.length > 0 && <p className="text-xs muted">已偵測到 {analysis.credentialNames.length} 組 credential 名稱；值不會被帶入。</p>}
              {analysis.riskSummary.length > 0 && <p className="text-xs" style={{ color: "var(--amber)" }}>注意：{analysis.riskSummary.join("、")}</p>}
              {analysis.unmappedConnectionCount > 0 && <p className="text-xs" style={{ color: "var(--red)" }}>有 {analysis.unmappedConnectionCount} 條 n8n 連線目前沒有安全的一對一搬法；建立草稿後會強制你在畫布重新接線，不會默默猜。</p>}
              <div className="space-y-1.5">
                {analysis.findings.slice(0, 12).map((finding, index) => (
                  <div key={`${finding.name}-${index}`} className="rounded-lg border px-3 py-2 text-xs flex items-start gap-2">
                    <span>{finding.status === "mapped" ? "✅" : finding.status === "review" ? "⚠️" : "⛔"}</span>
                    <div><b>{finding.name}</b><span className="muted"> · {finding.suggestedAgentHubType ?? "需重新描述"}</span>{finding.notes[0] && <div className="muted mt-0.5">{finding.notes[0]}</div>}</div>
                  </div>
                ))}
                {analysis.findings.length > 12 && <p className="faint text-xs">還有 {analysis.findings.length - 12} 個節點，會在草稿內逐一保留。</p>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
