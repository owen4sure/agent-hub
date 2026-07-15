"use client";

import { useSyncExternalStore } from "react";
import type { WorkflowNode, WorkflowEdge, ParamField } from "@/lib/workflow/types";
import type { SuggestedSchedule } from "@/lib/workflow/builder";
import { classifyChatCommand } from "@/lib/workflow/chatCommand";
import { sheetWriteNodesNeedingSetup } from "@/lib/googleSheetScriptTemplate";
import { formatPlannedWriteLines, humanizePreviewPair } from "@/lib/workflow/plainLanguage";
import { compactHistoryForPersistence, compactHistoryForRequest, historyHasReusablePreviewFile } from "@/lib/chatHistory";
import { extractChatRunParams, schemaAcceptsDateRange, type DateRange } from "@/lib/workflow/chatRunParams";

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
  | { kind: "sheet-script"; nodeLabels: string[] };

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
export interface AutoTestState { running: boolean; steps: AutoStep[]; ok?: boolean; needsHuman?: boolean; source?: "toolbar" | "chat" }
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
}
export interface ChatExecutionState {
  runId: string;
  /** preview=只讀安全試跑；formal=使用者已確認的正式執行。UI 和續跑都不能混淆這個邊界。 */
  mode: "preview" | "formal";
  status: "starting" | "queued" | "running" | "waiting" | "success" | "failed" | "cancelled";
  reason?: string;
  failedNode?: string | null;
}
export interface PendingChatApproval {
  id: string;
  runId: string;
  message: string;
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
    return {
      chat: p.chat ?? [], thinking: false, pendingGraph: p.pendingGraph ?? null, autoTest: null,
      reloadToken: 0, editToast: null, verifying: false, pendingExecution,
      pendingInput: null, activeExecution: null, pendingApproval: null, pendingTrust: false,
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
  const data = response ? await response.json().catch(() => ({})) as { error?: string } : {};
  if (!response?.ok) {
    set(id, { chat: history });
    appendAssistantNote(id, `⚠️ 剛畫好的流程還沒存進草稿：${data.error ?? "無法連到伺服器"}。候選圖仍保留，可以再試一次。`);
    return false;
  }
  const nextToken = (get(id).reloadToken ?? 0) + 1;
  set(id, { chat: history, pendingGraph: null, reloadToken: nextToken });
  if (announce) appendAssistantNote(id, `✅ 已把剛才的 ${graph.nodes.length} 個步驟存進草稿畫布；這只是流程設定，尚未正式執行或寫入外部資料。`);
  announceSheetSetupIfNeeded(id, graph.nodes);
  return true;
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
 * 送一則訊息給 AI 建/改流程。fetch 在這裡發動(模組層)，就算使用者馬上切走畫面，
 * 這個 async 仍會跑完並把 AI 回覆寫回 store，回到該流程就看得到。
 */
export async function sendChatToAI(id: string, history: ChatMsg[]) {
  const lastUser = [...history].reverse().find((message) => message.role === "user");
  const lastText = (lastUser?.parts ?? []).filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n");
  const command = classifyChatCommand(lastText);
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
  const cleanHistory = compactHistoryForRequest(history.filter((m) => !isNonModelMsg(m)));
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
      commit({
        chat: [...history, { role: "assistant", parts: [{ kind: "text", text: `${data.message}${detailBlock}` }] }],
        reloadToken: nextToken,
        // 畫布上跳「已更新」通知(labels 給通知顯示改了哪些節點)
        editToast: labels.length ? { labels, token: nextToken } : null,
      });
    } else if (res.ok) {
      commit({ chat: [...history, { role: "assistant", parts: [{ kind: "text", text: data.message ?? "…" }] }] });
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
        pendingInput: {
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
      runId?: string; error?: string; code?: string; missing?: { key: string; label: string }[];
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
          fields: started.missing.map((item) => ({ ...item, type: /密碼|password|token|secret/i.test(`${item.key} ${item.label}`) ? "password" : "text", required: true })),
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
      const data = await res.json() as { run?: { status?: string; reason?: string; failed_node?: string; dry_run?: number } };
      if (!res.ok || !data.run) throw new Error("暫時讀不到執行狀態");
      const raw = data.run.status ?? "running";
      const mode: ChatExecutionState["mode"] = data.run.dry_run ? "preview" : "formal";
      if (raw === "queued" || raw === "running") {
        set(id, { activeExecution: { runId, mode, status: raw, failedNode: data.run.failed_node } });
        await abortableDelay(1_000, controller.signal);
        continue;
      }
      if (raw === "success") {
        set(id, { activeExecution: { runId, mode, status: "success" }, pendingApproval: null });
        appendAssistantNote(id, mode === "preview"
          ? `✅ 只讀安全試跑完成。執行編號：${runId}。這次沒有寫入或發送任何內容。`
          : `✅ 正式執行完成。執行編號：${runId}。結果已經真的寫出；需要細節時直接問我「剛剛做了什麼」。`);
        return;
      }
      if (raw === "waiting") {
        const approvals = await fetch(`/api/approvals`, { signal: controller.signal }).then((response) => response.json()) as {
          approvals?: { id: string; run_id: string; message: string }[];
        };
        const approval = approvals.approvals?.find((item) => item.run_id === runId);
        set(id, {
          activeExecution: { runId, mode, status: "waiting", reason: data.run.reason },
          pendingApproval: approval ? { id: approval.id, runId, message: approval.message } : null,
        });
        appendAssistantNote(id, approval
          ? "流程已跑到需要真人決定的關卡。直接在下面核准或拒絕，決定後會從原地繼續。"
          : "流程正在等待外部核准。核准完成後會從原地繼續，不會重跑前面已完成的步驟。");
        return;
      }
      const cancelled = /使用者.*停止|已停止|cancel/i.test(data.run.reason ?? "");
      set(id, {
        activeExecution: { runId, mode, status: cancelled ? "cancelled" : "failed", reason: data.run.reason, failedNode: data.run.failed_node },
      });
      appendAssistantNote(id, cancelled
        ? mode === "preview"
          ? "已停止只讀安全試跑；這次沒有寫入或發送任何內容。"
          : "已停止正式執行。已經完成的外部寫入不會自動回滾；尚未執行的步驟不會再繼續。"
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
  if (pending.kind === "settings") {
    const res = await fetch(`/api/secrets`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secrets: values }),
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) { appendAssistantNote(id, `⚠️ 設定沒有存成功：${data.error ?? "未知錯誤"}`); return; }
    set(id, { pendingInput: null });
    appendAssistantNote(id, "✅ 已安全保存，內容沒有放進對話，也沒有傳給 AI。現在自動接著做。");
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
  if (!continuation) return;
  await resumeContinuation(id, continuation, pending.kind, values);
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
        state?: { chat?: ChatMsg[]; pendingGraph?: PendingGraph | null; pendingExecution?: PendingExecution | null } | null;
      };
      if (get(id).chat.length === 0 && Array.isArray(saved.state?.chat) && saved.state.chat.length > 0) {
        set(id, {
          chat: saved.state.chat,
          pendingGraph: saved.state.pendingGraph ?? null,
          pendingExecution: saved.state.pendingExecution ?? null,
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
    const res = await fetch(`/api/workflows/${id}/autorun`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params, expected: (expected ?? "").trim() || undefined, dryRun: source === "chat" }),
    });
    const data = await res.json() as {
      ok?: boolean; needsHuman?: boolean; code?: string; error?: string;
      missing?: { key: string; label: string }[]; steps?: AutoStep[];
    };
    if (data.code === "MISSING_REQUIRED_SETTINGS" && data.missing?.length) {
      continuations.set(id, { kind: "autorun", expected, params });
      set(id, {
        autoTest: { running: false, steps: data.steps ?? [], ok: false, needsHuman: true, source },
        pendingInput: {
          token: Date.now(), kind: "settings", title: "先補上只有你知道的資料",
          description: "內容直接存本機，不會放進對話或交給 AI；填完會自動繼續修復測試。",
          fields: data.missing.map((item) => ({ ...item, type: /密碼|password|token|secret/i.test(`${item.key} ${item.label}`) ? "password" : "text", required: true })),
        },
      });
      appendAssistantNote(id, `要實際測還缺：${data.missing.map((item) => item.label).join("、")}。直接在下面補好，我會自動接著做。`);
      return;
    }
    set(id, { autoTest: { running: false, steps: data.steps ?? [], ok: !!data.ok, needsHuman: !!data.needsHuman, source } });
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
        ? `✅ 已在只讀模式修到會跑；沒有真的寫入。${summary ? `\n\n${summary}` : ""}\n\n我現在再做一次安全預覽，把實際數字和預計寫入內容列給你確認。`
        : `⚠️ 這輪還沒完全修好。${summary ? `\n\n${summary}` : data.error ? `\n${data.error}` : ""}`);
      if (data.ok) await previewWorkflowFromChat(id, get(id).chat, params);
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
