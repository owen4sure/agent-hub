"use client";

import { useEffect, useRef, useState } from "react";
import { ICONS } from "./nodeVisuals";
import { fetchNodeDefs, type NodeDefLite, type ParamFieldLite } from "./AddNodePanel";
import type { WFNode, NodeRun } from "./types";
import { plainLanguage } from "@/lib/workflow/plainLanguage";
import { GOOGLE_SHEET_SCRIPT_TEMPLATE } from "@/lib/googleSheetScriptTemplate";
import { AppsScriptSetupSteps } from "./AppsScriptSetupSteps";
import type { Part } from "@/lib/wfChatStore";
import { findFieldMistakes, type InsertableField } from "@/lib/workflow/insertableFields";
import { parseUserFields } from "@/lib/workflow/userStepFields";
import { POLICY_FIELDS } from "@/lib/workflow/nodePolicy";

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


/**
 * 「可以插入前面步驟算出來的資料」——使用者原話：「使用者看不懂 {{periodLabel}} 這種東西是什麼」。
 *
 * 所以這一排方塊做三件事：①顯示白話名稱 ②顯示上次執行的真實值(他認得出是不是自己要的)
 * ③點一下就插進游標處——他從頭到尾不用打出大括號，也不用知道那串英文是什麼。
 */
