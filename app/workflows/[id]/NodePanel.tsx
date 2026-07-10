"use client";

import { useState } from "react";
import { ICONS } from "./nodeVisuals";
import type { WFNode, NodeRun } from "./types";

/** 比較節點設定改前改後的差異，只列出真的變了的欄位(值轉字串比較，物件/陣列也涵蓋在內) */
export function configDiff(before: Record<string, unknown>, after: Record<string, unknown>): { key: string; before?: string; after?: string }[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: { key: string; before?: string; after?: string }[] = [];
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    const bStr = b === undefined ? undefined : typeof b === "string" ? b : JSON.stringify(b);
    const aStr = a === undefined ? undefined : typeof a === "string" ? a : JSON.stringify(a);
    if (bStr !== aStr) out.push({ key, before: bStr, after: aStr });
  }
  return out;
}

export function NodePanel({
  workflowId,
  node,
  run,
  explainStep,
  onClose,
  onChanged,
  onToast,
  onRename,
}: {
  workflowId: string;
  node: WFNode;
  run: NodeRun | null | undefined;
  explainStep: { text: string; settings: [string, string][] } | null;
  onClose: () => void;
  onChanged: () => void;
  onToast: (text: string) => void;
  onRename: (name: string) => void;
}) {
  const [instruction, setInstruction] = useState("");
  // 區分是哪個動作在忙——只有 repair(自動修復) 是可以中途停止的多輪迴圈，tweak(單次 AI 微調)沒有
  // 對應的 stop-loop 可停(那是另一個一次性端點)，停止按鈕只在 repair 進行中顯示。
  const [busyAction, setBusyAction] = useState<"tweak" | "repair" | null>(null);
  const busy = busyAction !== null;
  const [stopping, setStopping] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(node.label);
  const [editingName, setEditingName] = useState(false);
  const [lastDiff, setLastDiff] = useState<{ before: Record<string, unknown>; after: Record<string, unknown> } | null>(null);
  // 使用者是不懂程式的人，預設只給他看得懂的白話說明(explainStep 由父層一次抓整條流程的說明後傳下來，
  // 不用每點開一個節點就重打一次 API)；原始 config/code 只留給想除錯的人，收在下面「技術細節」裡預設收合。
  const [showTechnical, setShowTechnical] = useState(false);

  async function tweak() {
    setBusyAction("tweak");
    setMsg(null);
    setLastDiff(null);
    try {
      const res = await fetch(`/api/workflows/${workflowId}/nodes/${node.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      });
      const data = await res.json();
      if (res.ok) {
        setMsg("已更新這個節點");
        setInstruction("");
        // AI 到底改了什麼，之前後端有回傳(before/config)但畫面上從來沒顯示過——現在秀出來讓使用者確認
        setLastDiff({ before: data.before ?? {}, after: data.config ?? {} });
        onChanged();
        onToast(`已更新：${node.label}`); // 畫布也跳一下通知，不是只有這個面板裡的文字看得到
      } else setMsg(`失敗：${data.error}`);
    } catch {
      // 連線中斷/回應不是 JSON 時，後端可能其實已經改好了——無論如何重載一次，別讓畫面停在舊設定
      setMsg("連線中斷，AI 可能已完成修改，已重新載入最新設定");
      onChanged();
    } finally {
      setBusyAction(null);
    }
  }

  async function repair() {
    setBusyAction("repair");
    setMsg(null);
    try {
      // 自動修復迴圈：AI 改 → 重跑驗證 → 沒好再試(最多 3 次)，成功會記起來
      const res = await fetch(`/api/workflows/${workflowId}/autofix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id, params: {} }),
      });
      const data = await res.json();
      // data.suspicion 有值代表流程雖然跑通了，但語意驗收覺得結果可疑——這種情況後端不會記進學習庫
      // (見 autofix/route.ts)，前端也不能講「已記住這個解法」騙使用者，要照實把疑點講出來(踩過的
      // 誠實回報缺口：後端老實標了可疑，前端卻沒接住，照樣顯示「已記住」)。
      if (data.cancelled) setMsg("已停止修復，沒通過驗證的改動已還原");
      else if (data.ok && data.suspicion) { setMsg(`⚠️ 流程通過了，但驗收檢查覺得結果可疑：${data.suspicion}——建議親自看一眼結果，有問題再說一次`); onToast(`「${node.label}」跑通了但建議確認一下`); }
      else if (data.ok) { setMsg(`✅ 修好了(試了 ${data.attempts} 次)，已記住這個解法`); onToast(`已修好：${node.label}`); }
      else if (data.movedTo) setMsg(`這一步過了，但換別的節點卡住，請看那個節點`);
      else setMsg(`試了 ${data.attempts ?? ""} 次還沒修好：${data.error ?? ""}`);
      onChanged();
    } catch {
      // autofix 最長跑幾分鐘，期間 dev 重編譯/代理逾時都可能讓這個 fetch 斷線——
      // 後端很可能其實已經修好並存檔了。一定要報訊息+重載，不然畫面停在舊設定、
      // 使用者以為「AI 說修了卻沒改」(踩過的真實 bug 成因之一)。
      setMsg("連線中斷，AI 可能已在背景完成修復，已重新載入最新設定；請看節點狀態確認");
      onChanged();
    } finally {
      setBusyAction(null);
    }
  }

  async function stopRepair() {
    if (stopping) return;
    setStopping(true);
    try {
      await fetch(`/api/workflows/${workflowId}/stop-loop`, { method: "POST" });
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="flex flex-col h-full relative">
      {busy && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: "color-mix(in srgb, var(--surface) 88%, transparent)", backdropFilter: "blur(2px)" }}>
          <div className="w-8 h-8 rounded-full border-2 animate-spin" style={{ borderColor: "var(--border-strong)", borderTopColor: "var(--accent)" }} />
          <p className="text-sm font-medium">{busyAction === "repair" ? "AI 自動修復中…" : "AI 更新中…"}</p>
          {busyAction === "repair" && (
            <>
              <p className="text-xs faint">改設定 → 重跑驗證 → 沒好就換方式再試（最多 3 次），最多跑 4 分鐘，時間到就會老實回報，不會無限跑下去</p>
              <button onClick={stopRepair} disabled={stopping} className="btn text-xs mt-1" style={{ background: "var(--red)", color: "#fff" }}>
                {stopping ? "停止中…" : "⏹ 停止修復"}
              </button>
            </>
          )}
        </div>
      )}
      <div className="h-14 px-5 border-b flex items-center gap-2.5">
        <span className="grid place-items-center w-7 h-7 rounded-lg text-sm" style={{ background: "var(--surface-2)" }}>{ICONS[node.type] ?? "▫️"}</span>
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => { setEditingName(false); const n = nameDraft.trim(); if (n && n !== node.label) onRename(n); else setNameDraft(node.label); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setEditingName(false); setNameDraft(node.label); } }}
            className="input text-sm py-1"
          />
        ) : (
          <button onClick={() => { setNameDraft(node.label); setEditingName(true); }} className="text-sm font-medium hover:underline decoration-dotted" title="點一下改名">
            {node.label}
          </button>
        )}
        <button onClick={onClose} className="ml-auto faint hover:text-[var(--text)]">✕</button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4 text-sm">
        {run?.status === "failed" && (
          <div className="card p-3 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--red) 40%, var(--border))", background: "color-mix(in srgb, var(--red) 6%, var(--surface))" }}>
            <p className="text-xs" style={{ color: "var(--red)" }}>❌ {run.error}</p>
            <button onClick={repair} disabled={busy} className="btn btn-primary text-xs" style={{ background: "var(--red)" }}>
              {busy ? "修復中…" : "🔧 讓 AI 修這一步"}
            </button>
          </div>
        )}
        <div className="card p-3 text-[13px] leading-relaxed" style={{ background: "var(--surface-2)" }}>
          <p className="text-xs faint mb-1">這一步在做什麼</p>
          {explainStep ? explainStep.text : "說明載入中…"}
          {/* custom-code 節點的「用途」設定值就是同一段 intent 文字，跟上面的說明重複顯示沒有意義，濾掉 */}
          {explainStep && explainStep.settings.filter(([, v]) => !explainStep.text.includes(v)).length > 0 && (
            <div className="mt-2 pt-2 border-t space-y-0.5">
              {explainStep.settings.filter(([, v]) => !explainStep.text.includes(v)).map(([k, v], i) => (
                <div key={i} className="flex gap-2 text-xs">
                  <span className="faint shrink-0">{k}</span>
                  <span className="ml-auto text-right break-all" style={{ color: "var(--text)" }}>{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {lastDiff && (
          <div className="card p-3 space-y-1.5" style={{ borderColor: "var(--accent)" }}>
            <p className="text-xs font-medium" style={{ color: "var(--accent)" }}>AI 剛剛改了什麼</p>
            {configDiff(lastDiff.before, lastDiff.after).length === 0 ? (
              <p className="text-xs muted">設定內容沒有變化。</p>
            ) : (
              configDiff(lastDiff.before, lastDiff.after).map(({ key, before, after }) => (
                <div key={key} className="text-xs">
                  <span className="faint">{key}：</span>
                  {before !== undefined && <span className="line-through opacity-60">{before}</span>}
                  {before !== undefined && after !== undefined && " → "}
                  {after !== undefined && <span style={{ color: "var(--green)" }}>{after}</span>}
                </div>
              ))
            )}
          </div>
        )}
        <div>
          <button onClick={() => setShowTechnical((v) => !v)} className="text-xs faint hover:text-[var(--text)]">
            {showTechnical ? "▾" : "▸"} 技術細節(除錯用，一般不需要看)
          </button>
          {showTechnical && (
            <div className="mt-2 space-y-3">
              {run?.output_json && (
                <div>
                  <p className="text-xs faint mb-1.5">這一步流出的資料</p>
                  <pre className="text-xs rounded-lg p-3 overflow-auto max-h-44 font-mono" style={{ background: "var(--surface-2)" }}>{JSON.stringify(JSON.parse(run.output_json), null, 2)}</pre>
                </div>
              )}
              <div>
                <p className="text-xs faint mb-1.5">原始設定(config)</p>
                <pre className="text-xs rounded-lg p-3 overflow-auto max-h-44 font-mono" style={{ background: "var(--surface-2)" }}>{JSON.stringify(node.config, null, 2)}</pre>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="border-t p-4 space-y-2">
        <p className="text-xs faint">用白話叫 AI 微調這個節點</p>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="例如：改成抓『每週業績追蹤』那封信"
          rows={2}
          className="input resize-none"
        />
        <button onClick={tweak} disabled={busy || !instruction.trim()} className="btn btn-primary w-full justify-center">
          {busy ? "處理中…" : "送出"}
        </button>
        {msg && <p className="text-xs muted">{msg}</p>}
      </div>
    </div>
  );
}
