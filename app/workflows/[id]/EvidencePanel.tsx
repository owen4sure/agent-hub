"use client";

import type { EvidenceState } from "./types";

export function EvidencePanel({ evidence, onClose, onRetest }: { evidence: EvidenceState; onClose: () => void; onRetest: () => void }) {
  const sources = evidence.passport.sources ?? [];
  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-5 border-b flex items-center gap-2 shrink-0">
        <span className="font-medium">🛡️ 真實驗收證據</span>
        <button onClick={onClose} className="ml-auto faint hover:text-[var(--text)]" aria-label="關閉">✕</button>
      </div>
      <div className="flex-1 overflow-y-auto p-5 space-y-4 text-sm">
        <div className="rounded-xl border p-3" style={{ borderColor: evidence.drifted ? "color-mix(in srgb, var(--amber) 45%, var(--border))" : "color-mix(in srgb, var(--green) 45%, var(--border))" }}>
          <div className="font-medium" style={{ color: evidence.drifted ? "var(--amber)" : "var(--green)" }}>
            {evidence.drifted ? "⚠️ 這個版本需要重新驗收" : "✅ 這個版本已用真實資料驗收"}
          </div>
          <p className="muted text-xs mt-1">正式執行前會核對流程內容與來源檔案；內容改過或檔案換過，就不會偷偷沿用舊的綠燈。</p>
          {evidence.drifted && <button onClick={onRetest} className="btn btn-primary text-xs mt-3">🪄 重新安全試跑</button>}
        </div>

        <div>
          <div className="font-medium mb-2">這次實際驗證了什麼</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg p-2" style={{ background: "var(--surface-2)" }}><span className="muted block">步驟</span>{evidence.passport.successfulNodes}/{evidence.passport.nodeCount} 步通過</div>
            <div className="rounded-lg p-2" style={{ background: "var(--surface-2)" }}><span className="muted block">分支</span>{evidence.passport.coverage?.complete ? "每條分支都有走到" : "沒有完整分支資料"}</div>
          </div>
        </div>

        <div>
          <div className="font-medium mb-2">實際讀取的來源</div>
          {sources.length === 0 ? (
            <p className="muted text-xs">這次沒有留下可核對的檔案或網址來源。</p>
          ) : (
            <div className="space-y-2">
              {sources.map((source, index) => (
                <div key={`${source.nodePath}-${source.reference}-${index}`} className="rounded-lg border p-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span>{source.kind === "file" ? "📄" : source.kind === "mail" ? "✉️" : "🌐"}</span>
                    <span className="font-medium break-all">{source.reference}</span>
                    {source.dynamic && <span className="badge badge-neutral ml-auto shrink-0">執行時找到</span>}
                  </div>
                  {source.selection?.sheet && <div className="muted mt-1">分頁：{source.selection.sheet}</div>}
                  {source.selection?.range && <div className="muted">範圍：{source.selection.range}</div>}
                  {source.observed?.matchedRowCount !== undefined && <div className="muted">實際符合：{source.observed.matchedRowCount} 筆</div>}
                  {source.observed?.rowCount !== undefined && <div className="muted">實際讀取：{source.observed.rowCount} 筆</div>}
                  {source.observed?.numPages !== undefined && <div className="muted">頁數：{source.observed.numPages} 頁</div>}
                  {source.observed?.textChars !== undefined && <div className="muted">讀到文字：{source.observed.textChars} 字</div>}
                  {source.observed?.bodyChars !== undefined && <div className="muted">信件內文：{source.observed.bodyChars} 字</div>}
                  {source.observed?.attachmentCount !== undefined && <div className="muted">附件：{source.observed.attachmentCount} 個</div>}
                  {source.observed?.found !== undefined && <div className="muted">搜尋結果：{source.observed.found} 封</div>}
                  <div className="faint mt-1">內容指紋：{source.sha256 ? `${source.sha256.slice(0, 12)}…` : "未取得"}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
