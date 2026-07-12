"use client";

import { useSyncExternalStore } from "react";
import type { WorkflowNode, WorkflowEdge, ParamField } from "@/lib/workflow/types";
import type { SuggestedSchedule } from "@/lib/workflow/builder";

// 這些 AI 長時間工作的狀態(對話、思考中、待套用的新流程、自動測試)本來存在頁面元件裡，
// 一切換畫面元件就被銷毀、結果就不見。改存在這個「模組層」store：它不隨頁面卸載而消失，
// 所以切走再回來還在；正在跑的 fetch 也是在這裡發動的，不會被中斷。對話另外存 localStorage，
// 連重新整理也還在。

export type Part =
  | { kind: "text"; text: string }
  | { kind: "image"; b64: string; name?: string }
  | { kind: "file"; name: string; content: string };

/** isError=true 的訊息是「系統錯誤提示」(連線失敗之類)，只給人看——送給模型的歷史一定要濾掉它們，
 * 不然模型會把它們當成「AI 之前說過的話」有樣學樣，開始自己回覆「連線失敗」(真實踩過的雷)。 */
export interface ChatMsg { role: "user" | "assistant"; parts: Part[]; isError?: boolean }

// 舊的(還沒有 isError 標記就存進 localStorage 的)錯誤訊息用文字特徵辨識，一樣要濾掉。
// 用「訊息開頭就是這幾句系統話術」比對(^)，不用寬鬆的包含比對——不然使用者在跟 AI 討論
// 「登入連線失敗要怎麼處理」時，AI 回覆裡提到『連線失敗』會被誤判成系統錯誤而被丟掉。
const ERROR_TEXT_PATTERNS = [/^（連線出錯，AI 沒回覆/, /^\(AI 又連線失敗/, /^AI 暫時連不上或忙線中/];
export function isSystemErrorMsg(m: ChatMsg): boolean {
  if (m.isError) return true;
  return m.role === "assistant" && m.parts.some((p) => p.kind === "text" && ERROR_TEXT_PATTERNS.some((r) => r.test(p.text.trim())));
}
export interface AutoStep { kind: "run" | "fix" | "done" | "human" | "giveup" | "info"; title: string; detail?: string; nodeLabel?: string; runId?: string }
export interface PendingGraph { nodes: WorkflowNode[]; edges: WorkflowEdge[]; message: string; triggerParams?: ParamField[]; schedule?: SuggestedSchedule }
export interface AutoTestState { running: boolean; steps: AutoStep[]; ok?: boolean; needsHuman?: boolean }

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
}

const EMPTY: WFChatState = { chat: [], thinking: false, pendingGraph: null, autoTest: null, reloadToken: 0, editToast: null };

const states = new Map<string, WFChatState>();
const listeners = new Set<() => void>();
// 每次「清除對話」就把這個 workflow 的 epoch +1；進行中的 sendChatToAI 記住送出當下的 epoch，
// 回來時若 epoch 變了(代表使用者中途清了對話)，就丟棄這次結果、不要把清掉的舊對話又寫回去。
const chatEpoch = new Map<string, number>();
const chatControllers = new Map<string, AbortController>();

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
    return { chat: p.chat ?? [], thinking: false, pendingGraph: p.pendingGraph ?? null, autoTest: null, reloadToken: 0, editToast: null };
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
      if (p.kind === "image") return { kind: "text", text: `(圖片：${p.name ?? "圖"})` };
      if (p.kind === "file" && p.content.length > 2000) return { ...p, content: p.content.slice(0, 2000) + "…(內容已截短)" };
      return p;
    }),
  }));
}

function persist(id: string) {
  try {
    const s = get(id);
    localStorage.setItem(keyOf(id), JSON.stringify({ chat: stripHeavyForPersist(s.chat), pendingGraph: s.pendingGraph }));
  } catch { /* localStorage 滿了或不可用就算了 */ }
}

/** 元件用這個 hook 訂閱某個 workflow 的 AI 狀態；store 變動就重繪，跨頁面不遺失 */
export function useWFChat(id: string): WFChatState {
  return useSyncExternalStore(subscribe, () => get(id), () => EMPTY);
}

export function clearPendingGraph(id: string) { set(id, { pendingGraph: null }); }
export function closeAutoTest(id: string) { set(id, { autoTest: null }); }

/**
 * 送一則訊息給 AI 建/改流程。fetch 在這裡發動(模組層)，就算使用者馬上切走畫面，
 * 這個 async 仍會跑完並把 AI 回覆寫回 store，回到該流程就看得到。
 */