function InsertableFieldChips({ fields, onInsert }: { fields: InsertableField[]; onInsert: (key: string) => void }) {
  if (fields.length === 0) return null;
  return (
    <div className="mt-1.5">
      <div className="text-xs faint mb-1">📎 可以插入前面步驟算出來的資料（點一下就插進游標處）：</div>
      <div className="flex flex-wrap gap-1.5">
        {fields.map((field) => (
          <button
            key={field.key}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onInsert(field.key)}
            className="rounded-md border px-2 py-1 text-left hover:opacity-80"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
            title={`來自「${field.from}」這一步`}
          >
            <div className="text-xs">{field.label}</div>
            {field.sample ? <div className="text-[10px] faint">{field.sample}</div> : null}
            <div className="text-[10px] faint opacity-70">← {field.from}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 打了一個沒有人產生的欄位時，當場說「你是不是要用○○？」——不要等執行時才炸。 */
function FieldMistakeHints({ text, fields, onFix }: { text: string; fields: InsertableField[]; onFix: (from: string, to: string) => void }) {
  const mistakes = findFieldMistakes(text, fields);
  if (mistakes.length === 0) return null;
  return (
    <div className="mt-1.5 space-y-1">
      {mistakes.map((mistake) => (
        <div key={mistake.token} className="text-xs rounded-md border p-2" style={{ borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))" }}>
          {mistake.suggestion ? (
            <>
              <span style={{ color: "var(--amber)" }}>前面的步驟沒有「{mistake.token}」這個資料。</span>
              <span className="muted">你是不是要用「{mistake.suggestion.label}」？</span>
              <button type="button" className="btn btn-ghost text-xs ml-1" onClick={() => onFix(mistake.token, mistake.suggestion!.key)}>換成這個</button>
            </>
          ) : (
            <>
              <span style={{ color: "var(--amber)" }}>前面的步驟沒有「{mistake.token}」這個資料。</span>
              <span className="muted">需要的話，在右邊對話跟我說「加一步算出{mistake.token}」，我幫你補上那個步驟。</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
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
  onTestSendToSelf,
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
  /** 「用網頁信箱寄信」節點專用的測試寄送：不管節點設定的收件人是誰，這次一定只會寄到傳進來的這個信箱
   * （安全保證在後端 API 那一層做，不是這裡的 UI 約束——見 test-send/route.ts）。 */
  onTestSendToSelf: (testEmail: string) => Promise<void>;
  /** 部分執行要不要開有頭瀏覽器看畫面。預設關——開視窗會把使用者的螢幕焦點搶走 */
  watchRun: boolean;
  onWatchRunChange: (v: boolean) => void;
  /** 「只演練，不更改資料」勾選：預設 false=真的執行到底(含寫入/發送)——使用者拍板「圈起來執行的
   * 就執行到底,除非我有說只測試」;勾了才走只讀演練(dryRun)。 */
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
  // 區分是哪個動作在忙。repair(自動修復)是多輪迴圈，用 /stop-loop 端點中途喊停；
  // tweak(單次 AI 微調)是單一 fetch——它的後端(nodeEditor.ts→callClaudeCode)已經接了 req.signal，
  // 直接 abort 這個 fetch 就會一路中斷到還在跑的本機 Claude Code 子行程，不需要另外的 stop 端點。
  // 附檔案/截圖時會走 high-effort 的本機 Claude Code，實測單次就可能跑到 4-5 分鐘——沒有停止鍵、
  // 也沒有「這是正常的、不是卡住」的說明，使用者只會看到一顆轉圈圈的圈圈，容易誤以為壞了。
  const [busyAction, setBusyAction] = useState<"tweak" | "repair" | null>(null);
  const busy = busyAction !== null;
  const [stopping, setStopping] = useState(false);
  const tweakControllerRef = useRef<AbortController | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(node.label);
  const [editingName, setEditingName] = useState(false);
  const [lastDiff, setLastDiff] = useState<{ before: Record<string, unknown>; after: Record<string, unknown> } | null>(null);
  // 使用者是不懂程式的人，預設只給他看得懂的白話說明(explainStep 由父層一次抓整條流程的說明後傳下來，
  // 不用每點開一個節點就重打一次 API)；原始 config/code 只留給想除錯的人，收在下面「技術細節」裡預設收合。
  const [showTechnical, setShowTechnical] = useState(false);

  // ── ✉️ 測試寄送(僅 webmail-send)：記住上次填的信箱只是省得每次重打，不是「已設定好的正式值」——
  // 一定要在畫面上看得到、可以改，寄送當下也一定要重新讀這個欄位當下的值，不能用什麼隱藏預設值。
  const [testSendEmail, setTestSendEmail] = useState("");
  const [testSending, setTestSending] = useState(false);
  useEffect(() => {
    const saved = window.localStorage.getItem("agenthub_test_send_email");
    if (saved) setTestSendEmail(saved);
  }, []);
  async function handleTestSend() {
    const email = testSendEmail.trim();
    if (!email || testSending) return;
    setTestSending(true);
    try {
      window.localStorage.setItem("agenthub_test_send_email", email);
      await onTestSendToSelf(email);
    } finally {
      setTestSending(false);
    }
  }

  // ── 直接改設定:簡單值(網址/關鍵字/檔名…)自己打字改,不用每次都求 AI(雙模式編輯拍板) ──
  const [defs, setDefs] = useState<NodeDefLite[] | null>(null);
  // 可以插入的上游欄位（含上次執行的真實值）——讓使用者不用打出 {{}} 也不用懂那串英文
  const [insertable, setInsertable] = useState<InsertableField[]>([]);
  useEffect(() => {
    let alive = true;
    fetch(`/api/workflows/${workflowId}/insertable-fields?nodeId=${encodeURIComponent(node.id)}`)
      .then((res) => res.json())
      .then((data) => { if (alive) setInsertable(Array.isArray(data.fields) ? data.fields : []); })
      .catch(() => { /* 拿不到就不顯示，不影響面板其他功能 */ });
    return () => { alive = false; };
  }, [workflowId, node.id]);
  const fieldRefs = useRef<Record<string, HTMLTextAreaElement | HTMLInputElement | null>>({});
  // 那排「可以插入」的方塊只在**正在編輯的那個欄位**底下出現。
  // 真的做出來看畫面才發現的問題：每個欄位下面都掛一排，同樣三塊重複五次變成一片雜訊，
  // 而且在「收件人」下面提示插入信件內文根本沒意義。跟著游標走才有用。
  const [focusedField, setFocusedField] = useState<string | null>(null);
  // 「存成我的步驟」：把這一步變成可以在別條流程重複套用的積木。
  const [saveStepDraft, setSaveStepDraft] = useState<null | {
    name: string; description: string; intent: string; code: string;
    params: { key: string; label: string; type: string; default?: string }[];
    rejected: { literal: string; reason: string }[]; note: string;
  }>(null);
  const [saveStepBusy, setSaveStepBusy] = useState(false);
  // 「你要先去執行一次」這種需要使用者動手的訊息不能只用 toast——它 3.5 秒就淡出，
  // 使用者按完鈕、視線還在按鈕上，回頭就什麼都沒有了(實測：等 9 秒回來畫面完全乾淨)。
  const [saveStepError, setSaveStepError] = useState<string | null>(null);
  /** 插到游標處，不是無腦接在最後面——使用者通常是想插在某一句話中間。 */
  const insertToken = (key: string, fieldKey: string, current: string, set: (v: string) => void) => {
    const el = fieldRefs.current[fieldKey];
    const token = `{{${key}}}`;
    if (!el || typeof el.selectionStart !== "number") { set(current + token); return; }
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? start;
    set(current.slice(0, start) + token + current.slice(end));
    window.setTimeout(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length); }, 0);
  };

  const [draftCfg, setDraftCfg] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [sheetScriptCopied, setSheetScriptCopied] = useState(false);
  const [sheetProbe, setSheetProbe] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false });
  // 「這個 POST 只是查詢」的使用者確認狀態。刻意從伺服器讀、不從 node.config 推——config 上的
  // readOnly 只是 AI 的建議，真正的批准存在 DB 且綁請求指紋(AI 改了網址/body 就自動失效)。
  const [readOnlyState, setReadOnlyState] = useState<{ applicable: boolean; aiSuggestsReadOnly: boolean; approved: boolean } | null>(null);
  const [readOnlyBusy, setReadOnlyBusy] = useState(false);
  useEffect(() => { fetchNodeDefs().then(setDefs).catch(() => {}); }, []);
  useEffect(() => {
    if (node.type !== "http-request") return;
    fetch(`/api/workflows/${workflowId}/http-readonly?nodeId=${encodeURIComponent(node.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setReadOnlyState(d ? { applicable: !!d.applicable, aiSuggestsReadOnly: !!d.aiSuggestsReadOnly, approved: !!d.approved } : null))
      .catch(() => {});
  }, [workflowId, node.id, node.type, saveMsg]);

  async function setReadOnlyApproval(approve: boolean) {
    setReadOnlyBusy(true);
    try {
      const res = await fetch(`/api/workflows/${workflowId}/http-readonly`, {
        method: approve ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setReadOnlyState((prev) => (prev ? { ...prev, approved: !!data.approved } : prev));
      else setSaveMsg(data.error ?? "確認失敗");
    } catch {
      setSaveMsg("確認失敗，請確認伺服器是否正常");
    } finally {
      setReadOnlyBusy(false);
    }
  }
  // 切換節點時的草稿重置不用 effect——父層用 key={node.id} 強制重建整個面板,state 天生就是乾淨的
  const schema = defs?.find((d) => d.type === node.type)?.configSchema ?? [];
  // 可直接改的欄位:排除帳密(在設定頁)、AI 管的程式碼/內嵌步驟、觸發參數衍生欄位
  const schemaFields = schema.filter(
    (f) => f.type !== "secret" && f.type !== "code" && !f.derived && !(node.type === "repeat-steps" && f.key === "steps") && !(node.type === "custom-code" && f.key === "code"),
  );
  // 「我的步驟」展開出來的節點，會在自己的 config 裡宣告使用者自訂的設定欄位。
  // 這是整個「讓使用者做出現成沒有的功能」的最後一哩：不長出這些欄位的話，他存的步驟每次套用
  // 都得進去改程式碼，那就跟沒存一樣。使用者自訂的排前面——那才是他每次真的要改的東西。
  const userFields = parseUserFields((node.config as Record<string, unknown>).userFields).map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    default: field.default,
    help: field.help,
  })) as ParamFieldLite[];
  const editableFields = [...userFields, ...schemaFields.filter((f) => !userFields.some((u) => u.key === f.key))];
  // CSS 選擇器、內部系統代號這類欄位(advanced:true)一般使用者看不懂也不用手動改——收進
  // 預設收合的「進階設定」，跟「標題關鍵字」這種一看就懂的欄位分開，見 ParamField.advanced 註解。
  const basicFields = editableFields.filter((f) => !f.advanced);
  // 失敗策略(重試幾次/失敗也繼續)不屬於任何節點型別的 schema，是引擎層對每一步都適用的保留鍵。
  // 一定要在這裡長出表單欄位——不然使用者只能手改 JSON，等於這個功能不存在(唯一入口原則)。
  const advancedFields = [
    ...editableFields.filter((f) => f.advanced),
    ...(POLICY_FIELDS as ParamFieldLite[]).filter((p) => !editableFields.some((f) => f.key === p.key)),
  ];
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
    const controller = new AbortController();
    tweakControllerRef.current = controller;
    try {
      const res = await fetch(`/api/workflows/${workflowId}/nodes/${node.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: orderedParts() }),
        signal: controller.signal,
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
        setMsg(dropped ? `已更新這個步驟(超過上限，有 ${dropped} 沒有送出，一次最多 4 張圖/4 份檔案)` : "已更新這個步驟");
        // AI 到底改了什麼，之前後端有回傳(before/config)但畫面上從來沒顯示過——現在秀出來讓使用者確認
        setLastDiff({ before: data.before ?? {}, after: data.config ?? {} });
        onChanged();
        onToast(`已更新：${node.label}`); // 畫布也跳一下通知，不是只有這個面板裡的文字看得到
      } else setMsg(`失敗：${data.error}`);
    } catch {
      if (controller.signal.aborted) {
        // 使用者自己按了停止——後端的 callClaudeCode 收到 abort 會直接殺掉子行程，不會留下半套改動。
        setMsg("已停止，這個節點沒有被改動。");
      } else {
        // 連線中斷/回應不是 JSON 時，後端可能其實已經改好了——無論如何重載一次，別讓畫面停在舊設定
        setMsg("連線中斷，AI 可能已完成修改，已重新載入最新設定");
        onChanged();
      }
    } finally {
      tweakControllerRef.current = null;
      setBusyAction(null);
    }
  }

  function stopTweak() {
    tweakControllerRef.current?.abort();
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
      else if (data.movedTo) setMsg(`這一步已通過，但接著卡在別的步驟；請直接點紅色步驟處理。${report}`);
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

  function renderConfigField(f: ParamFieldLite) {
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
          <textarea ref={(el) => { fieldRefs.current[f.key] = el; }} onFocus={() => setFocusedField(f.key)} value={String(v)} onChange={(e) => set(e.target.value)} rows={6} className="input text-sm resize-y leading-relaxed min-h-32" placeholder={f.default ? `預設：${f.default}` : "留空會使用預設值"} />
        ) : (
          <input
            ref={(el) => { fieldRefs.current[f.key] = el; }}
            onFocus={() => setFocusedField(f.key)}
            value={String(v)}
            onChange={(e) => set(e.target.value)}
            inputMode={f.type === "number" ? "numeric" : undefined}
            className="input text-sm min-h-11"
            placeholder={f.default ? `預設：${f.default}` : "留空會使用預設值"}
          />
        )}
        {/* 可以插入哪些上游資料 + 打錯了當場提醒。只對「會做 {{欄位}} 代換」的文字型欄位顯示；
            勾選框、下拉選單不吃樣板，掛上去只會變成雜訊。 */}
        {(f.type === "textarea" || f.type === "text" || !f.type) && (
          <>
            {focusedField === f.key && (
              <InsertableFieldChips fields={insertable} onInsert={(key) => insertToken(key, f.key, String(v), (val) => set(val))} />
            )}
            <FieldMistakeHints
              text={String(v)}
              fields={insertable}
              onFix={(from, to) => set(String(v).split(`{{${from}}}`).join(`{{${to}}}`))}
            />
          </>
        )}
        {f.key === "readOnly" && node.type === "http-request" && readOnlyState?.applicable && (
          <div className="mt-2 rounded-lg border p-3 text-xs space-y-2" style={{ borderColor: readOnlyState.approved ? "var(--green)" : "var(--amber)" }}>
            {readOnlyState.approved ? (
              <>
                <p style={{ color: "var(--green)" }}>✅ 你已確認這個呼叫只是查詢。演練會真的執行它。</p>
                <p className="faint">之後若網址、Headers、Body 或方法被改動(包括 AI 自己改)，這個確認會自動失效，需要你重新確認。</p>
                <button type="button" disabled={readOnlyBusy} onClick={() => setReadOnlyApproval(false)} className="btn btn-ghost text-xs">
                  {readOnlyBusy ? "處理中…" : "取消確認"}
                </button>
              </>
            ) : (
              <>
                <p style={{ color: "var(--amber)" }}>
                  {readOnlyState.aiSuggestsReadOnly
                    ? "AI 建議這是查詢，但需要你確認此端點不會寫資料。"
                    : "這個呼叫不是 GET，系統一律當成「可能會改動對方的資料」。"}
                </p>
                <p className="faint">在你確認之前，演練會略過這一步(不會真的送出)。只有你確定這個網址只是查詢、不會建立或修改對方的資料時才按確認。</p>
                <button type="button" disabled={readOnlyBusy} onClick={() => setReadOnlyApproval(true)} className="btn btn-ghost text-xs">
                  {readOnlyBusy ? "處理中…" : "我確認這個呼叫只是查詢"}
                </button>
              </>
            )}
          </div>
        )}
        {f.key === "scriptUrl" && (
          <div className="mt-2 space-y-2">
            <button type="button" onClick={probeScriptUrl} disabled={sheetProbe.busy || !String(v).trim()} className="btn btn-ghost text-xs">
              {sheetProbe.busy ? "檢查並儲存中…" : "🔎 檢查並套用到本流程所有寫入步驟（不寫資料）"}
            </button>
            {sheetProbe.text && <p className="text-xs" style={{ color: sheetProbe.ok ? "var(--green)" : "var(--red)" }}>{sheetProbe.text}</p>}
            <details className="rounded-lg border p-3 text-xs">
              <summary className="cursor-pointer font-medium">第一次設定 Apps Script 寫入網址</summary>
              <div className="mt-2">
                <AppsScriptSetupSteps
                  bound
                  pasteDestination={<>貼回<b>上方欄位</b></>}
                  copyButton={
                    <>
                      按這顆把腳本複製起來。
                      <div className="mt-1.5">
                        <button type="button" className="btn btn-ghost text-xs" onClick={copySheetScript}>
                          {sheetScriptCopied ? "✅ 已複製 v3 程式碼" : "📋 複製 v3 程式碼"}
                        </button>
                      </div>
                    </>
                  }
                />
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer faint">需要手動複製時才展開程式碼</summary>
                <pre className="mt-2 p-2 rounded-md overflow-x-auto whitespace-pre text-[11px]" style={{ background: "var(--surface-2)" }}>{GOOGLE_SHEET_SCRIPT_TEMPLATE}</pre>
              </details>
            </details>
          </div>
        )}
      </div>
    );
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
          {busyAction === "tweak" && (
            <>
              <p className="text-xs faint">正在看你附的截圖/檔案並判斷要改哪裡；附件較多或需要仔細比對時，幾分鐘內都算正常，不是卡住。</p>
              <button onClick={stopTweak} className="btn text-xs mt-1" style={{ background: "var(--red)", color: "#fff" }}>
                ⏹ 停止
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
          // 只讀演練的可驗證邊界：這一步是因為上游寫入被安全攔下才拿不到資料，不是壞掉。
          // 給「讓 AI 修」等於請他按一顆注定空轉的按鈕(修復迴圈會對著不存在的問題想三輪)。
          const isDryRunBoundary = failureResolution === "dry-run-boundary";
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
              ) : isDryRunBoundary ? (
                <p className="text-xs" style={{ color: "var(--amber)" }}>
                  🔒 這一步的資料要由上游「會真的寫入/操作外部系統」的步驟產生，只讀演練把那些步驟安全攔下了，所以這裡拿不到資料——不是流程壞掉，按「讓 AI 修」沒有東西可修。要驗證這一段請用上方「▶ 執行」完整執行。
                </p>
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
                只演練，不更改資料
              </label>
            </div>
            <p className="text-xs faint leading-relaxed">「從這一步」會跑這一步和它後面的所有步驟；「只{testOnly ? "測" : "執行"}這一步」只跑這一步。沒跑到的步驟不會重新執行(有最近一次的結果就沿用，沒有就跳過)。<strong>預設會真的執行到底(包含寫入/發送)</strong>；只想演練、不動任何外部資料，勾「只演練，不更改資料」。預設在背景執行、不會跳出瀏覽器視窗搶走你的畫面——想親眼看操作過程再勾「看畫面」。畫布上也可以直接用滑鼠拖曳框選幾個步驟，一次跑那幾步。</p>
          </div>
        )}
        {node.type === "webmail-send" && (
          <div className="card p-3 space-y-1.5">
            <p className="text-xs font-medium">✉️ 測試寄送</p>
            <p className="text-xs faint leading-relaxed">
              用這一步真正會產生的主旨/內容/附件寄一封信，但<strong>不管上面收件人/副本/密件副本欄位填了什麼，這裡一定只會寄到你下面填的這個信箱</strong>，其他收件人完全不會用到——放心拿來檢查格式跟附件對不對。
            </p>
            <div className="flex gap-2">
              <input
                type="email"
                value={testSendEmail}
                onChange={(e) => setTestSendEmail(e.target.value)}
                placeholder="你自己的信箱地址"
                className="input text-xs flex-1"
              />
              <button onClick={handleTestSend} disabled={!testSendEmail.trim() || testSending} className="btn btn-ghost text-xs shrink-0">
                {testSending ? "寄送中…" : "寄一封測試信給我"}
              </button>
            </div>
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
        {/* 讓使用者把自己調通的東西存成可重複套用的積木——這是「現成的沒有我要的功能怎麼辦」的答案。
            只對自訂程式碼步驟出現：其他型別的步驟本來就能在任何流程重複使用。 */}
        {!readonlyWf && node.type === "custom-code" && String((node.config as Record<string, unknown>).code ?? "").trim() && (
          <div className="card p-4 space-y-2">
            <p className="text-sm font-medium" style={{ color: "var(--accent)" }}>⭐ 存成我的步驟</p>
            <p className="text-xs faint">
              存起來之後，在任何流程按「加步驟」都能直接用它，不用再叫 AI 重做一次。
              每次可能要改的地方（收件人、網址、關鍵字…）會變成可以填的欄位。
            </p>
            <button
              className="btn btn-ghost text-xs"
              disabled={saveStepBusy}
              onClick={async () => {
                setSaveStepBusy(true);
                setSaveStepError(null);
                try {
                  const res = await fetch(`/api/workflows/${workflowId}/parameterize`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ nodeId: node.id }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) { setSaveStepError((data as { error?: string }).error ?? "沒辦法存成步驟"); return; }
                  setSaveStepDraft({
                    name: String(data.name ?? node.label),
                    description: String(data.intent ?? ""),
                    intent: String(data.intent ?? ""),
                    code: String(data.code ?? ""),
                    params: Array.isArray(data.params) ? data.params : [],
                    rejected: Array.isArray(data.rejected) ? data.rejected : [],
                    note: String(data.note ?? ""),
                  });
                } finally { setSaveStepBusy(false); }
              }}
            >
              {saveStepBusy ? "整理中…" : "⭐ 存成我的步驟"}
            </button>
            {saveStepError && (
              <p className="text-xs rounded-md border p-2" style={{ borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))", color: "var(--amber)" }}>
                {saveStepError}
              </p>
            )}
          </div>
        )}

        {saveStepDraft && (
          <div className="card p-4 space-y-3" style={{ borderColor: "var(--accent)" }}>
            <p className="text-sm font-medium">存成我的步驟</p>
            <label className="block text-xs">
              <span className="faint">名稱（之後在「加步驟」裡會看到它）</span>
              <input className="input text-sm mt-1" value={saveStepDraft.name}
                onChange={(e) => setSaveStepDraft((d) => (d ? { ...d, name: e.target.value } : d))} />
            </label>
            <label className="block text-xs">
              <span className="faint">一句話說明這個步驟在做什麼</span>
              <input className="input text-sm mt-1" value={saveStepDraft.description}
                onChange={(e) => setSaveStepDraft((d) => (d ? { ...d, description: e.target.value } : d))} />
            </label>
            <div className="text-xs">
              <div className="faint mb-1">
                {saveStepDraft.params.length > 0
                  ? "下面這幾個是「每次套用可以不一樣」的地方，名稱可以改成你看得懂的說法："
                  : (saveStepDraft.note || "這一步沒有需要每次調整的地方。")}
              </div>
              <div className="space-y-1.5">
                {/* 名稱輸入框獨佔一行：跟「目前是…」「不要這個」擠在同一列時，實測寬度只剩幾個字，
                    使用者連自己打的名稱都看不完整，等於改不了名(截圖才發現的)。 */}
                {saveStepDraft.params.map((param, index) => (
                  <div key={param.key} className="rounded-md border p-2 space-y-1" style={{ borderColor: "var(--border)" }}>
                    <input
                      className="input text-sm w-full"
                      value={param.label}
                      placeholder="給這個欄位一個你看得懂的名稱"
                      onChange={(e) => setSaveStepDraft((d) => d && ({
                        ...d, params: d.params.map((p, i) => (i === index ? { ...p, label: e.target.value } : p)),
                      }))}
                    />
                    <div className="flex items-center gap-2">
                      <span className="faint truncate">目前是「{String(param.default ?? "").slice(0, 40)}」</span>
                      <button
                        className="btn btn-ghost text-xs shrink-0 ml-auto"
                        title="這個不要變成欄位"
                        onClick={() => setSaveStepDraft((d) => d && ({ ...d, params: d.params.filter((_, i) => i !== index) }))}
                      >不要這個</button>
                    </div>
                  </div>
                ))}
              </div>
              {saveStepDraft.rejected.length > 0 && (
                <div className="faint mt-2">
                  有 {saveStepDraft.rejected.length} 個地方本來想做成欄位但沒辦法（{saveStepDraft.rejected[0].reason}），存起來之後那幾個地方會固定不變。
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn btn-primary text-xs"
                disabled={saveStepBusy}
                onClick={async () => {
                  setSaveStepBusy(true);
                  try {
                    const res = await fetch("/api/user-steps", {
                      method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        name: saveStepDraft.name, description: saveStepDraft.description, intent: saveStepDraft.intent,
                        code: saveStepDraft.code, params: saveStepDraft.params,
                        sourceWorkflowId: workflowId, sourceNodeId: node.id,
                      }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) { onToast((data as { error?: string }).error ?? "存檔失敗"); return; }
                    setSaveStepDraft(null);
                    onToast(`已存成「${saveStepDraft.name}」，之後在「加步驟」就找得到`);
                  } finally { setSaveStepBusy(false); }
                }}
              >{saveStepBusy ? "存檔中…" : "確定存起來"}</button>
              <button className="btn btn-ghost text-xs" onClick={() => setSaveStepDraft(null)}>取消</button>
            </div>
          </div>
        )}

        {!readonlyWf && editableFields.length > 0 && (
          <div className="card p-4 space-y-4">
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--accent)" }}>✏️ 直接改設定</p>
              <p className="text-xs faint mt-1">小修改可以直接在這裡改；欄位會跟著右側面板一起拉寬。</p>
            </div>
            {basicFields.map(renderConfigField)}
            {advancedFields.length > 0 && (
              <details className="rounded-lg border p-3 text-xs">
                <summary className="cursor-pointer font-medium faint">🔧 進階設定（一般不用改；壞了用下面「讓 AI 修」比較快）</summary>
                <div className="mt-3 space-y-4">{advancedFields.map(renderConfigField)}</div>
              </details>
            )}
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
        <p className="text-xs faint">用白話叫 AI 微調這個步驟；出錯的話可以直接傳截圖/檔案給它看</p>
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
