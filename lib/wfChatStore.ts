"use client";

import { useSyncExternalStore } from "react";
import type { WorkflowNode, WorkflowEdge, ParamField } from "@/lib/workflow/types";
import type { SuggestedSchedule } from "@/lib/workflow/builder";
import { classifyChatCommand } from "@/lib/workflow/chatCommand";
import { sheetWriteNodesNeedingSetup } from "@/lib/googleSheetScriptTemplate";
import { slidesRefreshNodesNeedingOAuthSetup } from "@/lib/googleSlidesApi";
import { formatPlannedWriteLines, formatSafeRunOutput, humanizePreviewPair } from "@/lib/workflow/plainLanguage";
import { compactHistoryForPersistence, compactHistoryForRequest, historyHasReusablePreviewFile } from "@/lib/chatHistory";
import { extractChatRunParams, schemaAcceptsDateRange, type DateRange } from "@/lib/workflow/chatRunParams";
import { redactIfLooksLikeCredential } from "@/lib/workflow/chatCredentials";

// 這些 AI 長時間工作的狀態(對話、思考中、待套用的新流程、自動測試)本來存在頁面元件裡，
// 一切換畫面元件就被銷毀、結果就不見。改存在這個「模組層」store：它不隨頁面卸載而消失，
// 所以切走再回來還在；正在跑的 fetch 也是在這裡發動的，不會被中斷。對話另外存 localStorage，
// 連重新整理也還在。

export type Part =
  | { kind: "text"; text: string }
  | { kind: "image"; b64: string; name?: string; mime?: string; assetId?: string }
  | { kind: "file"; name: string; content: string; assetId?: string }
  // 「Google 試算表寫入腳本」設定卡的標記:實際腳本內容由 UI 從 GOOGLE_SHEET_SCRIPT_TEMPLATE 讀,
  // 不存進對話(不佔 localStorage、也不會被白話過濾層改壞)。只出現在 isControl 訊息,永遠不送模型。
  | { kind: "sheet-script"; nodeLabels: string[] }
  // Google Slides 第一次官方授權的分段設定卡；細節由 UI 呈現，不把一大串技術教學塞進模型對話。
  | { kind: "slides-oauth-setup"; nodeLabels: string[] };

/** isError=true 的訊息是「系統錯誤提示」(連線失敗之類)，只給人看——送給模型的歷史一定要濾掉它們，
 * 不然模型會把它們當成「AI 之前說過的話」有樣學樣，開始自己回覆「連線失敗」(真實踩過的雷)。 */
export interface ChatMsg {
  role: "user" | "assistant";
  parts: Part[];
  isError?: boolean;
  /** 產品自己的進度／安全／執行提示，不當成模型上一輪的回答送回建圖。 */
  isControl?: boolean;
}