export async function sendChatToAI(id: string, history: ChatMsg[]) {
  const epoch = chatEpoch.get(id) ?? 0;
  // 送新訊息就先清掉上一輪「待套用的流程圖預覽」——不然聊了三輪改需求後，畫面還掛著三輪前的舊圖，
  // 使用者一按「套用」套的是過時的圖。
  set(id, { chat: history, thinking: true, pendingGraph: null });
  // 送給模型前把「系統錯誤提示」從歷史裡濾掉——那些不是 AI 說的話，混進去模型會模仿著回「連線失敗」
  const cleanHistory = history.filter((m) => !isSystemErrorMsg(m));
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
    if (res.ok && data.phase === "ready") {
      commit({
        chat: [...history, { role: "assistant", parts: [{ kind: "text", text: `${data.message}\n\n(下方預覽新流程，確認後按「套用」)` }] }],
        pendingGraph: { nodes: data.nodes, edges: data.edges, message: data.message, triggerParams: data.triggerParams, schedule: data.schedule },
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

/** Stop an interactive build immediately, including retries and Claude CLI fallback. */
export function stopChatToAI(id: string) {
  chatEpoch.set(id, (chatEpoch.get(id) ?? 0) + 1);
  chatControllers.get(id)?.abort();
  chatControllers.delete(id);
  const s = get(id);
  set(id, {
    thinking: false,
    chat: [...s.chat, { role: "assistant", parts: [{ kind: "text", text: "已停止這次建圖。你可以修改需求後再送出。" }] }],
  });
}

/** 在對話區補一則系統提示(如「已套用到畫布」)。標成 isError 只在真的是錯誤時；一般提示 isError 省略。
 * 這種提示不會被送回給模型(isSystemErrorMsg 只濾錯誤那幾句，這裡用非錯誤提示，仍會進歷史但無害；
 * 若要確保不進模型可自行加進 ERROR_TEXT_PATTERNS，這裡刻意讓「已套用」留在歷史當上下文)。 */
export function appendAssistantNote(id: string, text: string) {
  const s = get(id);
  set(id, { chat: [...s.chat, { role: "assistant", parts: [{ kind: "text", text }], isError: text.startsWith("⚠️") }] });
}

/** 清除這個 workflow 的整段對話(對話被錯誤訊息污染、或想換個講法重來時用)。
 * bump epoch 讓正在飛的 sendChatToAI 回來時不會把清掉的對話又寫回去。 */
export function clearChat(id: string) {
  chatEpoch.set(id, (chatEpoch.get(id) ?? 0) + 1);
  chatControllers.get(id)?.abort();
  chatControllers.delete(id);
  set(id, { chat: [], pendingGraph: null, thinking: false });
}

/** 草稿「幫我測到會跑」的全自動迴圈。同樣在模組層跑，切走畫面也不中斷，回來還看得到進度/結果。 */
export async function startAutoTest(id: string) {
  if (get(id).autoTest?.running) return;
  set(id, { autoTest: { running: true, steps: [] } });
  try {
    const res = await fetch(`/api/workflows/${id}/autorun`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }),
    });
    const data = await res.json();
    set(id, { autoTest: { running: false, steps: data.steps ?? [], ok: !!data.ok, needsHuman: !!data.needsHuman } });
    // AI 在自動測試迴圈裡真的改過節點 config——跟對話 edits 用同一套通知：畫布重新載入(不然使用者
    // 點開節點還是看到跑之前的舊設定)+ 跳一個小通知列出改了哪些節點(以前只有這個 modal 裡的文字看得到)。
    const fixLabels = ((data.steps ?? []) as AutoStep[])
      .filter((s) => s.kind === "fix" && s.nodeLabel)
      .map((s) => s.nodeLabel as string);
    if (fixLabels.length > 0) {
      const nextToken = (get(id).reloadToken ?? 0) + 1;
      set(id, { reloadToken: nextToken, editToast: { labels: [...new Set(fixLabels)], token: nextToken } });
    }
  } catch {
    set(id, { autoTest: { running: false, steps: [{ kind: "giveup", title: "測試過程出錯了，請再試一次" }] } });
  }
}

/** 使用者在自動測試/修復進行中按「⏹ 停止」——迴圈是整包在一個 request 裡跑到底，
 * 沒有 runId 可以打一般的 /api/runs/[id]/cancel，走專門的 stop-loop 端點。 */
export async function stopAutoTest(id: string) {
  await fetch(`/api/workflows/${id}/stop-loop`, { method: "POST" }).catch(() => {});
}
