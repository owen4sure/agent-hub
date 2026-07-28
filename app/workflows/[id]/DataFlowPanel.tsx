"use client";

import { useEffect, useState } from "react";
import type { DataFlowData } from "./types";

const statusText = { available: "上游已提供", runtime: "執行時提供", "unknown-source": "自訂步驟可能提供", missing: "目前找不到" } as const;
const statusColor = { available: "var(--green)", runtime: "var(--accent)", "unknown-source": "var(--amber)", missing: "var(--red)" } as const;

export function DataFlowPanel({ workflowId, onClose, onPickNode }: { workflowId: string; onClose: () => void; onPickNode: (nodeId: string) => void }) {
  const [data, setData] = useState<DataFlowData | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/workflows/" + workflowId + "/data-flow");
        if (!res.ok) throw new Error();
        const next = await res.json() as DataFlowData;
        if (alive) setData(next);
      } catch { if (alive) setError(true); }
    })();
    return () => { alive = false; };
  }, [workflowId]);
  return <div className="flex flex-col h-full">
    <div className="h-14 px-5 border-b flex items-center gap-2 shrink-0"><span className="text-sm font-medium">🔗 資料怎麼流</span><button onClick={onClose} className="ml-auto faint hover:text-[var(--text)]" aria-label="關閉">✕</button></div>
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <p className="text-xs muted leading-relaxed">這裡只做靜態檢查，不會執行流程、不會讀取帳密。你可以先看懂每一步收到什麼、產生什麼，再決定要不要測試。</p>
      {error && <p className="text-sm" style={{ color: "var(--red)" }}>資料流載入失敗，請重試。</p>}
      {!data && !error && <p className="text-sm muted">整理資料流中…</p>}
      {data && <>
        {data.warnings.length > 0 && <div className="rounded-lg border p-3 text-xs leading-relaxed" style={{ borderColor: "color-mix(in srgb, var(--red) 45%, var(--border))", background: "color-mix(in srgb, var(--red) 7%, transparent)" }}><div className="font-medium" style={{ color: "var(--red)" }}>⚠️ 有欄位目前接不到</div>{data.warnings.map((warning) => <div key={warning} className="mt-1">{warning}</div>)}</div>}
        <div className="space-y-2.5">{data.nodes.map((node) => <button key={node.id} onClick={() => onPickNode(node.id)} className="card card-hover w-full text-left p-3 block">
          <div className="flex items-center gap-2"><span className="grid place-items-center w-6 h-6 rounded-md text-xs shrink-0" style={{ background: "var(--surface-2)" }}>{node.order}</span><span className="text-sm font-medium truncate">{node.label}</span><span className="faint text-xs ml-auto">查看設定</span></div>
          {node.inputs.length > 0 && <div className="mt-2"><div className="text-xs faint mb-1">收到的資料</div><div className="flex flex-wrap gap-1">{node.inputs.slice(0, 16).map((field) => <span key={field.name} className="badge badge-neutral text-[11px]" title={statusText[field.status] + "：" + field.sources.join("、")} style={{ color: statusColor[field.status] }}>{field.name}</span>)}</div>{node.inputs.length > 16 && <div className="text-[11px] faint mt-1">另有 {node.inputs.length - 16} 個欄位</div>}</div>}
          {node.outputs.length > 0 && <div className="mt-2"><div className="text-xs faint mb-1">這一步新增</div><div className="flex flex-wrap gap-1">{node.outputs.map((field) => <span key={field.name} className="badge badge-neutral text-[11px]" style={{ color: "var(--green)" }}>{field.name}</span>)}</div></div>}
          {node.references.length > 0 && <div className="mt-2 pt-2 border-t"><div className="text-xs faint mb-1">這一步引用</div><div className="space-y-0.5">{node.references.map((ref) => <div key={ref.token} className="text-xs" style={{ color: statusColor[ref.status] }}>{"{{" + ref.token + "}}"} · {statusText[ref.status]}</div>)}</div></div>}
        </button>)}</div>
        <p className="text-[11px] faint">版本指紋：{data.graphFingerprint}</p>
      </>}
    </div>
  </div>;
}