// 舊的(還沒有 isError 標記就存進 localStorage 的)錯誤訊息用文字特徵辨識，一樣要濾掉。
// 用「訊息開頭就是這幾句系統話術」比對(^)，不用寬鬆的包含比對——不然使用者在跟 AI 討論
// 「登入連線失敗要怎麼處理」時，AI 回覆裡提到『連線失敗』會被誤判成系統錯誤而被丟掉。
const ERROR_TEXT_PATTERNS = [/^（連線出錯，AI 沒回覆/, /^\(AI 又連線失敗/, /^AI 暫時連不上或忙線中/];
export function isSystemErrorMsg(m: ChatMsg): boolean {
  if (m.isError) return true;
  return m.role === "assistant" && m.parts.some((p) => p.kind === "text" && ERROR_TEXT_PATTERNS.some((r) => r.test(p.text.trim())));
}
export function isNonModelMsg(m: ChatMsg): boolean {
  return isSystemErrorMsg(m) || Boolean(m.isControl);
}
export interface AutoStep { kind: "run" | "fix" | "done" | "human" | "giveup" | "info"; title: string; detail?: string; nodeLabel?: string; runId?: string }
export interface PendingGraph { nodes: WorkflowNode[]; edges: WorkflowEdge[]; message: string; triggerParams?: ParamField[]; schedule?: SuggestedSchedule; autoWebhook?: boolean; onFailureWorkflow?: string }
export interface AutoTestState { running: boolean; steps: AutoStep[]; ok?: boolean; needsHuman?: boolean; needsReview?: boolean; canPromote?: boolean; validationLevel?: "simulated" | "real-readonly"; source?: "toolbar" | "chat" }
export interface PendingExecution {
  previewRunId: string;
  plannedWrites: number;
  params: Record<string, unknown>;
  graphFingerprint: string;
  replayToken?: string;
  createdAt: number;
  running?: boolean;
  /** 外部匯入的流程第一次正式執行要多一層明確信任確認，不能被一般「確認執行」順手略過。 */
  needsImportedConfirmation?: boolean;
}
export interface ChatInputField {
  key: string;
  label: string;
  type: string;
  default?: string;
  help?: string;
  options?: string[];
  required?: boolean;
}
export interface PendingChatInput {
  token: number;
  kind: "settings" | "model-settings" | "params";
  title: string;
  description: string;
  fields: ChatInputField[];
  /**
   * 有些一次性設定的下一步不是「回去自己按執行」，而是可以安全地立刻驗證。
   * 目前用在 Google 簡報官方授權：只讀取簡報與圖表連結，絕不送更新請求。
   */
  afterSave?: { kind: "verify-google-slides"; nodeIds: string[] };
}

type WorkflowSecretStatus = {
  workflow?: { requiresSecrets?: { key: string; label?: string; type?: "text" | "password" }[] };
  secretsSet?: Record<string, boolean>;
};

/**
 * 流程剛套用時就從伺服器最新版找出還缺的連接資料。不能只靠建圖模型「記得提醒」：
 * 模型很容易把 SMTP、IMAP 或通知服務漏講，使用者會在第一次測試才看到一串技術錯誤。
 * 這是純資料轉換，讓前端與測試都能固定驗證，不把欄位判斷藏在 UI 分支裡。
 */
export function missingWorkflowSecretFields(snapshot: WorkflowSecretStatus, excludeKeys: readonly string[] = []) {
  const excluded = new Set(excludeKeys);
  return (snapshot.workflow?.requiresSecrets ?? []).filter((field) =>
    !excluded.has(field.key) && !snapshot.secretsSet?.[field.key],
  );
}
export interface ChatExecutionState {
  runId: string;
  /** preview=只讀安全試跑；formal=使用者已確認的正式執行。UI 和續跑都不能混淆這個邊界。 */
  mode: "preview" | "formal";
  status: "starting" | "queued" | "running" | "waiting" | "success" | "failed" | "cancelled";
  reason?: string;
  failedNode?: string | null;
  /** needs-human 代表缺的是只有使用者手上才有的資料，不能假裝 AI 改程式就能補出來。 */
  resolution?: "ai-fixable" | "needs-human" | null;
}
export interface PendingChatApproval {
  id: string;
  runId: string;
  message: string;
}

/**
 * 只有 trigger 的新草稿還沒有任何事情可以跑。使用者說「幫我建立……，再安全測試」時，
 * `測試` 不能搶走整句，把它送進空流程預覽；應先把整段需求交給建圖，之後才由使用者或
 * 系統安全測試。這是純函式，讓前端取得最新流程後可確定性決定，不要交給模型猜語境。
 */
export function needsWorkflowConstructionBeforePreview(nodes: { type?: unknown }[] | undefined): boolean {
  return !Array.isArray(nodes) || !nodes.some((node) => typeof node?.type === "string" && node.type !== "trigger");
}

async function isBlankWorkflowForPreview(id: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/workflows/${id}`);
    if (!response.ok) return false; // 讀取暫時失敗時維持原本安全試跑語意，不偷偷改成建圖
    const data = await response.json() as { workflow?: { nodes?: { type?: unknown }[] } };
    return needsWorkflowConstructionBeforePreview(data.workflow?.nodes);
  } catch {
    return false;
  }
}

export interface WFChatState {
  chat: ChatMsg[];
  thinking: boolean;
  pendingGraph: PendingGraph | null;
  autoTest: AutoTestState | null;
  // 每當 AI 在對話裡「直接改好了現有節點」(server 端已套用)就 +1，元件監看它、變了就重新載入畫布，
  // 不用使用者按「套用」——這是把對話變成真正修東西頻道的最後一哩。
  reloadToken: number;
  // 畫布上要跳的「已更新」通知：labels=改了哪些節點，token 每次都不同(即使改同一個節點也會重新跳)
  editToast: { labels: string[]; token: number } | null;
  // 「驗證看懂(只讀)」正在跑:讀使用者的檔案、實際算給他看(不會寫回/發送)。切走畫面也不中斷。
  verifying: boolean;
  /** 對話安全試跑完成、等使用者核對後確認真正執行。沒有確認就絕不寫出。 */
  pendingExecution: PendingExecution | null;
  /** 只有人能提供的執行參數/帳密，直接在對話內收集；值只送設定 API，不會放進 chat 或送模型。 */
  pendingInput: PendingChatInput | null;
  /** 對話啟動的正式執行狀態。失敗後可在原地續跑或交給 AI 修，不必跳去紀錄頁。 */
  activeExecution: ChatExecutionState | null;
  /** 正式流程停在 wait-approval 時，直接在同一對話核准/拒絕。 */
  pendingApproval: PendingChatApproval | null;
  /** 外部匯入流程連只讀試跑都先要求信任來源，避免一句模糊的測試就開本機檔案/外部網站。 */
  pendingTrust: boolean;
}

const EMPTY: WFChatState = {
  chat: [], thinking: false, pendingGraph: null, autoTest: null, reloadToken: 0, editToast: null,
  verifying: false, pendingExecution: null, pendingInput: null, activeExecution: null, pendingApproval: null, pendingTrust: false,
};

const states = new Map<string, WFChatState>();
const listeners = new Set<() => void>();
// 每次「清除對話」就把這個 workflow 的 epoch +1；進行中的 sendChatToAI 記住送出當下的 epoch，
// 回來時若 epoch 變了(代表使用者中途清了對話)，就丟棄這次結果、不要把清掉的舊對話又寫回去。
const chatEpoch = new Map<string, number>();
const chatControllers = new Map<string, AbortController>();
const verificationControllers = new Map<string, AbortController>();
const runControllers = new Map<string, AbortController>();
const runtimeRecovering = new Set<string>();
const serverPersistTimers = new Map<string, number>();
type Continuation =
  | { kind: "preview"; history: ChatMsg[]; params: Record<string, unknown> }
  | { kind: "formal"; params: Record<string, unknown>; confirmImported?: boolean }
  | { kind: "autorun"; expected?: string; params: Record<string, unknown> }
  | { kind: "build"; history: ChatMsg[] };
const continuations = new Map<string, Continuation>();

function emit() { listeners.forEach((l) => l()); }
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }

function get(id: string): WFChatState {
  let s = states.get(id);
  if (!s) { s = loadPersisted(id) ?? EMPTY; states.set(id, s); }
  return s;
}
function set(id: string, patch: Partial<WFChatState>) {
  states.set(id, { ...get(id), ...patch });
  persist(id);
  emit();
}

/**
 * 安全輸入卡本身只含欄位名稱、說明和下一個「只讀驗證」動作，從不含使用者剛打的值。
 * 這個小型白名單讓它可以跨重整保存，同時不信任 localStorage／server state 裡任意塞進來的形狀。
 */
function restorePendingInput(raw: unknown): PendingChatInput | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<PendingChatInput>;
  if (!(["settings", "model-settings", "params"] as const).includes(candidate.kind as PendingChatInput["kind"]) ||
    typeof candidate.title !== "string" || typeof candidate.description !== "string" || !Array.isArray(candidate.fields) ||
    !candidate.fields.every((field) => field && typeof field.key === "string" && typeof field.label === "string" && typeof field.type === "string")) return null;
  const afterSave = candidate.afterSave && candidate.afterSave.kind === "verify-google-slides" &&
    Array.isArray(candidate.afterSave.nodeIds) && candidate.afterSave.nodeIds.every((nodeId) => typeof nodeId === "string")
    ? { kind: "verify-google-slides" as const, nodeIds: candidate.afterSave.nodeIds }
    : undefined;
  return {
    token: typeof candidate.token === "number" ? candidate.token : Date.now(),
    kind: candidate.kind as PendingChatInput["kind"],
    title: candidate.title,
    description: candidate.description,
    fields: candidate.fields as ChatInputField[],
    ...(afterSave ? { afterSave } : {}),
  };
}

// localStorage：只存對話與待套用結果(重整也還在)；thinking 不存(重整後那次連線已斷)
const keyOf = (id: string) => `agenthub_chat_${id}`;
function loadPersisted(id: string): WFChatState | null {
  try {
    const raw = typeof localStorage !== "undefined" && localStorage.getItem(keyOf(id));
    if (!raw) return null;
    const p = JSON.parse(raw);
    const pending = p.pendingExecution as Partial<PendingExecution> | null | undefined;
    const pendingExecution = pending && typeof pending.previewRunId === "string" && typeof pending.graphFingerprint === "string" &&
      typeof pending.createdAt === "number" && Date.now() - pending.createdAt < 30 * 60_000
      ? pending as PendingExecution
      : null;
    // 只還原「這張卡要問哪些欄位」和安全的後續動作；使用者已輸入的值從來不在 store/localStorage，
    // 重整後仍必須重新輸入。這讓新手不會因為不小心重新整理就失去唯一的設定入口，又不犧牲帳密安全。
    const pendingInput = restorePendingInput(p.pendingInput);
    return {
      chat: p.chat ?? [], thinking: false, pendingGraph: p.pendingGraph ?? null, autoTest: null,
      reloadToken: 0, editToast: null, verifying: false, pendingExecution,
      pendingInput, activeExecution: null, pendingApproval: null, pendingTrust: false,
    };
  } catch { return null; }
}
/**
 * 存 localStorage 前先把「大體積內容」剝掉：圖片 base64(一張 fullPage 截圖/PDF 頁圖動輒 1-3MB)、
 * 超長檔案內容。不剝的話，拖過幾個 Excel/PDF/網址對話後單則訊息就 5-10MB，直接撐破 localStorage 5MB 配額，
 * setItem 丟 QuotaExceededError→被 catch 靜默吞掉→從那刻起整段對話再也存不進去，重整後最新對話全遺失(踩過)。
 * 圖片只在當下 session 給 AI 看，重整後不需要保留畫素；留個文字標記讓對話脈絡讀得通即可。
 */
function stripHeavyForPersist(chat: ChatMsg[]): ChatMsg[] {
  return chat.map((m) => ({
    ...m,
    parts: (m.parts ?? []).map((p): Part => {
      if (p.kind === "image") {
        return p.assetId
          ? { ...p, b64: "" }
          : { kind: "text", text: `(圖片：${p.name ?? "圖"}；重新整理後完整圖片已不在，若要繼續修改請重新附上)` };
      }
      if (p.kind === "file" && p.content.length > 2000) {
        return { ...p, content: p.content.slice(0, 2000) + (p.assetId ? "…(送出時會由伺服器補回完整內容)" : "…(完整內容已不在，請重新附上)") };
      }
      return p;
    }),
  }));
}

function persist(id: string) {
  const s = get(id);
  const persisted = {
    chat: compactHistoryForPersistence(stripHeavyForPersist(s.chat)),
    pendingGraph: s.pendingGraph,
    pendingExecution: s.pendingExecution,
    // 只保存欄位定義，不保存 ChatInputCard 元件內的 values；帳密不會落到 localStorage 或 server chat context。
    pendingInput: s.pendingInput,
  };
  try {
    localStorage.setItem(keyOf(id), JSON.stringify(persisted));
  } catch { /* localStorage 滿了或不可用就算了 */ }
  // localStorage 是整個網站共用約 5MB，其他 workflow 的舊對話塞滿後，新流程會無聲存不進去。
  // 同一份精簡狀態同步到本機 server 檔案；debounce 且最後一次為準，重整／換頁後仍能恢復。
  if (typeof window !== "undefined") {
    const previous = serverPersistTimers.get(id);
    if (previous) window.clearTimeout(previous);
    serverPersistTimers.set(id, window.setTimeout(() => {
      serverPersistTimers.delete(id);
      void fetch(`/api/workflows/${id}/chat-context`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(persisted),
      }).catch(() => {});
    }, 250));
  }
}

/** 元件用這個 hook 訂閱某個 workflow 的 AI 狀態；store 變動就重繪，跨頁面不遺失 */
export function useWFChat(id: string): WFChatState {
  return useSyncExternalStore(subscribe, () => get(id), () => EMPTY);
}

export function clearPendingGraph(id: string) { set(id, { pendingGraph: null }); }
export function closeAutoTest(id: string) { set(id, { autoTest: null }); }

/**
 * 對話中的候選圖要成為後續修改／測試的真正基底。
 * 使用者說「套用」、直接說「測試」，或接著補修改時，先走跟畫面按鈕相同的整圖 PUT；失敗就保留候選圖。
 */
async function applyPendingGraphFromChat(id: string, history: ChatMsg[], announce: boolean): Promise<boolean> {
  const graph = get(id).pendingGraph;
  if (!graph) return false;
  const response = await fetch(`/api/workflows/${id}/build`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodes: graph.nodes,
      edges: graph.edges,
      triggerParams: graph.triggerParams,
      schedule: graph.schedule,
      autoWebhook: graph.autoWebhook,
      onFailureWorkflow: graph.onFailureWorkflow,
    }),
  }).catch(() => null);
  const data = response ? await response.json().catch(() => ({})) as {
    error?: string;
    missingSecrets?: { key: string; label?: string; type?: "text" | "password" }[];
  } : {};
  if (!response?.ok) {
    set(id, { chat: history });
    appendAssistantNote(id, `⚠️ 剛畫好的流程還沒存進草稿：${data.error ?? "無法連到伺服器"}。候選圖仍保留，可以再試一次。`);
    return false;
  }
  const nextToken = (get(id).reloadToken ?? 0) + 1;
  set(id, { chat: history, pendingGraph: null, reloadToken: nextToken });
  if (announce) appendAssistantNote(id, `✅ 已把剛才的 ${graph.nodes.length} 個步驟存進草稿畫布；這只是流程設定，尚未正式執行或寫入外部資料。`);
  announceSheetSetupIfNeeded(id, graph.nodes);
  // 先讓 Google Slides 專用卡取得優先權；若兩段非同步 fetch 同時回來，通用帳密卡可能
  // 先寫進 pendingInput，反而把「存好就驗證簡報」這條重要的專用流程遮住。
  await announceSlidesOAuthSetupIfNeeded(id, graph.nodes);
  // Google Slides 有「存好就只讀驗證」的專用授權卡；其餘連線資料(收寄信、LINE、Telegram、Slack…)
  // 則優先用套用 API 直接回傳的結果立刻給安全輸入卡。這避免「先存圖、再 GET 最新狀態」的非同步
  // 間隙讓卡片偶發消失；GET 分支只保留給舊版/外部呼叫端的相容備援。
  const slidesKeys = new Set(["googleOAuthClientId", "googleOAuthClientSecret", "googleOAuthRefreshToken"]);
  const usesSlides = graph.nodes.some((node) => node.type === "google-slides-refresh" || node.type === "google-slides-create");
  const missing = Array.isArray(data.missingSecrets)
    ? data.missingSecrets.filter((field) => !usesSlides || !slidesKeys.has(field.key))
    : null;
  if (missing?.length && !get(id).pendingInput) {
    promptForMissingSecrets(
      id,
      missing,
      `這條流程還需要連接 ${missing.map((field) => `「${field.label || field.key}」`).join("、")}。直接在下面安全欄位填入即可；不用離開這段對話找設定頁。`,
    );
  } else if (missing === null) {
    await announceWorkflowSecretsAfterApply(id, graph.nodes);
  }
  return true;
}

async function announceWorkflowSecretsAfterApply(id: string, nodes: PendingGraph["nodes"]) {
  try {
    const response = await fetch(`/api/workflows/${id}`);
    if (!response.ok) return;
    const snapshot = await response.json() as WorkflowSecretStatus;
    const slidesKeys = ["googleOAuthClientId", "googleOAuthClientSecret", "googleOAuthRefreshToken"];
    const needsSlidesSetup = nodes.some((node) => node.type === "google-slides-refresh" || node.type === "google-slides-create");
    const missing = missingWorkflowSecretFields(snapshot, needsSlidesSetup ? slidesKeys : []);
    // 另一張安全卡正在顯示時不覆蓋它；使用者存好後，安全試跑仍會精準補出下一組缺少的資料。
    if (missing.length === 0 || get(id).pendingInput) return;
    promptForMissingSecrets(
      id,
      missing,
      `這條流程還需要連接 ${missing.map((field) => `「${field.label || field.key}」`).join("、")}。直接在下面安全欄位填入即可；不用離開這段對話找設定頁。`,
    );
  } catch {
    // 套用已成功；補卡失敗不能把已套用流程誤報為失敗，第一次測試仍會走同一份缺資料偵測。
  }
}

/**
 * 套用的流程裡有「還沒設定寫入網址」的試算表寫入步驟時，主動在對話附上一鍵複製的設定腳本卡。
 * 確定性偵測(看實際節點設定)，不靠模型記得提醒；使用者不用自己想到要去節點裡找教學。
 */
export function announceSheetSetupIfNeeded(id: string, nodes: PendingGraph["nodes"]) {
  const labels = sheetWriteNodesNeedingSetup(nodes);
  if (labels.length === 0) return;
  const s = get(id);
  set(id, {
    chat: [...s.chat, {
      role: "assistant",
      isControl: true,
      parts: [
        { kind: "text", text: `這條流程的「${labels.join("」「")}」會寫入你的 Google 試算表，第一次使用要做一個 3 分鐘的設定(讓試算表授權接收資料)。照下面的卡片做就好；部署完把 Google 給的網址直接貼回這裡，我會自動填進所有寫入步驟。` },
        { kind: "sheet-script", nodeLabels: labels },
      ],
    }],
  });
}

/**
 * 這條流程執行時，某個 Google 試算表寫入步驟因為「AI 改不動的外部問題」(Apps Script 需要
 * 重新部署、版本太舊、綁定錯誤等)而失敗時，主動在對話附上同一張一鍵複製設定卡——跟「還沒
 * 設定」是同一份卡片(GOOGLE_SHEET_SCRIPT_TEMPLATE 單一真相)，差別只在觸發時機跟文案。
 * 只在 resolution==="needs-human" 時呼叫(呼叫端負責判斷)，這裡不重新判斷分類規則，
 * 避免兩處各自維護一份「這是不是外部問題」的邏輯、日後漂移不一致。
 * 只影響「這條流程」自己的對話(get/set 都是用這個 workflowId 當 key)，不會動到其他 workflow
 * 的對話或設定——即使多條流程共用同一個 scriptUrl，這裡也只在觸發失敗的那條流程底下顯示。
 */
export function announceSheetScriptFailureIfNeeded(id: string, nodeLabel: string) {
  const s = get(id);
  set(id, {
    chat: [...s.chat, {
      role: "assistant",
      isControl: true,
      parts: [
        { kind: "text", text: `「${nodeLabel}」這步剛剛執行失敗，原因是 Google 試算表那端的 Apps Script 有問題(不是這條流程的設定錯)，AI 改節點設定沒有用。多半是腳本需要重新部署一個新版本，或部署時沒有正確綁定在目標試算表上。跟著下面的卡片重新複製、貼上、部署一次(只影響這個「${nodeLabel}」用到的試算表，不會動到你其他流程)，完成後把新網址貼回來，我再幫你重跑這一步。` },
        { kind: "sheet-script", nodeLabels: [nodeLabel] },
      ],
    }],
  });
}

/**
 * Google Slides API 沒有像 Apps Script 那樣「貼上同一份範本」的一鍵設定路——OAuth 一定要使用者自己
 * 在 Google Cloud Console 走過一輪(建專案/開 API/建憑證)，帳號綁定、任何人都不能代勞。這裡能做的
 * 是把完整步驟做成對話裡可逐步展開的設定卡，讓「使用開源這份 workflow 的任何人」都能照著做完，
 * 不用另外去找教學檔案。
 *
 * 措辭鐵則(真實踩過的教訓)：使用者可能完全不知道 API/OAuth/Client ID 是什麼，只是想讓簡報自動更新
 * ——第一版寫得技術正確但每一步只丟術語(「OAuth 同意畫面設定好」「拿到 Client ID 和 Client Secret」)，
 * 對完全沒碰過 Google Cloud Console 的人等於天書。每一步都要講清楚「為什麼要點這裡」+「會看到什麼畫面」
 * +「該點哪個字」，尤其是 Google 自己會跳出來嚇人的「未經驗證應用程式」警告一定要先安撫，不然使用者
 * 會以為自己點錯、中途放棄。結尾邀請使用者卡住時直接截圖貼過來，讓真人 AI 對話接手，不強迫他一次看懂整段。
 */
// 純函式本體移到 lib/googleSlidesApi.ts(沒有 "use client")，讓 build/route.ts(伺服器端) 也能共用
// 同一份判斷——這裡重新匯出，維持既有 import 路徑不用改。
export { slidesRefreshNodesNeedingOAuthSetup };

export function slidesOAuthInputCard(nodeIds: string[] = []): PendingChatInput {
  return {
    token: Date.now(),
    kind: "settings",
    title: "最後一步：把 Google 給你的三串代碼安全貼到這裡",
    description: "這三串只會加密保存在這台電腦，不會出現在對話紀錄，也不會交給 AI。填完後，我會立刻只讀確認 Google 授權有效；不會建立、更新或刪除任何簡報。",
    fields: [
      { key: "googleOAuthClientId", label: "1. Client ID", type: "text", required: true },
      { key: "googleOAuthClientSecret", label: "2. Client Secret", type: "password", required: true },
      { key: "googleOAuthRefreshToken", label: "3. Refresh Token", type: "password", required: true },
    ],
    ...(nodeIds.length ? { afterSave: { kind: "verify-google-slides" as const, nodeIds } } : {}),
  };
}

/**
 * 套用的流程裡有「重新整理 Google 簡報圖表」節點、但 OAuth 憑證還沒填的話，主動在對話附上完整設定步驟——
 * 跟試算表寫入的一鍵複製卡是同一個目的(使用者不用自己想到要去哪裡找教學)，只是這裡沒有範本可以一鍵貼，
 * 只能給步驟。查 secretsSet 失敗(離線/伺服器重啟中)就安靜跳過，不要用猜的誤報「還沒設定」。
 */
export async function announceSlidesOAuthSetupIfNeeded(id: string, nodes: PendingGraph["nodes"]) {
  const labels = slidesRefreshNodesNeedingOAuthSetup(nodes);
  const nodeIds = nodes.filter((node) => node.type === "google-slides-refresh" || node.type === "google-slides-create").map((node) => node.id);
  if (labels.length === 0) return;
  let configured = false;
  try {
    const res = await fetch(`/api/workflows/${id}`);
    const data = await res.json() as { secretsSet?: Record<string, boolean> };
    configured = Boolean(
      data.secretsSet?.googleOAuthClientId && data.secretsSet?.googleOAuthClientSecret && data.secretsSet?.googleOAuthRefreshToken,
    );
  } catch {
    return;
  }
  if (configured) return;
  const s = get(id);
  set(id, {
    chat: [...s.chat, {
      role: "assistant",
      isControl: true,
      parts: [{
        kind: "text",
        text: `「${labels.join("」「")}」第一次要連到你的 Google 簡報。這是直接使用 Google 的官方簡報功能建立或更新內容，不是模擬點網頁。請依下面卡片逐步完成；只需要設定一次，約 10–15 分鐘。`,
      }, { kind: "slides-oauth-setup", nodeLabels: labels }],
    }],
    // 新手不該看完一大段教學後還要自己猜「要去哪裡貼」。直接在同一個對話給安全欄位；
    // 若目前正在填別的必要資料，保留原卡片，避免蓋掉使用者已輸入的內容。
    pendingInput: s.pendingInput ?? slidesOAuthInputCard(nodeIds),
  });
}

/**
 * 這條流程執行時，「重新整理 Google 簡報圖表」節點因為 OAuth 憑證還沒設定或已經失效而失敗時，
 * 主動附上同一份設定步驟——跟上面的「套用時提醒」共用同一段文字，差別只在觸發時機。
 */
export function announceSlidesOAuthFailureIfNeeded(id: string, nodeLabel: string, nodeId?: string) {
  const s = get(id);
  set(id, {
    chat: [...s.chat, {
      role: "assistant",
      isControl: true,
      parts: [{
        kind: "text",
        text: `「${nodeLabel}」卡在 Google 的一次性授權設定（不是流程步驟寫錯）。我不會叫 AI 無效重跑；照下面卡片完成授權後，直接回來按測試即可。`,
      }, { kind: "slides-oauth-setup", nodeLabels: [nodeLabel] }],
    }],
    pendingInput: s.pendingInput ?? slidesOAuthInputCard(nodeId ? [nodeId] : []),
  });
}

/**
 * 任何節點執行失敗、且被引擎分類為 resolution==="needs-human"(帳密/設定/資料內容這類 AI 改不動的
 * 情況，見 engine.ts 的 classifyFailure)時，主動在對話講清楚「缺什麼」，附上這步實際蒐集到的證據
 * (例如掃描過的頁面內容、搜尋條件)，讓使用者能直接回覆正確答案——而不是只留一句技術性錯誤跟一顆
 * 「讓 AI 修」的按鈕，使用者只會看到 AI 一直修不好、卻不知道到底該補什麼給它(真實踩過：投影片更新
 * 那步找不到目標頁面，畫面只顯示一句英文夾雜的錯誤，使用者得自己去翻執行紀錄才看得到掃描結果)。
 * Google 試算表寫入類已有專屬的一鍵複製設定卡(announceSheetScriptFailureIfNeeded)，這裡處理其餘
 * 一般情況：帳密、設定缺漏、資料/頁面內容跟預期對不上。reason 已經是 classifyFailure 依分類生成的
 * 白話說明，這裡只負責「講清楚+附證據+邀請使用者直接回答」，不重新判斷分類邏輯。
 */
export function announceNeedsHumanIfNeeded(id: string, nodeLabel: string, reason: string, evidence: string) {
  const s = get(id);
  const evidenceBlock = evidence ? `\n\n這步實際看到的內容：\n${evidence}` : "";
  set(id, {
    chat: [...s.chat, {
      role: "assistant",
      isControl: true,
      parts: [
        { kind: "text", text: `「${nodeLabel}」這步卡住了，需要你補一個只有你知道的答案，我不會用猜的硬套：\n\n${reason}${evidenceBlock}\n\n請直接回覆正確答案(或補上檔案/截圖/帳密)，我收到後會幫你重新測這一步。` },
      ],
    }],
  });
}

/**
 * 把 /build 回應裡的「試算表寫入設定卡」/「Google 簡報 OAuth 設定卡」掛到對話後面——
 * phase:"edits"(直接套用改動)和一般回答(沒改動任何節點，例如使用者只是問「給我設定卡片」)
 * 兩條路徑都會需要同一套卡片，抽成共用函式避免各自維護一份、日後漂移不一致。
 */
function appendSetupCards(baseChat: ChatMsg[], data: Record<string, unknown>): { chat: ChatMsg[]; slidesSetupNodeIds?: string[] } {
  const chat = [...baseChat];
  const sheetSetupLabels: string[] = Array.isArray(data.sheetSetupLabels) ? data.sheetSetupLabels as string[] : [];
  if (sheetSetupLabels.length) {
    chat.push({
      role: "assistant",
      isControl: true,
      parts: [
        { kind: "text", text: `這條流程的「${sheetSetupLabels.join("」「")}」會寫入你的 Google 試算表，第一次使用要做一個 3 分鐘的設定(讓試算表授權接收資料)。照下面的卡片做就好；部署完把 Google 給的網址直接貼回這裡，我會自動填進所有寫入步驟。` },
        { kind: "sheet-script", nodeLabels: sheetSetupLabels },
      ],
    });
  }
  const slidesSetupLabels: string[] = Array.isArray(data.slidesSetupLabels) ? data.slidesSetupLabels as string[] : [];
  const slidesSetupNodeIds: string[] = Array.isArray(data.slidesSetupNodeIds) ? data.slidesSetupNodeIds as string[] : [];
  if (slidesSetupLabels.length) {
    chat.push({
      role: "assistant",
      isControl: true,
      parts: [{
        kind: "text",
        text: `「${slidesSetupLabels.join("」「")}」第一次要連到你的 Google 簡報。這是直接使用 Google 的官方簡報功能建立或更新內容，不是模擬點網頁。請依下面卡片逐步完成；只需要設定一次，約 10–15 分鐘。`,
      }, { kind: "slides-oauth-setup", nodeLabels: slidesSetupLabels }],
    });
  }
  return { chat, ...(slidesSetupLabels.length ? { slidesSetupNodeIds } : {}) };
}

/**
 * 送一則訊息給 AI 建/改流程。fetch 在這裡發動(模組層)，就算使用者馬上切走畫面，
 * 這個 async 仍會跑完並把 AI 回覆寫回 store，回到該流程就看得到。
 */
export async function sendChatToAI(id: string, history: ChatMsg[]) {
  const lastUser = [...history].reverse().find((message) => message.role === "user");
  const lastText = (lastUser?.parts ?? []).filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n");
  let command = classifyChatCommand(lastText);
  // 「建立一條流程，先安全測試」是新手最自然的完整需求，不是對空白畫布下的控制命令。
  // classifyChatCommand 只能看一句話、看不到畫布，故此處讀最新 workflow 再做最終判斷。
  // 不能只靠「建立」關鍵字：既有流程裡說「建立一份報表」有可能真的是要執行，必須由圖是否
  // 已有可執行步驟來決定，才不會修了這個誤判又破壞既有流程的口語試跑。
  if (command === "preview-run" && await isBlankWorkflowForPreview(id)) command = null;
  // 使用者剛打的這則訊息若看起來像帳密——伺服器的 parseChatCredentials 要等 fetch 完成才會解析、
  // 存進本機設定，但這裡每個 set()/commit() 都會把 history 立刻存進瀏覽器 localStorage(見 persist())。
  // 沒有這段的話，明碼帳密會先一步進 localStorage，之後才被伺服器攔截消毒，等於白攔。所以先把
  // history 換成「畫面/儲存要用的版本」(最新一則使用者訊息若像帳密就整段換成安全提示)；下面送給
  // 伺服器解析的請求改用單獨留著的 rawHistoryForRequest，帳密偵測不受影響。
  const rawHistoryForRequest = history;
  if (lastUser) {
    history = history.map((m) =>
      m !== lastUser ? m : { ...m, parts: m.parts.map((p) => (p.kind === "text" ? { ...p, text: redactIfLooksLikeCredential(p.text) } : p)) },
    );
  }
  if (command === "discard-graph") {
    const hadCandidate = Boolean(get(id).pendingGraph);
    set(id, { chat: history, pendingGraph: null });
    appendAssistantNote(id, hadCandidate ? "已捨棄候選流程圖，畫布沒有被改動。" : "目前沒有等待套用的候選流程圖。可以直接重新描述你要的流程。");
    return;
  }
  const hadPendingGraph = Boolean(get(id).pendingGraph);
  if (hadPendingGraph && (command === "apply-graph" || command === "preview-run" || command === null)) {
    const applied = await applyPendingGraphFromChat(id, history, command !== null);
    if (!applied) return;
    history = get(id).chat;
    if (command === "apply-graph") return;
  } else if (command === "apply-graph") {
    set(id, { chat: history });
    appendAssistantNote(id, "目前沒有等待套用的候選流程圖；如果畫布上已經有步驟，可以直接說要修改哪一部分。");
    return;
  }
  if (command) {
    // 控制命令也是對話的一部分，先把使用者這句存下來；後續系統回覆才不會接在上一輪訊息後面。
    set(id, { chat: history, pendingGraph: null });
    if (command === "preview-run") await prepareChatPreview(id, history);
    else if (command === "confirm-run") {
      const state = get(id);
      const pending = state.pendingExecution;
      if (state.pendingTrust) await trustImportedAndContinue(id);
      else if (!pending) appendAssistantNote(id, "目前沒有一筆等你確認的安全試跑。先說「測試看看」，我會跑到寫入前並把結果列給你核對。");
      else await confirmPendingExecution(id, Boolean(pending.needsImportedConfirmation));
    } else if (command === "cancel") await stopAllChatWork(id);
    else if (command === "repair-run") await startAutoTest(id, undefined, { source: "chat" });
    else if (command === "retry-run") await retryChatExecution(id);
    else if (command === "status") await reportChatStatus(id);
    else if (command === "continue") await continueChatWork(id);
    else if (command === "last-run-summary") await reportLastRun(id);
    else if (command === "input-summary") await reportRunInputs(id);
    else if (command === "approve" || command === "reject") {
      const approval = get(id).pendingApproval;
      if (!approval) appendAssistantNote(id, "目前沒有等待你核准或拒絕的步驟。");
      else await decideChatApproval(id, command === "approve" ? "approve" : "reject");
    }
    return;
  }
  const epoch = chatEpoch.get(id) ?? 0;
  // 送新訊息就先清掉上一輪「待套用的流程圖預覽」——不然聊了三輪改需求後，畫面還掛著三輪前的舊圖，
  // 使用者一按「套用」套的是過時的圖。
  set(id, { chat: history, thinking: true, pendingGraph: null });
  // 送給模型前把「系統錯誤提示」從歷史裡濾掉——那些不是 AI 說的話，混進去模型會模仿著回「連線失敗」
  // 注意:這裡要用 rawHistoryForRequest(未被上面畫面用途遮住的原始文字)——伺服器端的
  // parseChatCredentials 要看到真正打的帳密才解析得出來，遮住的版本只給瀏覽器畫面/localStorage 用。
  const cleanHistory = compactHistoryForRequest(rawHistoryForRequest.filter((m) => !isNonModelMsg(m)));
  chatControllers.get(id)?.abort();
  const controller = new AbortController();
  chatControllers.set(id, controller);
  // 這次結果要不要寫回：只有 epoch 沒變(中途沒被清除對話)才寫。thinking 一律歸位(但也只在同 epoch 時)。
  const commit = (patch: Partial<WFChatState>) => { if ((chatEpoch.get(id) ?? 0) === epoch) set(id, patch); };
  try {
    const res = await fetch(`/api/workflows/${id}/build`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history: cleanHistory }), signal: controller.signal,
    });
    const data = await res.json();
    if (res.ok && data.phase === "preview") {
      const preview = data.preview as PreviewResponse | undefined;
      commit({
        chat: [...history, { role: "assistant", parts: [{ kind: "text", text: data.message ?? "安全試跑已完成" }] }],
        pendingExecution: preview && !(preview.missingSecrets?.length) && preview.runId && preview.graphFingerprint && (preview.plannedWrites?.length ?? 0) > 0
          ? {
              previewRunId: preview.runId,
              plannedWrites: preview.plannedWrites!.length,
              params: {},
              graphFingerprint: preview.graphFingerprint,
              replayToken: preview.replayToken ?? undefined,
              createdAt: Date.now(),
            }
          : null,
      });
    } else if (res.ok && data.phase === "ready") {
      commit({
        chat: [...history, { role: "assistant", parts: [{ kind: "text", text: `${data.message}\n\n(下方預覽新流程，確認後按「套用」)` }] }],
        pendingGraph: { nodes: data.nodes, edges: data.edges, message: data.message, triggerParams: data.triggerParams, schedule: data.schedule, autoWebhook: data.autoWebhook, onFailureWorkflow: data.onFailureWorkflow },
      });
    } else if (res.ok && data.phase === "edits") {
      // AI 直接改好了現有節點(server 端已套用)：在對話明確回報「實際改了哪些節點的什麼」，讓使用者
      // 確定是真的動了(不是只給解法)，並 bump reloadToken 讓畫布重新載入。使用者不用按任何「套用」。
      const changes = Array.isArray(data.changes) ? data.changes : [];
      const detailBlock = changes.length
        ? "\n\n✅ 已實際套用到節點：\n" + changes.map((c: { label: string; detail: string }) => `• 「${c.label}」：${c.detail}`).join("\n")
        : "";
      const labels = changes.map((c: { label: string }) => c.label);
      const nextToken = (get(id).reloadToken ?? 0) + 1;
      const newChat: ChatMsg[] = [...history, { role: "assistant", parts: [{ kind: "text", text: `${data.message}${detailBlock}` }] }];
      const { chat: chatWithCards, slidesSetupNodeIds } = appendSetupCards(newChat, data);
      commit({
        chat: chatWithCards,
        reloadToken: nextToken,
        // 畫布上跳「已更新」通知(labels 給通知顯示改了哪些節點)
        editToast: labels.length ? { labels, token: nextToken } : null,
        // 新手不該看完教學卡後還要自己猜「要去哪裡貼」——直接掛安全欄位；已經在填別的必要資料時
        // 保留原卡片，避免蓋掉使用者已輸入的內容(跟 announceSlidesOAuthSetupIfNeeded 同一套規則)。
        ...(slidesSetupNodeIds ? { pendingInput: get(id).pendingInput ?? slidesOAuthInputCard(slidesSetupNodeIds) } : {}),
      });
    } else if (res.ok) {
      // 真實踩過的案例：使用者已經填過 Google OAuth 三個欄位，之後想重新換一組(重新走一次
      // Playground)，在對話問「給我設定的卡片」/「我要重填」——這類請求走的是這條一般回答路徑
      // (不是 phase:edits，沒有改動任何節點)，之前完全沒有接上面兩張卡的邏輯，AI 只能用文字回答
      // 「下方會出現安全輸入卡」，但卡片實際上不會出現，使用者反覆問也拿不到。這裡跟 phase:edits
      // 用同一份邏輯(server 端已判斷是否符合「明確要求重看卡片」)，補上同樣的卡片與安全欄位。
      const { chat: chatWithCards, slidesSetupNodeIds } = appendSetupCards([...history, { role: "assistant", parts: [{ kind: "text", text: data.message ?? "…" }] }], data);
      commit({
        chat: chatWithCards,
        ...(slidesSetupNodeIds ? { pendingInput: get(id).pendingInput ?? slidesOAuthInputCard(slidesSetupNodeIds) } : {}),
      });
    } else if (!res.ok && data.code === "MODEL_API_NOT_CONFIGURED") {
      continuations.set(id, { kind: "build", history });
      commit({
        chat: history,
        pendingInput: {
          token: Date.now(),
          kind: "model-settings",
          title: "先連接一個 AI 模型",
          description: "API Key 會直接存進本機設定，不會放進聊天紀錄。填完後我會自動重新處理剛才的需求。",
          fields: [
            { key: "baseUrl", label: "模型服務網址", type: "text", default: "https://api.openai.com/v1", help: "你的服務商提供的 OpenAI 相容 Base URL" },
            { key: "apiKey", label: "模型 API Key", type: "password", required: true },
          ],
        },
      });
      appendAssistantNote(id, "還沒有可用的 AI 模型連線。直接在下面安全填入服務網址與 API Key；存好後會自動繼續，不用重打需求。");
    } else {
      // 後端回錯誤(4xx/5xx)：顯示給人看，但標記 isError 讓它永遠不會被送回給模型
      commit({ chat: [...history, { role: "assistant", parts: [{ kind: "text", text: data.error ?? "發生錯誤，請再試一次" }], isError: true }] });
    }
    // 伺服器偵測到這條流程缺帳密且這輪對話跟帳密有關→主動掛出安全輸入卡。
    // 值只送 /api/secrets 存本機，永遠不進 chat、不進模型歷史(跟模型 API Key 卡同一套機制)。
    const missingSecrets = (data as { missingSecrets?: { key: string; label?: string; type?: string }[] }).missingSecrets;
    if (res.ok && Array.isArray(missingSecrets) && missingSecrets.length > 0) {
      continuations.set(id, { kind: "build", history });
      commit({
        pendingInput: {
          token: Date.now(),
          kind: "settings",
          title: "填入這條流程需要的帳密",
          description: "值只會存進本機設定，不會放進聊天紀錄，也不會傳給 AI。存好後我會自動接著處理。",
          fields: missingSecrets.map((f) => ({
            key: f.key,
            label: f.label || f.key,
            type: f.type === "password" ? "password" : "text",
            required: true,
          })),
        },
      });
    }
  } catch {
    if (controller.signal.aborted) return;
    commit({ chat: [...history, { role: "assistant", parts: [{ kind: "text", text: "（連線出錯，AI 沒回覆，請再試一次）" }], isError: true }] });
  } finally {
    if (chatControllers.get(id) === controller) chatControllers.delete(id);
    if ((chatEpoch.get(id) ?? 0) === epoch) set(id, { thinking: false });
  }
}

type PreviewResponse = {
  ok?: boolean;
  runId?: string;
  failedNode?: string | null;
  error?: string | null;
  values?: { nodeLabel: string; computed: Record<string, unknown> }[];
  skippedWrites?: string[];
  plannedWrites?: { nodeLabel: string; destination: string; payload: unknown }[];
  missingSecrets?: { key: string; label: string }[];
  usedConversationSheetUrl?: boolean;
  graphFingerprint?: string;
  replayToken?: string | null;
};

/**
 * 在真正試跑前，只在「沒有預設值、也不能從附件推得」時才問參數。
 * 一般使用者不必知道 triggerParams 是什麼；對話只會顯示「這次要用的資料」。
 */
function latestUserText(history: ChatMsg[]): string {
  const latest = [...history].reverse().find((message) => message.role === "user");
  return (latest?.parts ?? [])
    .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * 使用者直接指定一段日期來試跑，但舊 workflow 根本沒有起訖參數時，不能默默拿原本日期跑、
 * 也不能叫他去節點自己設定。讓建圖 AI 把現有圖「原地參數化」並由 server 原子套用，接著自動續跑。
 */
async function ensureDateRangeInputs(id: string, range: DateRange): Promise<boolean> {
  set(id, { thinking: true });
  appendAssistantNote(id, `你指定了 ${range.start} 到 ${range.end}，但這條舊流程還沒有真正接上可選區間。我現在先把開始／結束日期接進實際運算步驟，完成後會直接用這段日期安全試跑，不會叫你去別處設定。`);
  try {
    const instruction = [
      "請修改現有流程，讓它每次執行前都能由使用者自行選擇開始日期與結束日期。",
      `使用者本次指定的區間是 ${range.start} 到 ${range.end}。`,
      "請用 phase:\"edits\"：帶完整 triggerParams，新增 rangeStart 與 rangeEnd（date-or-token），並修改所有真正決定資料區間的節點，讓它們引用這兩個參數。",
      "保留原本資料來源、計算規則、寫入位置與節點順序；不要重畫整張圖，也不要只加表單卻讓背後仍使用寫死日期。",
    ].join("\n");
    const response = await fetch(`/api/workflows/${id}/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history: [{ role: "user", parts: [{ kind: "text", text: instruction }] }] }),
    });
    const data = await response.json() as { phase?: string; message?: string; changes?: { label: string; detail: string }[]; error?: string };
    if (!response.ok || data.phase !== "edits") {
      appendAssistantNote(id, `⚠️ 我沒有把指定區間安全接進所有相關步驟，所以沒有拿原本區間冒充執行。${data.error ?? data.message ?? "這次修改沒有通過驗證"}`);
      return false;
    }
    const detail = data.changes?.map((change) => `${change.label}：${change.detail}`).join("；");
    set(id, { reloadToken: get(id).reloadToken + 1 });
    appendAssistantNote(id, `✅ 已把開始／結束日期接成執行時選項${detail ? `（${detail}）` : ""}。現在接著用你指定的區間安全試跑。`);
    return true;
  } catch (error) {
    appendAssistantNote(id, `⚠️ 準備指定區間時連線失敗：${error instanceof Error ? error.message : "未知錯誤"}。沒有拿其他日期代替。`);
    return false;
  } finally {
    set(id, { thinking: false });
  }
}

