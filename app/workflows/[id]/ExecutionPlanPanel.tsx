"use client";

import type { SideEffectTag } from "@/lib/workflow/sideEffects";

export interface ExecutionPlanData {
  items: { nodeId: string; label: string; type: string; effects: SideEffectTag[]; action: string; destination?: string; uncertain: boolean }[];
  effects: SideEffectTag[];
  readCount: number;
  writeCount: number;
  requiresConfirmation: boolean;
  graphFingerprint: string;
}

const effectNames: Record<string, string> = {
  "file-write": "產生新檔案", "file-modify": "修改既有檔案", "remote-write": "寫入外部服務", email: "寄出 Email", notify: "發送通知", "approval-request": "送出簽核請求", "workspace-file": "本次執行暫存",
};

export function ExecutionPlanPanel({ plan, missingSettings, onContinue, onCancel }: { plan: ExecutionPlanData; missingSettings: { key: string; label: string; type: string }[]; onContinue: () => void; onCancel: () => void }) {
  const visibleEffects = plan.effects.filter((effect) => effect !== "workspace-file");
  return (
    <div className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="執行前計畫">
      <div className="card w-full max-w-2xl max-h-[88dvh] overflow-y-auto p-5 space-y-4 shadow-xl">
        <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">執行前計畫</h2><p className="muted text-xs mt-1">先看懂這次會讀取、計算、產出或送出的內容，再決定是否開始。</p></div><button className="btn btn-ghost" onClick={onCancel}>取消</button></div>
        <div className="grid grid-cols-2 gap-2"><div className="card p-3"><div className="faint text-xs">讀取／計算步驟</div><div className="text-xl font-semibold">{plan.readCount}</div></div><div className="card p-3"><div className="faint text-xs">可能產生影響</div><div className="text-xl font-semibold" style={{ color: plan.writeCount ? "var(--amber)" : "var(--green)" }}>{plan.writeCount}</div></div></div>
        {visibleEffects.length > 0 && <div className="card p-3" style={{ borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))" }}><div className="font-medium mb-1">這次可能產生的影響</div><div className="flex flex-wrap gap-2">{visibleEffects.map((effect) => <span className="badge badge-amber" key={effect}>{effectNames[effect] ?? effect}</span>)}</div><p className="muted text-xs mt-2">只有列出的動作會被執行；安全試跑模式會攔住這些動作。</p></div>}
        {missingSettings.length > 0 && <div className="card p-3" style={{ borderColor: "color-mix(in srgb, var(--red) 45%, var(--border))" }}><div className="font-medium">執行前還缺設定</div><p className="muted text-xs mt-1">{missingSettings.map((item) => item.label).join("、")}</p></div>}
        <div className="space-y-2"><div className="font-medium">逐步清單</div>{plan.items.map((item) => { const impacts = item.effects.filter((effect) => effect !== "workspace-file"); return <div className="card p-3 flex items-center gap-3" key={item.nodeId}><span className={impacts.length || item.uncertain ? "text-amber-600" : "text-green-600"}>{impacts.length || item.uncertain ? "⚠" : "✓"}</span><div className="min-w-0 flex-1"><div className="truncate">{item.label}</div><div className="faint text-xs">{item.uncertain ? "副作用尚待確認" : item.action}{item.destination ? ` · ${item.destination}` : ""}</div></div></div>; })}</div>
        <div className="flex justify-end gap-2 pt-2"><button className="btn btn-ghost" onClick={onCancel}>先不要執行</button><button className="btn btn-primary" onClick={onContinue}>{missingSettings.length > 0 ? "先補齊設定" : "確認計畫並開始"}</button></div>
      </div>
    </div>
  );
}
