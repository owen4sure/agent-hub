"use client";

import { useEffect, useRef, useState } from "react";
import { ICONS } from "./nodeVisuals";
import { fetchNodeDefs, type NodeDefLite, type ParamFieldLite } from "./AddNodePanel";
import type { WFNode, NodeRun } from "./types";
import { plainLanguage } from "@/lib/workflow/plainLanguage";
import { GOOGLE_SHEET_SCRIPT_TEMPLATE } from "@/lib/googleSheetScriptTemplate";
import type { Part } from "@/lib/wfChatStore";

/** select 選項支援 "value=顯示文字";只有「=」前後都有內容才切(跟 graphLint 同一套規則,別把 == 切壞) */
function parseOption(o: string): { value: string; label: string } {
  const i = o.indexOf("=");
  return i > 0 && i < o.length - 1 ? { value: o.slice(0, i), label: o.slice(i + 1) } : { value: o, label: o };
}

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

/**
 * 自動修復不是一句「修好了」就算交代；使用者至少要能立即知道：AI 動了哪一段，以及那個改動有沒有
 * 被真正重跑驗證。完整逐輪記錄留在執行紀錄，這裡只保留最後兩個最有判斷力的結果，避免再塞一大段
 * 工程日誌讓非技術使用者看不懂。
 */
export function conciseRepairReport(log: unknown): string {
  if (!Array.isArray(log)) return "";
  const rows = log
    .filter((item): item is { action?: unknown; result?: unknown } => Boolean(item) && typeof item === "object")
    .map((item) => ({
      action: typeof item.action === "string" ? item.action.trim() : "",
      result: typeof item.result === "string" ? item.result.trim() : "",
    }))
    .filter((item) => item.action || item.result);
  const selected = rows.slice(-2);
  if (!selected.length) return "";
  return `\n${selected.map((item) => `• ${plainLanguage(item.action)}：${plainLanguage(item.result)}`).join("\n")}`;
}