async function prepareChatPreview(
  id: string,
  history: ChatMsg[],
  suppliedParams: Record<string, unknown> = {},
  allowAutoParameterize = true,
) {
  try {
    const response = await fetch(`/api/workflows/${id}`);
    const data = await response.json() as { workflow?: { triggerParams?: ParamField[] }; error?: string };
    if (!response.ok || !data.workflow) throw new Error(data.error ?? "讀不到流程設定");
    const visible = (data.workflow.triggerParams ?? []).filter((field) => !field.derived);
    const spoken = extractChatRunParams(latestUserText(history), data.workflow.triggerParams ?? []);
    if (allowAutoParameterize && spoken.explicitRange && !schemaAcceptsDateRange(data.workflow.triggerParams ?? [])) {
      const ready = await ensureDateRangeInputs(id, spoken.explicitRange);
      if (!ready) return;
      await prepareChatPreview(id, get(id).chat, suppliedParams, false);
      return;
    }
    // 表單補填值優先於白話抽出的值；兩者都沒有才套 workflow 預設。
    const params: Record<string, unknown> = { ...spoken.params, ...suppliedParams };
    for (const field of visible) {
      if (params[field.key] === undefined && field.default !== undefined) params[field.key] = field.default;
    }
    const hasAttachedFile = historyHasReusablePreviewFile(history);
    const missing = visible.filter((field) => {
      if (String(params[field.key] ?? "").trim()) return false;
      if (field.type === "boolean") return false;
      if (hasAttachedFile && ["filePath", "attachmentPath", "savedPath", "inputFile"].includes(field.key)) return false;
      return !String(field.default ?? "").trim();
    });
    if (missing.length > 0) {
      continuations.set(id, { kind: "preview", history, params });
      set(id, {
        pendingInput: {
          token: Date.now(), kind: "params", title: "這次要用哪些資料？",
          description: "填完我就自動接著安全試跑；這些值只拿來執行，不需要懂流程設定。",
          fields: visible.map((field) => ({ ...field, required: missing.some((item) => item.key === field.key) })),
        },
      });
      appendAssistantNote(id, `還差 ${missing.map((field) => `「${field.label}」`).join("、")} 才能實際測。直接在下面填好，我會自動接著做。`);
      return;
    }
    await previewWorkflowFromChat(id, history, params);
  } catch (error) {
    appendAssistantNote(id, `⚠️ 準備安全試跑時出錯了：${error instanceof Error ? error.message : "未知錯誤"}`);
  }
}

