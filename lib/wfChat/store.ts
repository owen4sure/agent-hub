"use client";

// 流程頁對話的儲存層：模組層 store(states/listeners/各種 AbortController)、localStorage 與
// server 端 chat-context 的持久化、useWFChat hook，以及 appendAssistantNote／清除對話等
// 直接操作 store 的基本動作。wfChat 其他檔案都建立在這一層之上。

import { useSyncExternalStore } from "react";
import { compactHistoryForPersistence } from "@/lib/chatHistory";
import type { ChatInputField, ChatMsg, Part, PendingChatInput, PendingExecution, WFChatState } from "./types";

// 這些 AI 長時間工作的狀態(對話、思考中、待套用的新流程、自動測試)本來存在頁面元件裡，
// 一切換畫面元件就被銷毀、結果就不見。改存在這個「模組層」store：它不隨頁面卸載而消失，
// 所以切走再回來還在；正在跑的 fetch 也是在這裡發動的，不會被中斷。對話另外存 localStorage，
// 連重新整理也還在。

const EMPTY: WFChatState = {
  chat: [], thinking: false, pendingGraph: null, autoTest: null, reloadToken: 0, editToast: null,
  verifying: false, pendingExecution: null, pendingInput: null, activeExecution: null, pendingApproval: null, pendingTrust: false,
};

const states = new Map<string, WFChatState>();
const listeners = new Set<() => void>();
// 每次「清除對話」就把這個 workflow 的 epoch +1；進行中的 sendChatToAI 記住送出當下的 epoch，
// 回來時若 epoch 變了(代表使用者中途清了對話)，就丟棄這次結果、不要把清掉的舊對話又寫回去。
export const chatEpoch = new Map<string, number>();
export const chatControllers = new Map<string, AbortController>();
export const verificationControllers = new Map<string, AbortController>();
export const runControllers = new Map<string, AbortController>();
export const runtimeRecovering = new Set<string>();
const serverPersistTimers = new Map<string, number>();
export type Continuation =
  | { kind: "preview"; history: ChatMsg[]; params: Record<string, unknown> }
  | { kind: "formal"; params: Record<string, unknown>; confirmImported?: boolean }
  | { kind: "autorun"; expected?: string; params: Record<string, unknown> }
  | { kind: "build"; history: ChatMsg[] };
export const continuations = new Map<string, Continuation>();

export function emit() { listeners.forEach((l) => l()); }
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }

export function get(id: string): WFChatState {
  let s = states.get(id);
  if (!s) { s = loadPersisted(id) ?? EMPTY; states.set(id, s); }
  return s;
}
export function set(id: string, patch: Partial<WFChatState>) {
  states.set(id, { ...get(id), ...patch });
  persist(id);
  emit();
}

/**
 * 安全輸入卡本身只含欄位名稱、說明和下一個「演練驗證」動作，從不含使用者剛打的值。
 * 這個小型白名單讓它可以跨重整保存，同時不信任 localStorage／server state 裡任意塞進來的形狀。
 */
export function restorePendingInput(raw: unknown): PendingChatInput | null {
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
/**
 * 「最後一則是使用者說的話、後面什麼都沒有」＝上一次的建立被中斷了。
 *
 * 建圖請求是綁在那個分頁上的：使用者重新整理、切走或關掉，請求就被中斷，伺服器端不留任何東西。
 * 回來看到的是「自己的訊息 + 一片空白」——沒有回覆、沒有錯誤、沒有任何線索。而建圖動輒好幾分鐘，
 * 中途離開是常態不是意外(真實踩過)。這裡把那個沉默補上。
 * 標成 isControl，所以它不會被當成 AI 說過的話餵回模型。
 */
const INTERRUPTED_NOTE_TEXT = "⚠️ 上一次的建立沒有完成——重新整理或關掉頁面會中斷這個分頁跟它的連線。不過伺服器通常會把建立跑完並保留結果，我正在確認；如果真的沒有結果，你剛才那句話還在上面，直接再送一次就可以了。";

export function withInterruptedNote(chat: ChatMsg[], hasPendingGraph: boolean): ChatMsg[] {
  const last = chat[chat.length - 1];
  if (!last || last.role !== "user" || hasPendingGraph) return chat;
  return [...chat, {
    role: "assistant" as const,
    isControl: true,
    parts: [{ kind: "text" as const, text: INTERRUPTED_NOTE_TEXT }],
  }];
}

/** 偵測到建圖其實還在伺服器上進行、或已從伺服器撈回結果時，把上面那句「可能要重送」的提示撤掉。 */
export function stripInterruptedNote(chat: ChatMsg[]): ChatMsg[] {
  return chat.filter((m) => !(m.isControl && (m.parts ?? []).some((p) => p.kind === "text" && p.text === INTERRUPTED_NOTE_TEXT)));
}

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
      chat: withInterruptedNote(p.chat ?? [], Boolean(p.pendingGraph)),
      thinking: false, pendingGraph: p.pendingGraph ?? null, autoTest: null,
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

/** 在對話區補一則系統提示(如「已套用到畫布」)。標成 isError 只在真的是錯誤時；一般提示 isError 省略。
 * 這種提示不會被送回給模型(isSystemErrorMsg 只濾錯誤那幾句，這裡用非錯誤提示，仍會進歷史但無害；
 * 若要確保不進模型可自行加進 ERROR_TEXT_PATTERNS，這裡刻意讓「已套用」留在歷史當上下文)。 */
export function appendAssistantNote(id: string, text: string) {
  const s = get(id);
  set(id, { chat: [...s.chat, { role: "assistant", parts: [{ kind: "text", text }], isError: text.startsWith("⚠️"), isControl: true }] });
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
