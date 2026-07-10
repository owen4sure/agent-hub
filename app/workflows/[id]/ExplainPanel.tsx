"use client";

import { useEffect, useState } from "react";
import type { ExplainData } from "./types";

export function ExplainPanel({ workflowId, onClose, onPickNode }: { workflowId: string; onClose: () => void; onPickNode: (nodeId: string) => void }) {
  const [data, setData] = useState<ExplainData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/workflows/${workflowId}/explain`);
        if (!res.ok) throw new Error();
        const d = await res.json();
        if (alive) setData(d);
      } catch { if (alive) setError(true); }
    })();
    return () => { alive = false; };
  }, [workflowId]);

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-5 border-b flex items-center gap-2 shrink-0">
        <span className="text-sm font-medium">📖 流程說明</span>
        <button onClick={onClose} className="ml-auto faint hover:text-[var(--text)]" aria-label="關閉">✕</button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {error && <p className="text-sm" style={{ color: "var(--red)" }}>載入說明失敗，請重試。</p>}
        {!data && !error && <p className="text-sm muted">載入中…</p>}
        {data && (
          <>
            <div className="card p-3 text-[13px] leading-relaxed" style={{ background: "var(--surface-2)" }}>
              <div className="text-xs faint mb-1">這個流程整體在做什麼</div>
              {data.overview}
            </div>

            {(data.params.length > 0 || data.secrets.length > 0) && (
              <div className="text-xs muted space-y-1.5">
                {data.params.length > 0 && (
                  <div>
                    <span className="faint">執行時要給的資料：</span>
                    {data.params.map((p, i) => <span key={i} className="badge badge-neutral ml-1">{p.label}</span>)}
                  </div>
                )}
                {data.secrets.length > 0 && (
                  <div>
                    <span className="faint">需要在「設定」填的帳密：</span>
                    {data.secrets.map((s, i) => <span key={i} className="badge badge-neutral ml-1">{s}</span>)}
                  </div>
                )}
              </div>
            )}

            <div className="text-xs faint pt-1">一步一步（照執行順序）：</div>
            <div className="space-y-2.5">
              {data.steps.map((s) => (
                <button key={s.id} onClick={() => onPickNode(s.id)} className="card card-hover w-full text-left p-3 block" title="點一下跳到這個節點修改">
                  <div className="flex items-center gap-2">
                    <span className="grid place-items-center w-6 h-6 rounded-md text-xs shrink-0" style={{ background: "var(--surface-2)" }}>{s.order}</span>
                    <span>{s.icon}</span>
                    <span className="text-sm font-medium truncate">{s.label}</span>
                  </div>
                  <p className="text-[13px] muted mt-1.5 leading-relaxed">{s.text}</p>
                  {s.settings.length > 0 && (
                    <div className="mt-2 pt-2 border-t space-y-0.5">
                      {s.settings.map(([k, v], i) => (
                        <div key={i} className="flex gap-2 text-xs">
                          <span className="faint shrink-0">{k}</span>
                          <span className="ml-auto text-right break-all" style={{ color: "var(--text)" }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </button>
              ))}
            </div>
            <p className="text-xs faint pt-1">看完覺得哪一步要改，點那一步就會跳到節點，用白話跟 AI 講怎麼改。</p>
          </>
        )}
      </div>
    </div>
  );
}