/** 對話裡說「測試／跑一次看看」：實際跑讀取與計算，但攔住所有寫入，先把預覽交給使用者確認。 */
async function previewWorkflowFromChat(id: string, history: ChatMsg[], params: Record<string, unknown>, confirmImported = false) {
  if (get(id).verifying) return;
  verificationControllers.get(id)?.abort();
  const controller = new AbortController();
  verificationControllers.set(id, controller);
  continuations.set(id, { kind: "preview", history, params });
  set(id, {
    chat: [...history, { role: "assistant", parts: [{ kind: "text", text: "🧪 我會實際抓資料並跑到寫入前；這一輪所有寫入、通知都會被攔住，不會改你的試算表。" }] }],
    thinking: false,
    verifying: true,
    pendingExecution: null,
    pendingInput: null,
    activeExecution: null,
    pendingApproval: null,
    pendingTrust: false,
  });
  try {
    // 一律走 /build 的伺服器意圖閘門：它會 hydrateChatAttachments，把 assetId 還原成原始
    // Excel/PDF/圖片/壓縮檔，而不是只拿前端截短過的文字假裝「看過檔案」。
    const res = await fetch(`/api/workflows/${id}/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history: compactHistoryForRequest(history.filter((message) => !isNonModelMsg(message))), params, previewOnly: true, confirmImported }),
      signal: controller.signal,
    });
    const envelope = await res.json() as { phase?: string; preview?: PreviewResponse; error?: string; code?: string };
    if (res.status === 409 && envelope.code === "IMPORTED_WORKFLOW_CONFIRMATION_REQUIRED") {
      set(id, { pendingTrust: true });
      appendAssistantNote(id, "這是外部匯入的流程。即使現在只做不寫入的測試，它仍可能讀本機檔案或開啟外部網站；請先確認來源可信，再按下面的「信任來源並安全試跑」。");
      return;
    }
    const data: PreviewResponse = envelope.preview ?? { ok: false, error: envelope.error ?? "安全試跑沒有回傳結果" };
    if (!res.ok || !data.ok) {
      // 真實踩過的落差：runWorkflowPreview 會不管這次試跑成功或失敗都算出 missingSecrets
      // (見 preview.ts)，但這裡以前一律當成「壞掉了」丟一句籠統錯誤，完全沒檢查失敗會不會
      // 正好就是「第一個要登入的節點缺帳密」——使用者只看到裸錯誤，錯過了本來該出現的安全
      // 輸入卡，得自己想到要去設定頁填。缺帳密時改成跟成功路徑一樣掛出安全輸入卡，並在訊息裡
      // 講清楚是因為缺帳密才停在這步，不是流程本身壞掉。
      const missingOnFailure = data.missingSecrets ?? [];
      if (missingOnFailure.length > 0) {
        appendAssistantNote(
          id,
          `⚠️ 安全試跑停在「${data.failedNode ?? "某一步"}」，原因是還缺 ${missingOnFailure.map((item) => item.label).join("、")}——不是流程設定有問題。直接在下面安全欄位補好，我會自動接著重跑預覽。`,
        );
        set(id, {
          activeExecution: data.runId ? { runId: data.runId, mode: "preview", status: "failed", reason: data.error ?? undefined, failedNode: data.failedNode } : null,
          // 若這時已經有另一張卡在等使用者填(例如 Google Slides 專屬授權卡剛好同時要顯示)，
          // 不能悄悄蓋掉它讓使用者已經填到一半的內容消失——跟這個檔案其他地方(見
          // announceSlidesOAuthSetupIfNeeded 等)的既有保護同一套慣例：get(id).pendingInput ?? 新卡片。
          pendingInput: get(id).pendingInput ?? {
            token: Date.now(), kind: "settings", title: "補上只有你知道的資料",
            description: "內容會直接存進本機加密設定，不會出現在對話紀錄，也不會送給 AI。填完會自動繼續。",
            fields: missingOnFailure.map((item) => ({ ...item, type: /密碼|password|token|secret/i.test(`${item.key} ${item.label}`) ? "password" : "text", required: true })),
          },
        });
        return;
      }
      appendAssistantNote(id, `⚠️ 安全試跑沒有通過，停在「${data.failedNode ?? "某一步"}」：${data.error ?? "未知錯誤"}\n\n沒有執行任何寫入。`);
      set(id, { activeExecution: data.runId ? { runId: data.runId, mode: "preview", status: "failed", reason: data.error ?? undefined, failedNode: data.failedNode } : null });
      return;
    }
    const valueLines = (data.values ?? []).flatMap((item) => {
      const pairs = Object.entries(item.computed).map(([key, value]) => humanizePreviewPair(key, value));
      return pairs.length ? [`• ${item.nodeLabel}：${pairs.join("；")}`] : [];
    });
    const writeLines = formatPlannedWriteLines(data.plannedWrites ?? []);
    const missing = data.missingSecrets ?? [];
    const message = [
      "✅ 安全試跑完成。以下是實際抓到、算出的結果：",
      valueLines.length ? valueLines.join("\n") : "（沒有可顯示的短數值）",
      "\n🔒 原本準備寫入的步驟已攔住，預計送出的內容：",
      writeLines.length ? writeLines.join("\n") : "（這條流程沒有偵測到寫入步驟）",
      missing.length
        ? `\n⚠️ 正式執行前還缺：${missing.map((item) => item.label).join("、")}。直接在下方安全欄位補好，我會自動接著重跑預覽。`
        : "\n請先核對上面的數字。只有按下「確認，正式執行一次」後才會真的寫入。",
    ].join("\n");
    appendAssistantNote(id, message);
    if (missing.length > 0) {
      set(id, {
        // 同上：不能悄悄蓋掉使用者已經在填的另一張卡(code review 提醒這裡跟失敗分支是同一個
        // 既有落差，一併對齊這個檔案其他地方的既有慣例)。
        pendingInput: get(id).pendingInput ?? {
          token: Date.now(), kind: "settings", title: "補上只有你知道的資料",
          description: "內容會直接存進本機加密設定，不會出現在對話紀錄，也不會送給 AI。填完會自動繼續。",
          fields: missing.map((item) => ({ ...item, type: /密碼|password|token|secret/i.test(`${item.key} ${item.label}`) ? "password" : "text", required: true })),
        },
      });
    } else if (data.runId && data.graphFingerprint && (data.plannedWrites?.length ?? 0) > 0) {
      set(id, { pendingExecution: {
        previewRunId: data.runId,
        plannedWrites: data.plannedWrites!.length,
        params,
        graphFingerprint: data.graphFingerprint,
        replayToken: data.replayToken ?? undefined,
        createdAt: Date.now(),
      } });
      continuations.delete(id);
    } else {
      continuations.delete(id);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      appendAssistantNote(id, "已停止安全試跑，沒有執行任何寫入。");
      return;
    }
    appendAssistantNote(id, `⚠️ 安全試跑連線失敗：${error instanceof Error ? error.message : "未知錯誤"}。沒有執行任何寫入。`);
  } finally {
    if (verificationControllers.get(id) === controller) {
      verificationControllers.delete(id);
      set(id, { verifying: false });
    }
  }
}

export function stopVerification(id: string) {
  verificationControllers.get(id)?.abort(new Error("使用者已停止安全試跑"));
  // 中斷瀏覽器 fetch 不保證 Next.js 立刻收到 disconnect；同步通知 server 中止真正的 run/外部呼叫。
  void fetch(`/api/workflows/${id}/stop-build`, { method: "POST" }).catch(() => {});
}

export function cancelPendingExecution(id: string) {
  if (!get(id).pendingExecution) return;
  set(id, { pendingExecution: null });
  appendAssistantNote(id, "已取消，不會寫入任何資料。");
}

/** 使用者看過安全試跑結果後明確確認，才啟動一次正式執行。 */
export async function confirmPendingExecution(id: string, confirmImported = false) {
  const pending = get(id).pendingExecution;
  if (!pending || pending.running) return;
  set(id, { pendingExecution: { ...pending, running: true } });
  appendAssistantNote(id, "▶ 已收到確認，現在正式執行一次。這次會真的寫入；進度與結果會繼續顯示在這裡。");
  try {
    const start = await fetch(`/api/workflows/${id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        params: pending.params,
        headed: false,
        confirmImported,
        expectedGraphFingerprint: pending.graphFingerprint,
        previewReplayToken: pending.replayToken,
      }),
    });
    const started = await start.json() as {
      runId?: string; error?: string; code?: string; missing?: { key: string; label: string; type?: "text" | "password" }[];
    };
    if (start.status === 409 && started.code === "WORKFLOW_CHANGED_SINCE_PREVIEW") {
      set(id, { pendingExecution: null });
      appendAssistantNote(id, "流程在安全預覽後被修改過；我不會拿舊預覽去執行新版本。現在自動重新安全試跑，請再核對一次。");
      await prepareChatPreview(id, get(id).chat, pending.params);
      return;
    }
    if (start.status === 409 && started.code === "PREVIEW_INPUT_EXPIRED") {
      set(id, { pendingExecution: null });
      appendAssistantNote(id, "安全預覽時用的附件／網址已過期，或確認鍵被重複送出；我不會改拿別份資料執行。現在重新安全試跑，請再核對一次。");
      await prepareChatPreview(id, get(id).chat, pending.params);
      return;
    }
    if (start.status === 409 && started.code === "IMPORTED_WORKFLOW_CONFIRMATION_REQUIRED") {
      set(id, { pendingExecution: { ...pending, needsImportedConfirmation: true, running: false } });
      appendAssistantNote(id, "這是外部匯入的流程。第一次正式執行前還要確認你信任來源，因為它可能讀本機檔案或把資料送到外部。請檢查上方預覽後，按下面的「信任來源並執行」。");
      return;
    }
    if (started.code === "MISSING_REQUIRED_SETTINGS" && started.missing?.length) {
      continuations.set(id, { kind: "formal", params: pending.params, confirmImported });
      set(id, {
        pendingExecution: { ...pending, running: false },
        pendingInput: {
          token: Date.now(), kind: "settings", title: "正式執行前還差一點資料",
          description: "內容只存進本機設定，不會放進對話或送給 AI；填完會自動繼續執行。",
          // 優先用節點宣告的欄位型別,只有沒帶 type 時才退回猜文字(猜錯會讓 webhook 網址這類機密明文顯示)
          fields: started.missing.map((item) => ({ ...item, type: item.type ?? (/密碼|password|token|secret/i.test(`${item.key} ${item.label}`) ? "password" : "text"), required: true })),
        },
      });
      return;
    }
    if (!start.ok || !started.runId) throw new Error(started.error ?? "無法啟動流程");
    set(id, { pendingExecution: null, activeExecution: { runId: started.runId, mode: "formal", status: "queued" } });
    await monitorChatRun(id, started.runId);
  } catch (error) {
    appendAssistantNote(id, `⚠️ 正式執行沒有啟動：${error instanceof Error ? error.message : "未知錯誤"}`);
    set(id, { pendingExecution: pending });
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

async function monitorChatRun(id: string, runId: string) {
  runControllers.get(id)?.abort();
  const controller = new AbortController();
  runControllers.set(id, controller);
  const deadline = Date.now() + 30 * 60_000;
  try {
    while (!controller.signal.aborted && Date.now() < deadline) {
      const res = await fetch(`/api/runs/${runId}`, { signal: controller.signal });
      const data = await res.json() as {
        run?: { status?: string; reason?: string; failed_node?: string; dry_run?: number; resolution?: "ai-fixable" | "needs-human" | null };
        nodeRuns?: { node_id?: string; status?: string; output_json?: string | null; error?: string | null }[];
      };
      if (!res.ok || !data.run) throw new Error("暫時讀不到執行狀態");
      const raw = data.run.status ?? "running";
      const mode: ChatExecutionState["mode"] = data.run.dry_run ? "preview" : "formal";
      if (raw === "queued" || raw === "running") {
        set(id, { activeExecution: { runId, mode, status: raw, failedNode: data.run.failed_node, resolution: data.run.resolution } });
        await abortableDelay(1_000, controller.signal);
        continue;
      }
      if (raw === "success") {
        set(id, { activeExecution: { runId, mode, status: "success" }, pendingApproval: null });
        const output = [...(data.nodeRuns ?? [])].reverse()
          .filter((node) => node.status === "success")
          .map((node) => formatSafeRunOutput(node.output_json))
          .find((lines) => lines.length > 0) ?? [];
        const resultNote = output.length ? `\n\n這次得到的結果：\n${output.map((line) => `• ${line}`).join("\n")}` : "";
        appendAssistantNote(id, mode === "preview"
          ? `✅ 只讀安全試跑完成。這次沒有寫入或發送任何內容。${resultNote}`
          : `✅ 正式執行完成。需要寫出的內容已經真的完成。${resultNote}`);
        return;
      }
      if (raw === "waiting") {
        const approvals = await fetch(`/api/approvals`, { signal: controller.signal }).then((response) => response.json()) as {
          approvals?: { id: string; run_id: string; message: string }[];
        };
        const approval = approvals.approvals?.find((item) => item.run_id === runId);
        set(id, {
          activeExecution: { runId, mode, status: "waiting", reason: data.run.reason, resolution: data.run.resolution },
          pendingApproval: approval ? { id: approval.id, runId, message: approval.message } : null,
        });
        appendAssistantNote(id, approval
          ? "流程已跑到需要真人決定的關卡。直接在下面核准或拒絕，決定後會從原地繼續。"
          : "流程正在等待外部核准。核准完成後會從原地繼續，不會重跑前面已完成的步驟。");
        return;
      }
      const cancelled = /使用者.*停止|已停止|cancel/i.test(data.run.reason ?? "");
      set(id, {
        activeExecution: { runId, mode, status: cancelled ? "cancelled" : "failed", reason: data.run.reason, failedNode: data.run.failed_node, resolution: data.run.resolution },
      });
      // 由對話啟動的「只驗證 Google 簡報」不會經過畫布頁面的 run polling；若這裡只留一般錯誤，
      // 使用者又得自己猜要去哪裡重新開 OAuth 卡。失敗當下讀實際節點型別，只有真的是授權問題才
      // 回到同一張新手卡，權限/網址/找不到圖表等其他問題則保留原本的具體錯誤，不能混為一談。
      const failedNodeRun = (data.nodeRuns ?? []).find((node) => node.node_id === data.run?.failed_node && node.status === "failed");
      const failureText = `${data.run.reason ?? ""}\n${failedNodeRun?.error ?? ""}`;
      if (/OAuth|Google.*授權/i.test(failureText) && data.run?.failed_node) {
        try {
          const workflowData = await fetch(`/api/workflows/${id}`, { signal: controller.signal }).then((response) => response.json()) as {
            workflow?: { nodes?: { id: string; type: string; label: string }[] };
          };
          const node = workflowData.workflow?.nodes?.find((item) => item.id === data.run?.failed_node);
          if (node?.type === "google-slides-refresh" || node?.type === "google-slides-create") announceSlidesOAuthFailureIfNeeded(id, node.label, node.id);
        } catch { /* 一般失敗摘要仍會顯示，不能因為補卡失敗把錯誤吞掉 */ }
      }
      appendAssistantNote(id, cancelled
        ? mode === "preview"
          ? "已停止只讀安全試跑；這次沒有寫入或發送任何內容。"
          : "已停止正式執行。已經完成的外部寫入不會自動回滾；尚未執行的步驟不會再繼續。"
        : data.run.resolution === "needs-human"
          ? `⚠️ 停在「${data.run.failed_node ?? "某一步"}」：${data.run.reason ?? "還缺少只有你手上才有的資料"}\n\n這不是改流程能猜出來的問題。我已經指出需要補的資料；補好後直接再試，不會叫 AI 白跑。`
        : mode === "preview"
          ? `⚠️ 只讀安全試跑停在「${data.run.failed_node ?? "某一步"}」：${data.run.reason ?? "未知錯誤"}\n\n沒有執行任何寫入。可以讓 AI 修流程，或以只讀模式從失敗處再試。`
          : `⚠️ 正式執行停在「${data.run.failed_node ?? "某一步"}」：${data.run.reason ?? "未知錯誤"}\n\n可以直接按下面「讓 AI 修到會跑」，或說「再試一次」從失敗處續跑；不用自己去翻紀錄找原因。`);
      return;
    }
    if (!controller.signal.aborted) {
      appendAssistantNote(id, "⚠️ 這次執行超過 30 分鐘仍沒有收斂，已停止畫面輪詢。流程本身若仍在跑，可說「停止」立即中止。");
    }
  } catch (error) {
    if (!controller.signal.aborted) appendAssistantNote(id, `⚠️ 追蹤執行狀態時暫時斷線：${error instanceof Error ? error.message : "未知錯誤"}。可以說「現在跑到哪」重新查。`);
  } finally {
    if (runControllers.get(id) === controller) runControllers.delete(id);
  }
}

/** 執行/測試被「缺帳密」擋下時，直接在對話掛出安全輸入卡(值只進本機設定,不進 chat、不給模型)。
 * 這取代了以前只彈一個 alert 的體驗——使用者要的是「偵測到缺帳密就給我框格填」，不是一句錯誤訊息。 */
export function promptForMissingSecrets(id: string, missing: { key: string; label?: string; type?: "text" | "password" }[], note?: string) {
  if (missing.length === 0) return;
  appendAssistantNote(id, note ?? `執行前發現這條流程還缺 ${missing.length} 個帳密欄位——直接在下面的安全輸入卡填好(值只存進本機設定，不會進對話、也不會傳給 AI)，存好後再按一次執行就可以了。`);
  set(id, {
    pendingInput: {
      token: Date.now(),
      kind: "settings",
      title: "填入這條流程需要的帳密",
      description: "值只會存進本機設定，不會放進聊天紀錄，也不會傳給 AI。",
      // 優先用節點自己宣告的欄位型別；只有舊呼叫端沒帶 type 時才退回猜 key 名稱(例如 Slack webhook
      // 網址這種敏感值,key 名稱完全不含 pass/token/secret,猜錯就會讓機密明文顯示在畫面上)。
      fields: missing.map((f) => ({
        key: f.key,
        label: f.label || f.key,
        type: f.type ?? (/pass|pwd|token|secret|otp/i.test(f.key) ? "password" : "text"),
        required: true,
      })),
    },
  });
}

/** 對話內安全表單提交。任何值都不會 append 到 chat，也不會進建圖模型歷史。 */
export async function submitChatInputs(id: string, values: Record<string, string>) {
  const pending = get(id).pendingInput;
  if (!pending) return;
  const missing = pending.fields.filter((field) => field.required && !String(values[field.key] ?? "").trim());
  if (missing.length) {
    appendAssistantNote(id, `還要填：${missing.map((field) => field.label).join("、")}。`);
    return;
  }
  const continuation = continuations.get(id);
  const afterSave = pending.afterSave;
  if (pending.kind === "settings") {
    const res = await fetch(`/api/secrets`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secrets: values }),
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) { appendAssistantNote(id, `⚠️ 設定沒有存成功：${data.error ?? "未知錯誤"}`); return; }
    set(id, { pendingInput: null });
    // 有後續工作才說「自動接著做」；沒有(例如執行前補帳密)就老實講下一步是使用者再按執行
    appendAssistantNote(id, afterSave?.kind === "verify-google-slides"
      ? "✅ 已安全保存，內容沒有放進對話，也沒有傳給 AI。現在只讀驗證 Google 簡報連線，不會更新投影片。"
      : continuation
        ? "✅ 已安全保存，內容沒有放進對話，也沒有傳給 AI。現在自動接著做。"
        : "✅ 已安全保存，內容沒有放進對話，也沒有傳給 AI。現在可以再按一次「執行」或「從這一步開始測」。");
  } else if (pending.kind === "model-settings") {
    const payload: { baseUrl?: string; apiKey?: string } = {};
    if (values.baseUrl?.trim()) payload.baseUrl = values.baseUrl.trim();
    if (values.apiKey?.trim()) payload.apiKey = values.apiKey.trim();
    const res = await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) { appendAssistantNote(id, `⚠️ 模型設定沒有存成功：${data.error ?? "未知錯誤"}`); return; }
    set(id, { pendingInput: null });
    appendAssistantNote(id, "✅ 模型連線資料已安全保存，現在自動重新處理剛才的需求。");
  } else {
    set(id, { pendingInput: null });
    appendAssistantNote(id, "✅ 收到這次要用的資料，現在自動接著做。");
  }
  // Google Slides 是一個獨立的「存好就立刻只讀驗證」流程。即使這條 workflow 剛好還留著
  // 其他對話的 continuation，也絕不能優先重送舊需求而跳過驗證，否則使用者會以為授權設好了、
  // 卻沒有任何證據知道網址/權限/圖表是否真的正確。
  if (afterSave?.kind === "verify-google-slides") await verifyGoogleSlidesSetup(id, afterSave.nodeIds);
  else if (continuation) await resumeContinuation(id, continuation, pending.kind, values);
}