// 欄位名(periodStart/anchorDate 這類程式變數名)一律過白話說明用的同一套過濾;
// 值(使用者要驗證的實際計算結果，例如筆數/金額)完全原樣顯示,不能被 plainLanguage 的替換規則動到。
function formatOutput(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(parsed)
      .map(([key, value]) => `${plainLanguage(key)}：${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join("\n");
  } catch {
    return raw;
  }
}

export function NodePanel({
  workflowId,
  node,
  run,
  explainStep,
  readonly: readonlyWf,
  onClose,
  onChanged,
  onToast,
  onRename,
  onDraftChange,
  onRunFromHere,
  onRunOnlyThis,
  watchRun,
  onWatchRunChange,
  testOnly,
  onTestOnlyChange,
  missingSecrets,
  failureResolution,
  failureReason,
  attachParts,
  onAttachPartsChange,
  onAttachFiles,
  instruction,
  onInstructionChange,
}: {
  workflowId: string;
  node: WFNode;
  run: NodeRun | null | undefined;
  explainStep: { text: string; settings: [string, string][] } | null;
  /** 內建範例唯讀(要改先複製) */
  readonly?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onToast: (text: string) => void;
  onRename: (name: string) => void;
  /** 讓父頁在執行／自動測試前先把仍在畫面上的草稿存好，不能拿舊磁碟值去跑。 */
  onDraftChange: (nodeId: string, config: Record<string, string | boolean> | null) => void;
  /** 從這一步開始測：只跑這節點+下游，上游沿用最近結果或跳過(不用整條從頭跑) */
  onRunFromHere: () => void;
  /** 只測這一步：只跑這一格，其餘全部沿用最近結果或跳過 */
  onRunOnlyThis: () => void;
  /** 部分執行要不要開有頭瀏覽器看畫面。預設關——開視窗會把使用者的螢幕焦點搶走 */
  watchRun: boolean;
  onWatchRunChange: (v: boolean) => void;
  /** 「只測試,不更改資料」勾選：預設 false=真的執行到底(含寫入/發送)——使用者拍板「圈起來執行的
   * 就執行到底,除非我有說只測試」;勾了才走只讀安全排練(dryRun)。 */
  testOnly: boolean;
  onTestOnlyChange: (v: boolean) => void;
  /** 這條流程還沒填的帳密欄位——帳密類失敗要直接給輸入框(AI 修不了缺帳密,不能只給修復按鈕) */
  missingSecrets: { key: string; label: string; type: "text" | "password" }[];
  /** 引擎 classifyFailure 對「這次失敗在這個節點」的權威分類("ai-fixable"/"needs-human")——
   * 只在這個節點就是該次執行的 failed_node 時才有值，其餘情況(不同節點/沒有失敗紀錄)是 null。 */
  failureResolution?: string | null;
  /** 對應的分類說明文字(已經講清楚缺什麼、下一步要做什麼)，needs-human 時直接顯示這句取代修復按鈕。 */
  failureReason?: string | null;
  /** 針對「這個節點」附的圖片/檔案(切換節點會清空)——讓使用者不用離開單一節點畫面就能傳截圖給 AI 看 */
  attachParts: Part[];
  onAttachPartsChange: (parts: Part[]) => void;
  /** 按下「📎」選檔時呼叫；解析結果由父層附加進 attachParts(會先把目前 instruction 封存進序列,順序才對) */
  onAttachFiles: (files: File[]) => void;
  /** 指令文字提升到父層管理(不是這裡的 local state)——window 層級的拖放/貼上才能在附加新素材「之前」
   * 讀到目前打好的文字並封存進有序序列，「先打字、再貼圖、再打字」這種交錯順序 AI 才看得懂在講哪一張。 */
  instruction: string;
  onInstructionChange: (value: string) => void;
}) {
  const attachInputRef = useRef<HTMLInputElement>(null);
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

  // ── 直接改設定:簡單值(網址/關鍵字/檔名…)自己打字改,不用每次都求 AI(雙模式編輯拍板) ──
  const [defs, setDefs] = useState<NodeDefLite[] | null>(null);
  const [draftCfg, setDraftCfg] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [sheetScriptCopied, setSheetScriptCopied] = useState(false);
  const [sheetProbe, setSheetProbe] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false });
  useEffect(() => { fetchNodeDefs().then(setDefs).catch(() => {}); }, []);
  // 切換節點時的草稿重置不用 effect——父層用 key={node.id} 強制重建整個面板,state 天生就是乾淨的
  const schema = defs?.find((d) => d.type === node.type)?.configSchema ?? [];
  // 可直接改的欄位:排除帳密(在設定頁)、AI 管的程式碼/內嵌步驟、觸發參數衍生欄位
  const editableFields = schema.filter(
    (f) => f.type !== "secret" && f.type !== "code" && !f.derived && !(node.type === "repeat-steps" && f.key === "steps") && !(node.type === "custom-code" && f.key === "code"),
  );
  // AI 微調後的回報是給使用者確認「有沒有改對」，不是除錯用的 raw config dump。程式碼、內嵌步驟、
  // JSON 與沒有對應表單的內部欄位一律收成白話結論；真正技術細節仍只在後端與 AI 的修復現場使用。
  const friendlyLastDiff = lastDiff
    ? configDiff(lastDiff.before, lastDiff.after).map(({ key, before, after }) => {
        const field = schema.find((item) => item.key === key);
        const technical = key === "code" || key === "steps" || field?.type === "code" || !field;
        if (technical) return { key, label: "底層處理方式", before: undefined, after: "已更新" };
        const value = (raw: string | undefined) => {
          if (raw === undefined) return undefined;
          if (raw.length > 160 || /^[\[{]/.test(raw.trim())) return "已更新";
          return plainLanguage(raw);
        };
        return { key, label: field.label, before: value(before), after: value(after) };
      })
    : [];
  const fieldValue = (f: ParamFieldLite): string | boolean => {
    if (f.key in draftCfg) return draftCfg[f.key];
    const v = node.config?.[f.key];
    if (f.type === "boolean") return v === true || v === "true";
    return v === undefined || v === null ? "" : String(v);
  };
  const dirty = Object.entries(draftCfg).some(([k, v]) => {
    const cur = node.config?.[k];
    return String(v) !== String(cur ?? "");
  });
  useEffect(() => {
    onDraftChange(node.id, dirty ? draftCfg : null);
  }, [dirty, draftCfg, node.id, onDraftChange]);

  async function saveConfig() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`/api/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeConfig: { id: node.id, config: draftCfg } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setSaveMsg(`存檔失敗:${(data as { error?: string }).error ?? "請再試一次"}`); return; }
      setDraftCfg({});
      setSaveMsg("✓ 已儲存");
      onChanged();
      onToast(`已更新:${node.label}`);
    } catch {
      setSaveMsg("連不上伺服器,請再試一次");
    } finally {
      setSaving(false);
    }
  }

  async function copySheetScript() {
    try {
      await navigator.clipboard.writeText(GOOGLE_SHEET_SCRIPT_TEMPLATE);
      setSheetScriptCopied(true);
      setTimeout(() => setSheetScriptCopied(false), 2500);
    } catch {
      setSheetProbe({ busy: false, ok: false, text: "無法自動複製，請手動全選下方程式碼。" });
    }
  }

  async function probeScriptUrl() {
    const scriptUrl = String(draftCfg.scriptUrl ?? node.config?.scriptUrl ?? "").trim();
    setSheetProbe({ busy: true });
    try {
      const res = await fetch("/api/notify-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sheet-script-probe", scriptUrl }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; message?: string };
      if (!data.ok) {
        setSheetProbe({ busy: false, ok: false, text: data.message ?? "檢查失敗，請再試一次" });
        return;
      }
      // 以前只檢查 draftCfg、沒有存檔：畫面說成功，正式執行卻仍讀磁碟舊網址。
      // 檢查成功後立即原子套用到本流程所有 Sheet 寫入節點，兩個狀態不再分裂。
      const saveRes = await fetch(`/api/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeConfig: { id: node.id, config: { scriptUrl } },
          applySheetScriptUrlToAll: true,
        }),
      });
      const saveData = await saveRes.json().catch(() => ({})) as { error?: string };
      if (!saveRes.ok) {
        setSheetProbe({ busy: false, ok: false, text: `網址檢查通過，但存檔失敗：${saveData.error ?? "請再試一次"}` });
        return;
      }
      setDraftCfg((current) => {
        const next = { ...current };
        delete next.scriptUrl;
        return next;
      });
      setSheetProbe({ busy: false, ok: true, text: "✅ 網址、權限與版本都正確，且已儲存到這條流程的所有 Google Sheet 寫入步驟。沒有寫入任何資料。" });
      onChanged();
      onToast("已檢查並更新所有 Google Sheet 寫入步驟");
    } catch {
      setSheetProbe({ busy: false, ok: false, text: "連不上伺服器，請再試一次" });
    }
  }

  // 送出的完整有序序列：已封存的附件(可能含文字/圖片/檔案交錯) + 目前輸入框裡還沒封存的文字(排最後)。
  // 用這個順序而不是「文字都合併成一句、圖片都堆在後面」，AI 才知道「這句話講的是哪一張圖」。
  const orderedParts = (): Part[] => {
    const trailing = instruction.trim();
    return trailing ? [...attachParts, { kind: "text", text: trailing }] : attachParts;
  };
  const hasContent = orderedParts().some((p) => p.kind !== "text" || p.text.trim());

  async function tweak() {
    setBusyAction("tweak");
    setMsg(null);
    setLastDiff(null);
    try {
      const res = await fetch(`/api/workflows/${workflowId}/nodes/${node.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: orderedParts() }),
      });
      const data = await res.json();
      if (res.ok) {
        onInstructionChange("");
        onAttachPartsChange([]); // 這次微調用掉的附件清空,下次再需要就重新傳
        // 真實踩過的案例：使用者的話根本不是要改設定(例如「讀回值多了逗號是正常的，不影響」)，
        // AI 正確判斷不用改，後端就回 noChangeNeeded+note——要把 note 當成 AI 真正回覆使用者的話
        // 顯示出來，不能沿用「已更新這個節點」(什麼都沒改，講已更新是騙人)，也不能什麼都不顯示
        // (使用者會覺得自己的話講了跟沒講一樣、訊息像沒送出去)。
        if (data.noChangeNeeded) {
          setMsg(data.note ? `💬 ${data.note}` : "AI 看過了，判斷這個節點不用改");
          onChanged();
          return;
        }
        // 超過上限(4 張圖/4 份檔案)的部分後端會默默丟棄——一定要老實講出丟了幾個，
        // 不然使用者以為附的東西 AI 全看到了，其實只看到前 4 個(踩過的真實情境)。
        const dropped = [
          data.droppedImages ? `${data.droppedImages} 張圖片` : null,
          data.droppedFiles ? `${data.droppedFiles} 份檔案` : null,
        ].filter(Boolean).join("、");
        setMsg(dropped ? `已更新這個節點(超過上限，有 ${dropped} 沒有送出，一次最多 4 張圖/4 份檔案)` : "已更新這個節點");
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
        // 同一份補充資料要送進「整條流程」的修復腦，而不是退回只改眼前節點。
        // 這樣附件裡的欄位/畫面可用來判斷真正問題是否在上游。
        body: JSON.stringify({ nodeId: node.id, params: {}, parts: orderedParts() }),
      });
      const data = await res.json();
      // data.suspicion 有值代表流程雖然跑通了，但語意驗收覺得結果可疑——這種情況後端不會記進學習庫
      // (見 autofix/route.ts)，前端也不能講「已記住這個解法」騙使用者，要照實把疑點講出來(踩過的
      // 誠實回報缺口：後端老實標了可疑，前端卻沒接住，照樣顯示「已記住」)。
      const report = conciseRepairReport(data.log);
      if (data.cancelled) setMsg(`已停止修復，沒通過驗證的改動已還原${report}`);
      else if (data.ok && data.suspicion) { setMsg(`⚠️ 流程通過了，但驗收檢查覺得結果可疑：${data.suspicion}——建議親自看一眼結果，有問題再說一次${report}`); onToast(`「${node.label}」跑通了但建議確認一下`); }
      else if (data.ok) { setMsg(`✅ 修好了(試了 ${data.attempts} 次)。下面是實際改動與驗證結果：${report}`); onToast(`已修好：${node.label}`); }
      else if (data.movedTo) setMsg(`這一步已通過，但接著卡在別的節點；請直接點紅色節點處理。${report}`);
      else setMsg(`試了 ${data.attempts ?? ""} 次還沒修好：${data.error ?? ""}${report}`);
      onChanged();
    } catch {
      // 修復 request 與後端 loop 綁定；連線中斷就會 abort，而不是讓使用者畫面沒反應、
      // 後端卻繼續燒時間或偷偷改流程。沒有驗證通過的改動都會還原。
      setMsg("連線中斷，這次 AI 修復已停止；沒有通過驗證的改動不會保留。請重新整理後再試。");
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

  // ── 帳密類失敗:AI 生不出使用者的密碼,「讓 AI 修」注定沒用——直接在失敗卡裡給安全輸入欄位 ──
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  const [savingSecrets, setSavingSecrets] = useState(false);
  async function saveMissingSecrets() {
    const values = Object.fromEntries(Object.entries(secretDraft).filter(([, v]) => v.trim()));
    if (Object.keys(values).length === 0) { setMsg("請先填入缺的帳密再按存檔"); return; }
    setSavingSecrets(true);
    try {
      const res = await fetch(`/api/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: values }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({} as { error?: string }));
        setMsg(`帳密沒有存成功：${(d as { error?: string }).error ?? "請再試一次"}`);
        return;
      }
      setSecretDraft({});
      setMsg("✅ 帳密已存進本機設定(不會傳給 AI)——按上面的「▶ 從這一步開始測」重試這一段");
      onToast("帳密已存好");
      onChanged();
    } finally {
      setSavingSecrets(false);
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
              <p className="text-xs faint">先判斷能不能修；同一個結構性錯誤不會重跑。自訂程式碼會先在 90 秒內重產，再用不寫入資料的方式驗證。</p>
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
        {run?.status === "failed" && (() => {
          // 錯誤點名了缺的帳密欄位=確定是帳密問題;或錯誤講到密鑰/帳密且這條流程真的有欄位沒填。
          // 這兩種情況 AI 都生不出使用者的密碼——給輸入框才是解法,不能只給一顆注定失敗的修復按鈕。
          const errText = run.error ?? "";
          const credNamed = missingSecrets.some((f) => errText.includes(f.key));
          const credLikely = missingSecrets.length > 0 && /密鑰|帳密|帳[號户戶]|密碼|credential|password|login|secret/i.test(errText);
          const showSecretsForm = credNamed || credLikely;
          // 引擎的 classifyFailure 是「這次失敗 AI 修得動嗎」的權威判斷(帳密/缺網址端點/哪一筆資料
          // 不對都歸 needs-human)，節點面板不能自己另外土法煉鋼猜一套——以前這裡只認得帳密關鍵字，
          // 「缺 Apps Script 網址」「報表名稱/日期不對」這些同樣是 AI 猜不出來的問題，卻還留一顆
          // 「讓 AI 修」等使用者白等一輪注定失敗的嘗試，跟「缺東西就直接問、AI 能修才修」的原則不符。
          const isNeedsHuman = failureResolution === "needs-human";
          // classifyFailure 的 reason 是「原始錯誤｜具體指引」的格式，後半段已經講清楚下一步要做什麼
          const guidance = failureReason?.includes("｜") ? failureReason.split("｜").slice(1).join("｜") : null;
          return (
            <div className="card p-3 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--red) 40%, var(--border))", background: "color-mix(in srgb, var(--red) 6%, var(--surface))" }}>
              <p className="text-xs" style={{ color: "var(--red)" }}>❌ {run.error}</p>
              {/* 開瀏覽器的步驟失敗時,引擎會存下當下畫面——讓使用者親眼看到頁面卡在哪(「明明進去了卻說失敗」一看就懂) */}
              <a href={`/api/workflows/${workflowId}/failure-screenshot?nodeId=${node.id}`} target="_blank" rel="noopener noreferrer" className="text-xs underline" style={{ color: "var(--accent)" }}>📸 看失敗當下的畫面</a>
              {showSecretsForm && (
                <div className="space-y-1.5 pt-1">
                  <p className="text-xs font-medium">這是「缺帳密」的問題，直接在這裡填好即可(值只存進本機設定，不會進對話、也不會傳給 AI)：</p>
                  {missingSecrets.map((f) => (
                    <div key={f.key} className="space-y-0.5">
                      <p className="text-xs faint">{f.label || f.key}</p>
                      <input
                        type={f.type === "password" ? "password" : "text"}
                        className="input text-xs w-full"
                        value={secretDraft[f.key] ?? ""}
                        onChange={(e) => setSecretDraft((s) => ({ ...s, [f.key]: e.target.value }))}
                      />
                    </div>
                  ))}
                  <button onClick={saveMissingSecrets} disabled={savingSecrets} className="btn btn-primary text-xs">
                    {savingSecrets ? "存檔中…" : "存好帳密"}
                  </button>
                  <p className="text-xs faint">存好後按上面的「▶ 從這一步開始測」重試這一段。</p>
                </div>
              )}
              {credNamed ? (
                <p className="text-xs faint">(這種缺帳密的問題 AI 修不了——填好上面的欄位就能重試，不用按修復。)</p>
              ) : isNeedsHuman ? (
                <p className="text-xs" style={{ color: "var(--amber)" }}>
                  ⚠️ 這不是 AI 猜得出來的問題{guidance ? `：${guidance}` : "，需要你確認後再重跑，按「讓 AI 修」也不會有用。"}
                </p>
              ) : (
                <button onClick={repair} disabled={busy} className="btn btn-primary text-xs" style={{ background: "var(--red)" }}>
                  {busy ? "修復中…" : "🔧 讓 AI 修這一步"}
                </button>
              )}
            </div>
          );
        })()}
        {node.type !== "trigger" && (
          <div className="card p-3 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={onRunFromHere} disabled={busy} className="btn btn-ghost text-xs">{testOnly ? "▶ 從這一步開始測" : "▶ 從這一步開始執行"}</button>
              <button onClick={onRunOnlyThis} disabled={busy} className="btn btn-ghost text-xs">{testOnly ? "▶ 只測這一步" : "▶ 只執行這一步"}</button>
              <label className="flex items-center gap-1 text-xs faint cursor-pointer select-none">
                <input type="checkbox" checked={watchRun} onChange={(e) => onWatchRunChange(e.target.checked)} />
                看畫面
              </label>
              <label className="flex items-center gap-1 text-xs faint cursor-pointer select-none" title="勾了就只測試:不寫入、不發送、不動任何外部資料">
                <input type="checkbox" checked={testOnly} onChange={(e) => onTestOnlyChange(e.target.checked)} />
                只測試,不更改資料
              </label>
            </div>
            <p className="text-xs faint leading-relaxed">「從這一步」會跑這一步和它後面的所有步驟；「只{testOnly ? "測" : "執行"}這一步」只跑這一格。沒跑到的步驟不會重新執行(有最近一次的結果就沿用，沒有就跳過)。<strong>預設會真的執行到底(包含寫入/發送)</strong>；只想演練、不動任何外部資料，勾「只測試,不更改資料」。預設在背景執行、不會跳出瀏覽器視窗搶走你的畫面——想親眼看操作過程再勾「看畫面」。畫布上也可以直接用滑鼠拖曳框選幾個節點，一次跑那幾步。</p>
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
        {!readonlyWf && editableFields.length > 0 && (
          <div className="card p-4 space-y-4">
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--accent)" }}>✏️ 直接改設定</p>
              <p className="text-xs faint mt-1">小修改可以直接在這裡改；欄位會跟著右側面板一起拉寬。</p>
            </div>
            {editableFields.map((f) => {
              const v = fieldValue(f);
              const set = (val: string | boolean) => setDraftCfg((d) => ({ ...d, [f.key]: val }));
              return (
                <div key={f.key}>
                  <label className="block text-xs faint mb-1">
                    {f.label}
                    {f.help ? <span className="opacity-70">（{f.help}）</span> : null}
                  </label>
                  {f.type === "select" && f.options?.length ? (
                    <select value={String(v)} onChange={(e) => set(e.target.value)} className="input text-sm min-h-11">
                      {String(v) === "" && <option value="">（用預設值）</option>}
                      {f.options.map((o) => {
                        const p = parseOption(o);
                        return <option key={p.value} value={p.value}>{p.label}</option>;
                      })}
                    </select>
                  ) : f.type === "boolean" ? (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={v === true} onChange={(e) => set(e.target.checked)} />
                      <span className="muted">開啟</span>
                    </label>
                  ) : f.type === "textarea" ? (
                    <textarea value={String(v)} onChange={(e) => set(e.target.value)} rows={6} className="input text-sm resize-y leading-relaxed min-h-32" placeholder={f.default ? `預設：${f.default}` : "留空會使用預設值"} />
                  ) : (
                    <input
                      value={String(v)}
                      onChange={(e) => set(e.target.value)}
                      inputMode={f.type === "number" ? "numeric" : undefined}
                      className="input text-sm min-h-11"
                      placeholder={f.default ? `預設：${f.default}` : "留空會使用預設值"}
                    />
                  )}
                  {f.key === "scriptUrl" && (
                    <div className="mt-2 space-y-2">
                      <button type="button" onClick={probeScriptUrl} disabled={sheetProbe.busy || !String(v).trim()} className="btn btn-ghost text-xs">
                        {sheetProbe.busy ? "檢查並儲存中…" : "🔎 檢查並套用到本流程所有寫入步驟（不寫資料）"}
                      </button>
                      {sheetProbe.text && <p className="text-xs" style={{ color: sheetProbe.ok ? "var(--green)" : "var(--red)" }}>{sheetProbe.text}</p>}
                      <details className="rounded-lg border p-3 text-xs">
                        <summary className="cursor-pointer font-medium">第一次設定 Apps Script 寫入網址</summary>
                        <ol className="list-decimal ml-4 mt-2 space-y-1.5 muted">
                          <li>打開要寫入的試算表 →「擴充功能」→「Apps Script」。</li>
                          <li>複製下方 v3 程式碼，完整取代編輯器內容後儲存。</li>
                          <li>「部署」→「新增部署作業」→「網頁應用程式」→ 存取權選「任何人」。</li>
                          <li>把 Google 給的 <code>https://script.google.com/macros/…/exec</code> 網址貼回上方欄位。</li>
                        </ol>
                        <button type="button" className="btn btn-ghost text-xs mt-2" onClick={copySheetScript}>
                          {sheetScriptCopied ? "✅ 已複製 v3 程式碼" : "📋 複製 v3 程式碼"}
                        </button>
                        <details className="mt-2">
                          <summary className="cursor-pointer faint">需要手動複製時才展開程式碼</summary>
                          <pre className="mt-2 p-2 rounded-md overflow-x-auto whitespace-pre text-[11px]" style={{ background: "var(--surface-2)" }}>{GOOGLE_SHEET_SCRIPT_TEMPLATE}</pre>
                        </details>
                      </details>
                    </div>
                  )}
                </div>
              );
            })}
            <button onClick={saveConfig} disabled={!dirty || saving} className="btn btn-primary w-full justify-center text-sm">
              {saving ? "儲存中…" : dirty ? "儲存修改" : "沒有修改"}
            </button>
            {saveMsg && <p className="text-xs" style={{ color: saveMsg.startsWith("✓") ? "var(--green)" : "var(--red)" }}>{saveMsg}</p>}
            <p className="text-[11px] faint leading-relaxed">改完記得按儲存;複雜的改動(換做法/加步驟)還是用下面的白話請 AI 改最快。</p>
          </div>
        )}
        {lastDiff && (
          <div className="card p-3 space-y-1.5" style={{ borderColor: "var(--accent)" }}>
            <p className="text-xs font-medium" style={{ color: "var(--accent)" }}>AI 剛剛改了什麼</p>
            {friendlyLastDiff.length === 0 ? (
              <p className="text-xs muted">設定內容沒有變化。</p>
            ) : (
              friendlyLastDiff.map(({ key, label, before, after }) => (
                <div key={key} className="text-xs">
                  <span className="faint">{label}：</span>
                  {before !== undefined && <span className="line-through opacity-60">{before}</span>}
                  {before !== undefined && after !== undefined && " → "}
                  {after !== undefined && <span style={{ color: "var(--green)" }}>{after}</span>}
                </div>
              ))
            )}
          </div>
        )}
        {run?.output_json && (
          <div>
            <button onClick={() => setShowTechnical((v) => !v)} className="text-xs faint hover:text-[var(--text)]">
              {showTechnical ? "▾" : "▸"} 看這一步上次做出的結果
            </button>
            {showTechnical && (
            <div className="mt-2 space-y-3">
              <div>
                <p className="text-xs faint mb-1.5">實際結果</p>
                <div className="text-xs rounded-lg p-3 overflow-auto max-h-44 whitespace-pre-wrap break-all" style={{ background: "var(--surface-2)" }}>
                  {formatOutput(run.output_json)}
                </div>
              </div>
            </div>
            )}
          </div>
        )}
      </div>
      <div className="border-t p-4 space-y-2">
        <p className="text-xs faint">用白話叫 AI 微調這個節點；出錯的話可以直接傳截圖/檔案給它看</p>
        {attachParts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {attachParts.map((p, i) => (
              <span key={i} className="badge badge-neutral gap-1 pr-1 max-w-full" title={p.kind === "file" ? p.name : p.kind === "text" ? p.text : undefined}>
                <span className="truncate min-w-0">
                  {p.kind === "image" ? "🖼 圖片" : p.kind === "file" ? `📄 ${p.name}` : p.kind === "text" ? `「${p.text.slice(0, 12)}${p.text.length > 12 ? "…" : ""}」` : ""}
                </span>
                <button onClick={() => onAttachPartsChange(attachParts.filter((_, j) => j !== i))} className="faint hover:text-[var(--text)] shrink-0">✕</button>
              </span>
            ))}
            <span className="text-[10px] faint self-center">← AI 會照這個順序理解</span>
          </div>
        )}
        {/* 這裡刻意「不」放自己的 onPaste——貼上事件本來就會冒泡到 window,父頁的全域 paste handler
          * 在有選節點時已經會把圖片附進這個節點(processFilesForNode)。之前這裡多接一次造成
          * 「貼一張圖出現兩個附件」(實測證實過的重複處理 bug)。 */}
        <textarea
          value={instruction}
          onChange={(e) => onInstructionChange(e.target.value)}
          placeholder="例如：改成抓『每週業績追蹤』那封信"
          rows={2}
          className="input resize-none"
        />
        <div className="flex items-center gap-2">
          <label className="btn btn-ghost text-xs cursor-pointer">
            📎 加圖片/檔案
            <input
              ref={attachInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => { onAttachFiles(Array.from(e.target.files ?? [])); if (attachInputRef.current) attachInputRef.current.value = ""; }}
            />
          </label>
          <button onClick={tweak} disabled={busy || !hasContent} className="btn btn-primary flex-1 justify-center">
            {busy ? "處理中…" : "送出"}
          </button>
        </div>
        {msg && <p className="text-xs muted">{msg}</p>}
      </div>
    </div>
  );
}
