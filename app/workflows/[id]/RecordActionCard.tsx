"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 「錄一段操作給我看」的完整介面。
 *
 * 使用者的兩句原話決定了整個設計：
 * ①「有時候有些步驟很難說清楚，可以用錄影的方式呈現」→ 所以要有「做一次給它看」這條路。
 * ②「但是又怕他理解不了」→ 所以錄完**絕對不會自動存**：先用白話把「我看到你做了什麼」
 *   全部列出來給他確認。理解錯的代價因此只是「他看到不對、按取消」，而不是「三個月後
 *   發現某個步驟一直做錯事」。
 * ③「要能分辨是精確的動作還是我做的是邏輯，但實際內容會調整」→ 所以覆述分成兩區：
 *   上面是「每次都照這樣做」的動作，下面是「每次可能不一樣」的值，值可以逐一勾選。
 */

interface RecordedAction { kind: string; describe: string; value?: string }
interface Result {
  actionCount: number;
  code: string;
  actions: RecordedAction[];
  replacedKeys: string[];
  clearedPasswordFields: string[];
}

/** 從欄位描述生出一個合法的英文代號(使用者不會看到它，但程式碼裡要用)。 */
function keyFor(action: RecordedAction, index: number): string {
  const inner = action.describe.match(/「([^」]+)」/)?.[1] ?? "";
  const guess = inner.match(/name=["']?(\w+)/)?.[1] ?? inner.match(/[A-Za-z_]\w*/)?.[0] ?? "";
  const clean = guess.replace(/[^A-Za-z0-9_]/g, "");
  return /^[A-Za-z_]/.test(clean) && clean.length > 0 ? clean : `值${index + 1}`.replace("值", "value");
}

function labelFor(action: RecordedAction): string {
  const inner = action.describe.match(/「([^」]+)」/)?.[1] ?? "這一步";
  return `要填進「${inner}」的內容`;
}

export function RecordActionCard({ workflowId, onClose, onSaved }: {
  workflowId: string;
  onClose: () => void;
  onSaved: (stepName: string) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "recording" | "review">("idle");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [variable, setVariable] = useState<Record<number, boolean>>({});
  const [stepName, setStepName] = useState("");
  const [rejected, setRejected] = useState<{ literal: string; reason: string }[]>([]);

  // 頁面重新整理後如果錄製視窗還開著，要能接回來(不然那個瀏覽器會變孤兒)
  const syncStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/workflows/${workflowId}/record`);
      const data = (await res.json()) as { recording?: boolean };
      if (data.recording) setPhase("recording");
    } catch { /* 讀不到就維持現狀 */ }
  }, [workflowId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void syncStatus(); }, [syncStatus]);

  async function start() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/workflows/${workflowId}/record`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() || "about:blank" }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setError(data.error ?? "無法開始錄製"); return; }
      setPhase("recording");
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/workflows/${workflowId}/record`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ finish: true }),
      });
      const data = (await res.json().catch(() => ({}))) as Result & { error?: string };
      if (!res.ok) { setError(data.error ?? "結束錄製失敗"); setPhase("idle"); return; }
      setResult(data);
      // 預設：他在欄位裡輸入的內容一律當成「每次會變」。這個預設方向對 90% 的情況都是對的
      // (選單、按鈕是結構；輸入框的內容才是值)，而且他可以逐一改掉。
      const defaults: Record<number, boolean> = {};
      data.actions.forEach((a, i) => { if (a.kind === "fill" && a.value) defaults[i] = true; });
      setVariable(defaults);
      setPhase("review");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    await fetch(`/api/workflows/${workflowId}/record`, { method: "DELETE" }).catch(() => null);
    setPhase("idle");
    setResult(null);
  }

  async function save() {
    if (!result) return;
    setBusy(true);
    setError("");
    try {
      const variables = result.actions
        .map((a, i) => ({ a, i }))
        .filter(({ a, i }) => a.kind === "fill" && a.value && variable[i])
        .map(({ a, i }) => ({ literal: a.value!, key: keyFor(a, i), label: labelFor(a) }));
      const res = await fetch("/api/user-steps/from-recording", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: stepName.trim(), code: result.code, variables, sourceWorkflowId: workflowId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; step?: { name: string }; rejected?: { literal: string; reason: string }[] };
      if (!res.ok) { setError(data.error ?? "存檔失敗"); return; }
      setRejected(data.rejected ?? []);
      if ((data.rejected ?? []).length === 0) onSaved(data.step?.name ?? stepName);
    } finally {
      setBusy(false);
    }
  }

  const fills = (result?.actions ?? []).map((a, i) => ({ a, i })).filter(({ a }) => a.kind === "fill" && a.value);
  const structural = (result?.actions ?? []).map((a, i) => ({ a, i })).filter(({ a }) => !(a.kind === "fill" && a.value));

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div className="card p-5 w-full max-w-2xl max-h-[85vh] overflow-y-auto space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">🔴 錄一段操作給我看</h2>
            <p className="text-xs muted mt-0.5">說不清楚的步驟，自己做一次比講半天有用</p>
          </div>
          <button onClick={onClose} className="btn btn-ghost text-xs shrink-0">關閉</button>
        </div>

        {phase === "idle" && (
          <>
            <div className="rounded-lg p-3 text-sm space-y-1.5" style={{ background: "var(--surface-2)" }}>
              <p className="font-medium">會發生什麼事</p>
              <p className="text-xs muted">1. 我開一個瀏覽器視窗（已經帶著這條流程存過的登入狀態，你不用重新登入）</p>
              <p className="text-xs muted">2. 你在那個視窗裡<b>把這件事做一次</b>——點選單、填欄位、按按鈕，照你平常的做法</p>
              <p className="text-xs muted">3. 做完回來按「我做完了」，我把看到的每一步用白話列給你確認</p>
              <p className="text-xs muted">4. 你確認之後才會存成步驟，之後任何流程都能重複套用</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs muted">要從哪個網址開始？（可以留空，自己在瀏覽器裡打）</label>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." className="input text-sm w-full" />
            </div>
            <p className="text-xs faint">
              你在密碼欄打的東西<b>不會被存下來</b>：已經存在平台裡的帳密會自動換成安全引用，其他密碼欄一律清空。
            </p>
            {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}
            <button onClick={() => void start()} disabled={busy} className="btn btn-primary text-sm w-full">
              {busy ? "開啟中…" : "🔴 開始錄製"}
            </button>
          </>
        )}

        {phase === "recording" && (
          <>
            <div className="rounded-lg p-4 text-center space-y-2" style={{ background: "var(--accent-soft)" }}>
              <p className="text-sm font-medium" style={{ color: "var(--accent)" }}>● 正在錄製</p>
              <p className="text-xs muted">請切到那個瀏覽器視窗，把這件事做一次。</p>
              <p className="text-xs muted">中間點錯、重來都沒關係——等一下你可以看到我記下了什麼，再決定要不要存。</p>
            </div>
            {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}
            <div className="flex gap-2">
              <button onClick={() => void finish()} disabled={busy} className="btn btn-primary text-sm flex-1">
                {busy ? "整理中…" : "✅ 我做完了"}
              </button>
              <button onClick={() => void cancel()} disabled={busy} className="btn btn-ghost text-sm">放棄這次</button>
            </div>
          </>
        )}

        {phase === "review" && result && (
          <>
            <p className="text-sm">我看到你做了 <b>{result.actionCount}</b> 個動作。請確認我理解得對不對：</p>

            <div className="space-y-1.5">
              <p className="text-xs font-medium">每次都照這樣做（動作與位置）</p>
              <div className="rounded-lg p-2.5 space-y-1" style={{ background: "var(--surface-2)" }}>
                {structural.length === 0 && <p className="text-xs muted">（沒有）</p>}
                {structural.map(({ a, i }) => (
                  <p key={i} className="text-xs">・{a.describe}</p>
                ))}
              </div>
            </div>

            {fills.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium">你輸入的內容——這些每次一樣還是會變？</p>
                <p className="text-xs faint">
                  勾起來 = 每次套用時可以填不一樣的（例如收件人、主旨）。不勾 = 每次都用你剛才打的那個值。
                </p>
                <div className="space-y-1.5">
                  {fills.map(({ a, i }) => (
                    <label key={i} className="flex items-start gap-2 text-xs rounded-lg p-2 cursor-pointer" style={{ background: "var(--surface-2)" }}>
                      <input
                        type="checkbox"
                        checked={Boolean(variable[i])}
                        onChange={(e) => setVariable((prev) => ({ ...prev, [i]: e.target.checked }))}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block">{a.describe}</span>
                        <span className="block font-mono break-all muted">你剛才填的是：{a.value}</span>
                        <span className="block faint">{variable[i] ? "→ 會變成一個可以每次填的欄位" : "→ 每次都固定用這個值"}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {result.replacedKeys.length > 0 && (
              <p className="text-xs" style={{ color: "var(--green)" }}>
                🔒 已把 {result.replacedKeys.join("、")} 換成平台裡保存的帳密，密碼沒有被寫進這個步驟。
              </p>
            )}
            {result.clearedPasswordFields.length > 0 && (
              <p className="text-xs" style={{ color: "var(--amber, #b45309)" }}>
                🔒 有 {result.clearedPasswordFields.length} 個密碼欄的內容已經清空（那組密碼還沒存在平台裡）。
                請到「設定 → 帳密」把它存起來，這個步驟才能自動填。
              </p>
            )}

            <div className="space-y-1">
              <label className="text-xs muted">給這個步驟一個名字（之後你會在「＋ 加步驟」裡看到它）</label>
              <input
                value={stepName}
                onChange={(e) => setStepName(e.target.value)}
                placeholder="例如：在 webmail 寄一封信"
                className="input text-sm w-full"
              />
            </div>

            {rejected.length > 0 && (
              <div className="text-xs" style={{ color: "var(--red)" }}>
                <p>有 {rejected.length} 個值沒能變成欄位（那幾格會固定用你剛才填的值）：</p>
                {rejected.map((r, i) => <p key={i} className="faint">・「{r.literal}」：{r.reason}</p>)}
              </div>
            )}
            {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}

            <div className="flex gap-2">
              <button onClick={() => void save()} disabled={busy || !stepName.trim()} className="btn btn-primary text-sm flex-1">
                {busy ? "存檔中…" : "⭐ 存成我的步驟"}
              </button>
              <button onClick={() => { setPhase("idle"); setResult(null); }} disabled={busy} className="btn btn-ghost text-sm">重錄一次</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