/**
 * Google Slides 的第一次授權填好後，直接只讀驗證「這一格」而不是叫新手回畫布猜要按哪個鍵。
 * onlyNodeIds 讓無關的登入/寫入步驟不會把驗證結果攪在一起；dryRun 保證不會送 batchUpdate。
 */
async function verifyGoogleSlidesSetup(id: string, nodeIds: string[]) {
  if (nodeIds.length === 0) {
    appendAssistantNote(id, "已保存授權資料。請回到流程後按一次「測到會跑」；這條流程裡找不到可單獨驗證的 Google 簡報步驟。");
    return;
  }
  try {
    const response = await fetch(`/api/workflows/${id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onlyNodeIds: nodeIds, dryRun: true }),
    });
    const data = await response.json() as { runId?: string; error?: string; code?: string; missing?: { key: string; label: string; type?: "text" | "password" }[] };
    if (!response.ok || !data.runId) {
      if (data.code === "MISSING_REQUIRED_SETTINGS" && data.missing?.length) {
        promptForMissingSecrets(id, data.missing, "還差一些必要資料才能驗證 Google 簡報，直接在下面補好後再試。");
      } else {
        appendAssistantNote(id, `⚠️ 還沒能開始驗證 Google 簡報：${data.error ?? "未知錯誤"}。沒有更新任何投影片。`);
      }
      return;
    }
    set(id, { activeExecution: { runId: data.runId, mode: "preview", status: "starting" } });
    await monitorChatRun(id, data.runId);
  } catch (error) {
    appendAssistantNote(id, `⚠️ 無法開始驗證 Google 簡報：${error instanceof Error ? error.message : "未知錯誤"}。沒有更新任何投影片。`);
  }
}

async function resumeContinuation(id: string, continuation: Continuation, inputKind: PendingChatInput["kind"], values: Record<string, string>) {
  if (continuation.kind === "preview") {
    const params = inputKind === "params" ? { ...continuation.params, ...values } : continuation.params;
    await prepareChatPreview(id, continuation.history, params);
  } else if (continuation.kind === "formal") {
    await confirmPendingExecution(id, continuation.confirmImported);
  } else if (continuation.kind === "autorun") {
    await startAutoTest(id, continuation.expected, { source: "chat", params: inputKind === "params" ? { ...continuation.params, ...values } : continuation.params });
  } else {
    await sendChatToAI(id, continuation.history);
  }
}

/** 使用者可能去設定頁填完後只回一句「已經有了／繼續」；重新檢查，不要求他再貼一次敏感值。 */
export async function continueChatWork(id: string) {
  const state = get(id);
  const continuation = continuations.get(id);
  // 跟 submitChatInputs 同一個優先順序：使用者說「已經有了／繼續」時，Slides 授權要直接進行
  // 不改投影片的確認，不能被較早的對話 continuation 搶走。
  if (state.pendingInput?.kind === "settings" && state.pendingInput.afterSave?.kind === "verify-google-slides") {
    try {
      const data = await fetch(`/api/secrets`).then((response) => response.json()) as { set?: Record<string, boolean> };
      const missing = state.pendingInput.fields.filter((field) => field.required && !data.set?.[field.key]);
      if (missing.length) {
        appendAssistantNote(id, `我重新檢查過了，目前還沒讀到：${missing.map((field) => field.label).join("、")}。直接填下面的安全欄位即可。`);
        return;
      }
      const nodeIds = state.pendingInput.afterSave.nodeIds;
      set(id, { pendingInput: null });
      appendAssistantNote(id, "✅ 已確認授權資料存在，現在只讀驗證 Google 簡報連線，不會更新投影片。");
      await verifyGoogleSlidesSetup(id, nodeIds);
      return;
    } catch {
      appendAssistantNote(id, "⚠️ 暫時讀不到授權設定，請再按一次「儲存並安全驗證」。");
      return;
    }
  }
  if (state.pendingInput?.kind === "settings" && continuation) {
    try {
      const data = await fetch(`/api/secrets`).then((response) => response.json()) as { set?: Record<string, boolean> };
      const missing = state.pendingInput.fields.filter((field) => field.required && !data.set?.[field.key]);
      if (missing.length) {
        appendAssistantNote(id, `我重新檢查過了，目前還沒讀到：${missing.map((field) => field.label).join("、")}。可以直接填下面的安全欄位，不用貼進聊天。`);
        return;
      }
      set(id, { pendingInput: null });
      appendAssistantNote(id, "✅ 已確認設定存在，現在接著做。");
      await resumeContinuation(id, continuation, "settings", {});
      return;
    } catch {
      appendAssistantNote(id, "⚠️ 暫時讀不到設定狀態，請再按一次「儲存並自動繼續」。");
      return;
    }
  }
  if (state.pendingInput?.kind === "model-settings" && continuation?.kind === "build") {
    set(id, { pendingInput: null });
    appendAssistantNote(id, "我現在重新檢查模型連線並接著處理剛才的需求；如果仍缺設定，安全輸入卡會再出現。");
    await sendChatToAI(id, continuation.history);
    return;
  }
  if (state.pendingInput?.kind === "params") {
    appendAssistantNote(id, "還需要這次執行的資料；請把下面標 * 的欄位填好，才不會拿猜的內容去跑。");
    return;
  }
  if (state.pendingTrust) {
    appendAssistantNote(id, "目前停在外部流程的來源確認。請按「信任來源並安全試跑」；模糊的「繼續」不會被當成安全授權。");
    return;
  }
  if (state.pendingExecution) {
    appendAssistantNote(id, "安全試跑已完成，正等你核對。若數字正確，請說「確認正式執行」或按下面的確認鍵；我不會把模糊的「繼續」當成寫入授權。");
    return;
  }
  if (state.activeExecution?.status === "failed") { await retryChatExecution(id); return; }
  await reportChatStatus(id);
}

export async function trustImportedAndContinue(id: string) {
  const continuation = continuations.get(id);
  if (!get(id).pendingTrust || continuation?.kind !== "preview") return;
  set(id, { pendingTrust: false });
  appendAssistantNote(id, "已收到信任確認。現在只做安全試跑，所有寫入與通知仍然會被攔住。");
  await previewWorkflowFromChat(id, continuation.history, continuation.params, true);
}

export function cancelPendingTrust(id: string) {
  continuations.delete(id);
  set(id, { pendingTrust: false });
  appendAssistantNote(id, "已取消；沒有開啟這個外部流程，也沒有執行或寫入任何資料。");
}

export function cancelChatInput(id: string) {
  continuations.delete(id);
  set(id, { pendingInput: null });
  appendAssistantNote(id, "已取消，沒有儲存或執行任何東西。");
}

export async function stopAllChatWork(id: string) {
  const state = get(id);
  chatEpoch.set(id, (chatEpoch.get(id) ?? 0) + 1);
  chatControllers.get(id)?.abort();
  verificationControllers.get(id)?.abort();
  runControllers.get(id)?.abort();
  let runId = state.activeExecution?.runId;
  // 重整頁面後模組狀態可能剛初始化；仍要從伺服器找出真正正在跑的 run，不能回一句「已停止」卻沒停到它。
  if (!runId) {
    try {
      const data = await fetch(`/api/workflows/${id}/runs`).then((response) => response.json()) as { runs?: { id: string; status: string }[] };
      runId = data.runs?.find((run) => ["queued", "running", "waiting"].includes(run.status))?.id;
    } catch { /* 其餘建圖／修復停止仍照常送 */ }
  }
  await Promise.allSettled([
    fetch(`/api/workflows/${id}/stop-build`, { method: "POST" }),
    fetch(`/api/workflows/${id}/stop-loop`, { method: "POST" }),
    ...(runId ? [fetch(`/api/runs/${runId}/cancel`, { method: "POST" })] : []),
  ]);
  continuations.delete(id);
  set(id, {
    thinking: false, verifying: false, pendingExecution: null, pendingInput: null, pendingApproval: null,
    pendingTrust: false,
    activeExecution: runId ? { runId, mode: state.activeExecution?.mode ?? "formal", status: "cancelled", reason: "使用者從對話要求停止" } : null,
    autoTest: state.autoTest?.running
      ? { ...state.autoTest, running: false, ok: false, steps: [...state.autoTest.steps, { kind: "giveup", title: "已停止", detail: "使用者從對話要求停止。" }] }
      : state.autoTest,
  });
  appendAssistantNote(id, "⏹ 已送出停止：建圖、試跑、修復迴圈和目前正式執行都會中止。尚未開始的寫入不會再做。");
}

export async function reportChatStatus(id: string) {
  const state = get(id);
  if (state.thinking) { appendAssistantNote(id, "目前正在理解需求／建圖，還沒有卡住；可以隨時說「停止」。"); return; }
  if (state.verifying) { appendAssistantNote(id, "目前正在安全試跑：讀取與計算會真的做，所有寫入都被攔住。可以隨時說「停止」。"); return; }
  if (state.autoTest?.running) { appendAssistantNote(id, "目前正在自動測試與修復。它會反覆跑、看錯誤、修改再驗證，最多 15 分鐘；可以隨時說「停止」。"); return; }
  if (state.pendingInput) { appendAssistantNote(id, `目前停在「${state.pendingInput.title}」，等你填下面的欄位；填完會自動繼續。`); return; }
  if (state.pendingTrust) { appendAssistantNote(id, "目前等待你確認是否信任外部匯入流程；尚未開始讀檔或連線。"); return; }
  if (state.pendingExecution) { appendAssistantNote(id, "安全試跑已完成，現在等你核對結果。沒有按確認前不會真的寫入。"); return; }
  if (state.activeExecution) {
    const labels: Record<ChatExecutionState["status"], string> = { starting: "準備啟動", queued: "排隊中", running: "執行中", waiting: "等待真人核准", success: "已完成", failed: "已失敗", cancelled: "已停止" };
    appendAssistantNote(id, `目前狀態：${labels[state.activeExecution.status]}。執行編號 ${state.activeExecution.runId}${state.activeExecution.reason ? `；${state.activeExecution.reason}` : ""}`);
    return;
  }
  try {
    const data = await fetch(`/api/workflows/${id}/runs`).then((response) => response.json()) as { runs?: { id: string; status: string; reason?: string }[] };
    const latest = data.runs?.[0];
    appendAssistantNote(id, latest ? `目前沒有工作在跑。最近一次是「${latest.status}」${latest.reason ? `：${latest.reason}` : ""}（${latest.id}）。` : "目前沒有工作在跑，也還沒有執行紀錄。");
  } catch {
    appendAssistantNote(id, "目前沒有對話工作在跑；暫時讀不到最近執行紀錄。");
  }
}

/** 「剛剛做了什麼／哪一步失敗」只讀真實 run，不讓模型憑聊天內容猜。 */
export async function reportLastRun(id: string) {
  try {
    const state = get(id);
    const runsData = await fetch(`/api/workflows/${id}/runs`).then((response) => response.json()) as {
      runs?: { id: string; status: string }[];
    };
    const runId = state.activeExecution?.runId ?? runsData.runs?.[0]?.id;
    if (!runId) { appendAssistantNote(id, "這條流程還沒有執行紀錄。可以先說「安全測試看看」。"); return; }
    const [runData, workflowData] = await Promise.all([
      fetch(`/api/runs/${runId}`).then((response) => response.json()) as Promise<{
        run?: { status?: string; reason?: string; error?: string; failed_node?: string; started_at?: string; finished_at?: string };
        triggerParams?: Record<string, unknown>;
        nodeRuns?: { node_id: string; status: string; error?: string | null }[];
      }>,
      fetch(`/api/workflows/${id}`).then((response) => response.json()) as Promise<{ workflow?: { nodes?: { id: string; label: string }[]; triggerParams?: ParamField[] } }>,
    ]);
    if (!runData.run) { appendAssistantNote(id, "讀不到最近一次執行的詳細紀錄。"); return; }
    const labels = new Map((workflowData.workflow?.nodes ?? []).map((node) => [node.id, node.label] as const));
    const nodeRuns = runData.nodeRuns ?? [];
    const done = nodeRuns.filter((node) => node.status === "success").length;
    const skipped = nodeRuns.filter((node) => node.status === "skipped").length;
    const failed = nodeRuns.find((node) => node.status === "failed") ?? null;
    const statusText: Record<string, string> = {
      queued: "排隊中", running: "執行中", waiting: "等待真人核准", success: "成功", failed: "失敗", cancelled: "已停止",
    };
    const failedLabel = runData.run.failed_node ? labels.get(runData.run.failed_node) ?? runData.run.failed_node : failed ? labels.get(failed.node_id) ?? failed.node_id : null;
    const paramLabels = new Map((workflowData.workflow?.triggerParams ?? []).map((field) => [field.key, field.label] as const));
    const usedParams = Object.entries(runData.triggerParams ?? {});
    const paramsLine = usedParams.length
      ? `\n這次使用：${usedParams.map(([key, value]) => `${paramLabels.get(key) ?? key}＝${String(value)}`).join("；")}`
      : "";
    const detail = failedLabel
      ? `\n失敗步驟：「${failedLabel}」\n原因：${(failed?.error ?? runData.run.reason ?? runData.run.error ?? "未知錯誤").slice(0, 500)}\n可以直接說「幫我修到會跑」，我會用這份失敗現場修整條流程。`
      : `\n${runData.run.reason ?? "沒有額外錯誤訊息。"}`;
    appendAssistantNote(id, `最近一次執行（${runId}）是「${statusText[runData.run.status ?? ""] ?? runData.run.status ?? "未知"}」。${paramsLine}\n完成 ${done} 個步驟${skipped ? `，略過 ${skipped} 個` : ""}。${detail}`);
  } catch {
    appendAssistantNote(id, "⚠️ 暫時讀不到最近一次執行紀錄，請稍後再問一次。");
  }
}

/** 「執行時能選什麼」直接讀真實 schema 回答，不花模型時間、也不讓模型看著舊對話猜。 */
export async function reportRunInputs(id: string) {
  try {
    const data = await fetch(`/api/workflows/${id}`).then((response) => response.json()) as { workflow?: { triggerParams?: ParamField[] } };
    const visible = (data.workflow?.triggerParams ?? []).filter((field) => !field.derived);
    if (!visible.length) {
      appendAssistantNote(id, "目前這條流程執行時不會詢問任何可選條件；會直接照流程裡現有規則跑。如果你希望自己選日期區間，直接說「每次執行讓我選開始和結束日期」，我會把介面與背後資料流一起接好。");
      return;
    }
    const lines = visible.map((field) => {
      const choices = field.options?.length ? `（可選：${field.options.map((option) => option.includes("=") ? option.slice(option.indexOf("=") + 1) : option).join("、")}）` : "";
      const fallback = field.default ? `；沒另外選時使用原本預設` : "";
      return `• ${field.label}${choices}${fallback}`;
    });
    appendAssistantNote(id, `目前每次執行前可以直接選／填：\n${lines.join("\n")}\n\n你也可以在對話直接指定，例如「測 2026/7/1 到 7/7」；我會把值帶進這一次試跑，不用再去別處設定。`);
  } catch {
    appendAssistantNote(id, "⚠️ 暫時讀不到這條流程的執行選項；沒有憑空猜答案，請再問一次。");
  }
}

/** 頁面重整／重新開啟後，接回伺服器上仍在跑或等待簽核的工作。 */
export async function recoverChatRuntime(id: string) {
  if (runtimeRecovering.has(id) || get(id).activeExecution) return;
  runtimeRecovering.add(id);
  try {
    // 瀏覽器儲存滿了／被清掉時，先從本機 server 恢復 workflow 專屬對話，再查執行狀態。
    if (get(id).chat.length === 0) {
      const saved = await fetch(`/api/workflows/${id}/chat-context`).then((response) => response.json()) as {
        state?: { chat?: ChatMsg[]; pendingGraph?: PendingGraph | null; pendingExecution?: PendingExecution | null; pendingInput?: unknown } | null;
      };
      if (get(id).chat.length === 0 && Array.isArray(saved.state?.chat) && saved.state.chat.length > 0) {
        set(id, {
          chat: saved.state.chat,
          pendingGraph: saved.state.pendingGraph ?? null,
          pendingExecution: saved.state.pendingExecution ?? null,
          pendingInput: restorePendingInput(saved.state.pendingInput),
        });
      }
    }
    const data = await fetch(`/api/workflows/${id}/runs`).then((response) => response.json()) as {
      runs?: { id: string; status: string; dry_run?: number }[];
    };
    const active = data.runs?.find((run) => ["queued", "running", "waiting"].includes(run.status));
    if (!active) return;
    set(id, { activeExecution: { runId: active.id, mode: active.dry_run ? "preview" : "formal", status: active.status as ChatExecutionState["status"] } });
    await monitorChatRun(id, active.id);
  } catch { /* 畫面仍可用；使用者說「現在跑到哪」會再查一次 */ }
  finally { runtimeRecovering.delete(id); }
}

export async function retryChatExecution(id: string) {
  const current = get(id).activeExecution;
  let runId = current?.status === "failed" ? current.runId : undefined;
  let mode: ChatExecutionState["mode"] | undefined = current?.status === "failed" ? current.mode : undefined;
  if (!runId) {
    const data = await fetch(`/api/workflows/${id}/runs`).then((response) => response.json()) as { runs?: { id: string; status: string; dry_run?: number }[] };
    const failed = data.runs?.find((run) => run.status === "failed");
    runId = failed?.id;
    mode = failed?.dry_run ? "preview" : "formal";
  }
  if (!runId) { appendAssistantNote(id, "找不到可以續跑的失敗紀錄。先說「測試看看」，我會從安全試跑開始。"); return; }
  const response = await fetch(`/api/runs/${runId}/resume`, { method: "POST" });
  const data = await response.json() as { error?: string };
  if (!response.ok) { appendAssistantNote(id, `⚠️ 無法從失敗處續跑：${data.error ?? "未知錯誤"}`); return; }
  set(id, { activeExecution: { runId, mode: mode ?? "formal", status: "queued" }, pendingApproval: null });
  appendAssistantNote(id, mode === "preview"
    ? "▶ 已以只讀安全模式從失敗的那一步續跑；寫入與發送仍會全部被攔住。"
    : "▶ 已從失敗的那一步續跑；前面成功的步驟會沿用，不會無條件全部重做。");
  await monitorChatRun(id, runId);
}

export async function decideChatApproval(id: string, action: "approve" | "reject", note = "") {
  const approval = get(id).pendingApproval;
  if (!approval) return;
  const response = await fetch(`/api/approvals/${approval.id}/decide`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, note }),
  });
  const data = await response.json() as { error?: string };
  if (!response.ok) { appendAssistantNote(id, `⚠️ 簽核沒有成功：${data.error ?? "未知錯誤"}`); return; }
  set(id, { pendingApproval: null, activeExecution: { runId: approval.runId, mode: "formal", status: "queued" } });
  appendAssistantNote(id, action === "approve" ? "✅ 已核准，流程正從原地繼續。" : "❌ 已拒絕，流程會走拒絕分支，不會假裝成功。");
  await monitorChatRun(id, approval.runId);
}

/** Stop an interactive build immediately, including retries and Claude CLI fallback. */
export function stopChatToAI(id: string) {
  chatEpoch.set(id, (chatEpoch.get(id) ?? 0) + 1);
  // abort 瀏覽器 fetch 不保證 Next.js 伺服器立刻收到 disconnect；明確通知 server 才能殺掉
  // 正在跑的 Claude Code 子程序與外層重試鏈，避免「畫面停了、後端仍跑十幾分鐘」。
  void fetch(`/api/workflows/${id}/stop-build`, { method: "POST" }).catch(() => {});
  chatControllers.get(id)?.abort();
  chatControllers.delete(id);
  const s = get(id);
  set(id, {
    thinking: false,
    chat: [...s.chat, { role: "assistant", parts: [{ kind: "text", text: "已停止這次建圖。你可以修改需求後再送出。" }], isControl: true }],
  });
}

/** 在對話區補一則系統提示(如「已套用到畫布」)。標成 isError 只在真的是錯誤時；一般提示 isError 省略。
 * 這種提示不會被送回給模型(isSystemErrorMsg 只濾錯誤那幾句，這裡用非錯誤提示，仍會進歷史但無害；
 * 若要確保不進模型可自行加進 ERROR_TEXT_PATTERNS，這裡刻意讓「已套用」留在歷史當上下文)。 */
export function appendAssistantNote(id: string, text: string) {
  const s = get(id);
  set(id, { chat: [...s.chat, { role: "assistant", parts: [{ kind: "text", text }], isError: text.startsWith("⚠️"), isControl: true }] });
}

/** 「驗證看懂(只讀)」——使用者給一份現在的資料檔，叫 AI 實際讀+算給他看，證明有沒有看懂。
 * 只讀模式跑這條流程(寫回試算表/發通知的步驟一律略過)，把各步驟算出來的值貼回對話讓使用者對。 */
export async function verifyUnderstanding(id: string, filename: string, dataBase64: string) {
  if (get(id).verifying) return;
  verificationControllers.get(id)?.abort();
  const controller = new AbortController();
  verificationControllers.set(id, controller);
  set(id, { verifying: true });
  appendAssistantNote(id, `🔍 好，我用你給的「${filename}」實際讀一遍、算給你看——只會讀檔跟計算，不會寫回任何試算表、也不發任何通知。稍等一下…`);
  try {
    const res = await fetch(`/api/workflows/${id}/verify`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, dataBase64 }),
      signal: controller.signal,
    });
    const d = await res.json();
    if (!res.ok) { appendAssistantNote(id, `⚠️ 驗證時出錯了：${d.error ?? "未知錯誤"}`); return; }
    appendAssistantNote(id, formatVerifyResult(d));
  } catch {
    if (controller.signal.aborted) { appendAssistantNote(id, "已停止驗證，沒有寫入或發送任何資料。"); return; }
    appendAssistantNote(id, "⚠️ 驗證過程連線出錯了，請再試一次。");
  } finally {
    if (verificationControllers.get(id) === controller) {
      verificationControllers.delete(id);
      set(id, { verifying: false });
    }
  }
}

function formatVerifyResult(d: {
  ok?: boolean; status?: string; failedNode?: string | null; error?: string | null;
  values?: { nodeLabel: string; computed: Record<string, unknown> }[]; skippedWrites?: string[];
}): string {
  const skip = (d.skippedWrites ?? []).length
    ? `\n\n🔒 只讀驗證：已略過「${(d.skippedWrites ?? []).join("、")}」——不會真的寫回試算表/發通知。`
    : "";
  if (!d.ok) {
    return `我實際讀+算到一半卡在「${d.failedNode ?? "某一步"}」：${(d.error ?? "").slice(0, 200)}。\n` +
      `可能是這步的設定要調、或這份檔案跟流程預期的結構不一樣。你可以點那個節點用白話補充，我再修。${skip}`;
  }
  const lines = (d.values ?? []).map((v) => {
    const pairs = Object.entries(v.computed).map(([k, val]) => humanizePreviewPair(k, val)).join("、");
    return `• ${v.nodeLabel}：${pairs || "(這步沒有可對照的數值)"}`;
  });
  const body = lines.length ? lines.join("\n") : "(這條流程沒有抽出可對照的數值，可能是它主要在做搬移/通知)";
  return `我用你給的檔案實際跑到「寫回」之前，各步驟算出來是：\n${body}${skip}\n\n` +
    `這些跟你手上已知的正確答案對得上嗎？對不上的話，直接告訴我正確答案，我就去把它修到對。`;
}

/** 清除這個 workflow 的整段對話(對話被錯誤訊息污染、或想換個講法重來時用)。
 * bump epoch 讓正在飛的 sendChatToAI 回來時不會把清掉的對話又寫回去。 */
export function clearChat(id: string) {
  chatEpoch.set(id, (chatEpoch.get(id) ?? 0) + 1);
  chatControllers.get(id)?.abort();
  chatControllers.delete(id);
  verificationControllers.get(id)?.abort();
  verificationControllers.delete(id);
  runControllers.get(id)?.abort();
  runControllers.delete(id);
  continuations.delete(id);
  const persistTimer = serverPersistTimers.get(id);
  if (persistTimer) window.clearTimeout(persistTimer);
  serverPersistTimers.delete(id);
  void fetch(`/api/workflows/${id}/stop-build`, { method: "POST" }).catch(() => {});
  states.set(id, {
    ...get(id), chat: [], pendingGraph: null, thinking: false, verifying: false, pendingExecution: null,
    pendingInput: null, activeExecution: null, pendingApproval: null, pendingTrust: false,
  });
  try { localStorage.removeItem(keyOf(id)); } catch { /* 無痕/禁用儲存時忽略 */ }
  emit();
  // 對話已清掉，完整附件也不再有任何合法引用；立即刪除，不留到 7 天 TTL。
  void fetch(`/api/workflows/${id}/chat-context`, { method: "DELETE" }).catch(() => {});
}

/** 刪除 workflow 成功後清掉這個分頁記憶體與 localStorage；server 端由 deleteWorkflow 清附件。 */
export function discardWorkflowChat(id: string) {
  chatEpoch.set(id, (chatEpoch.get(id) ?? 0) + 1);
  chatControllers.get(id)?.abort();
  chatControllers.delete(id);
  verificationControllers.get(id)?.abort();
  verificationControllers.delete(id);
  runControllers.get(id)?.abort();
  runControllers.delete(id);
  continuations.delete(id);
  const persistTimer = serverPersistTimers.get(id);
  if (persistTimer) window.clearTimeout(persistTimer);
  serverPersistTimers.delete(id);
  void fetch(`/api/workflows/${id}/stop-build`, { method: "POST" }).catch(() => {});
  states.delete(id);
  try { localStorage.removeItem(keyOf(id)); } catch { /* 無痕/禁用儲存時忽略 */ }
  emit();
}

/** 草稿「幫我測到會跑」的全自動迴圈。同樣在模組層跑，切走畫面也不中斷，回來還看得到進度/結果。
 * expected(選填)= 使用者已知的正確答案；有給的話跑綠後會拿去對，對不上就繼續修到對(見 autorun 的 answerVerified)。 */
export async function startAutoTest(
  id: string,
  expected?: string,
  options: { source?: "toolbar" | "chat"; params?: Record<string, unknown> } = {},
) {
  if (get(id).autoTest?.running) return;
  const source = options.source ?? "toolbar";
  const params = options.params ?? {};
  set(id, { autoTest: { running: true, steps: [], source }, pendingInput: null });
  if (source === "chat") {
    appendAssistantNote(id, "🛠 我會先用只讀模式實際跑，失敗就讀現場、修整張流程再重跑；外部寫入全部攔住。最多 15 分鐘，可隨時說「停止」。");
  }
  try {
    // autorun 伺服器端一律強制安全排練(dryRun 永遠 true，不管這裡傳什麼)——這裡仍傳 true 只是
    // 讓請求內容誠實反映實際行為，不是伺服器真的依賴這個值來決定要不要寫入。
    const res = await fetch(`/api/workflows/${id}/autorun`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params, expected: (expected ?? "").trim() || undefined, dryRun: true }),
    });
    const data = await res.json() as {
      ok?: boolean; needsHuman?: boolean; needsReview?: boolean; canPromote?: boolean; validationLevel?: "simulated" | "real-readonly"; code?: string; error?: string;
      missing?: { key: string; label: string; type?: "text" | "password" }[]; steps?: AutoStep[];
    };
    if (data.code === "MISSING_REQUIRED_SETTINGS" && data.missing?.length) {
      continuations.set(id, { kind: "autorun", expected, params });
      set(id, {
        autoTest: { running: false, steps: data.steps ?? [], ok: false, needsHuman: true, source },
        pendingInput: {
          token: Date.now(), kind: "settings", title: "先補上只有你知道的資料",
          description: "內容直接存本機，不會放進對話或交給 AI；填完會自動繼續修復測試。",
          // 優先用節點宣告的欄位型別,只有沒帶 type 時才退回猜文字(猜錯會讓 webhook 網址這類機密明文顯示)
          fields: data.missing.map((item) => ({ ...item, type: item.type ?? (/密碼|password|token|secret/i.test(`${item.key} ${item.label}`) ? "password" : "text"), required: true })),
        },
      });
      appendAssistantNote(id, `要實際測還缺：${data.missing.map((item) => item.label).join("、")}。直接在下面補好，我會自動接著做。`);
      return;
    }
    set(id, { autoTest: { running: false, steps: data.steps ?? [], ok: !!data.ok, needsHuman: !!data.needsHuman, needsReview: !!data.needsReview, canPromote: !!data.canPromote, validationLevel: data.validationLevel, source } });
    // AI 在自動測試迴圈裡真的改過節點 config——跟對話 edits 用同一套通知：畫布重新載入(不然使用者
    // 點開節點還是看到跑之前的舊設定)+ 跳一個小通知列出改了哪些節點(以前只有這個 modal 裡的文字看得到)。
    const fixLabels = ((data.steps ?? []) as AutoStep[])
      .filter((s) => s.kind === "fix" && s.nodeLabel)
      .map((s) => s.nodeLabel as string);
    if (fixLabels.length > 0) {
      const nextToken = (get(id).reloadToken ?? 0) + 1;
      set(id, { reloadToken: nextToken, editToast: { labels: [...new Set(fixLabels)], token: nextToken } });
    }
    if (source === "chat") {
      const summary = (data.steps ?? []).slice(-6).map((step) => {
        const icon = step.kind === "done" ? "✅" : step.kind === "fix" ? "🔧" : step.kind === "human" ? "🙋" : step.kind === "giveup" ? "⚠️" : "•";
        return `${icon} ${step.title}${step.detail ? `：${step.detail}` : ""}`;
      }).join("\n");
      appendAssistantNote(id, data.ok
        ? data.canPromote
          ? `✅ 已用真實資料完成只讀驗證；沒有真的寫入。${summary ? `\n\n${summary}` : ""}\n\n我現在再做一次安全預覽，把實際數字和預計寫入內容列給你確認。`
          : `🟡 流程接線已通過，但這輪使用了模擬資料，還不能當成正式驗收。${summary ? `\n\n${summary}` : ""}\n\n請提供一份真實但可安全測試的資料後再驗證一次。`
        : `⚠️ 這輪還沒完全修好。${summary ? `\n\n${summary}` : data.error ? `\n${data.error}` : ""}`);
      if (data.ok && data.canPromote) await previewWorkflowFromChat(id, get(id).chat, params);
    }
  } catch {
    set(id, { autoTest: { running: false, steps: [{ kind: "giveup", title: "測試過程出錯了，請再試一次" }], source } });
    if (source === "chat") appendAssistantNote(id, "⚠️ 自動測試／修復的連線中斷了。流程沒有被當成成功；可以直接說「再試一次」。");
  }
}

/** 使用者在自動測試/修復進行中按「⏹ 停止」——迴圈是整包在一個 request 裡跑到底，
 * 沒有 runId 可以打一般的 /api/runs/[id]/cancel，走專門的 stop-loop 端點。 */
export async function stopAutoTest(id: string) {
  await fetch(`/api/workflows/${id}/stop-loop`, { method: "POST" }).catch(() => {});
}
