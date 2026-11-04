"use client";

// 流程頁對話的入口：sendChatToAI(對話送模型建/改流程)與它的續作機制(套用候選圖、
// 安全表單提交、continuation 恢復、「繼續」語意)。其餘實作拆在 lib/wfChat/ 底下
// (types/store/setupCards/execution/reports)，這裡 re-export 全部公開符號，
// 既有 `@/lib/wfChatStore` 的 import 路徑完全不用改。

import { classifyChatCommand } from "@/lib/workflow/chatCommand";
import { compactHistoryForRequest } from "@/lib/chatHistory";
import { redactIfLooksLikeCredential } from "@/lib/workflow/chatCredentials";
import {
  isBlankWorkflowForPreview, isNonModelMsg, stripReadyOnlyPromise,
  type ChatMsg, type Part, type PendingChatInput, type WFChatState,
} from "./wfChat/types";
import {
  appendAssistantNote, chatControllers, chatEpoch, continuations, get, set, type Continuation,
} from "./wfChat/store";
import {
  announceSheetSetupIfNeeded, announceSlidesOAuthSetupIfNeeded, announceWorkflowSecretsAfterApply,
  appendSetupCards, promptForMissingSecrets, slidesOAuthInputCard,
} from "./wfChat/setupCards";
import {
  confirmPendingExecution, decideChatApproval, prepareChatPreview, retryChatExecution,
  startAutoTest, stopAllChatWork, trustImportedAndContinue, verifyGoogleSlidesSetup,
  type PreviewResponse,
} from "./wfChat/execution";
import { reportChatStatus, reportLastRun, reportRunInputs } from "./wfChat/reports";

export type {
  Part, ChatMsg, AutoStep, PendingGraph, AutoTestState, PendingExecution, ChatInputField,
  PendingChatInput, ChatExecutionState, PendingChatApproval, WFChatState,
} from "./wfChat/types";
export {
  isSystemErrorMsg, isNonModelMsg, missingWorkflowSecretFields,
  needsWorkflowConstructionBeforePreview, stripReadyOnlyPromise,
} from "./wfChat/types";
export {
  useWFChat, clearPendingGraph, closeAutoTest, appendAssistantNote, clearChat, discardWorkflowChat,
} from "./wfChat/store";
export type { ImportWelcomeSummary } from "./wfChat/setupCards";
export {
  announceSheetSetupIfNeeded, announceSheetScriptFailureIfNeeded, slidesRefreshNodesNeedingOAuthSetup,
  slidesOAuthInputCard, announceSlidesOAuthSetupIfNeeded, announceSlidesOAuthFailureIfNeeded,
  announceNeedsHumanIfNeeded, promptForMissingSecrets, seedImportWelcome,
} from "./wfChat/setupCards";
export {
  stopVerification, cancelPendingExecution, confirmPendingExecution, trustImportedAndContinue,
  cancelPendingTrust, stopAllChatWork, retryChatExecution, decideChatApproval, startAutoTest, stopAutoTest,
} from "./wfChat/execution";
export {
  reportChatStatus, reportLastRun, reportRunInputs, recoverChatRuntime, verifyUnderstanding,
} from "./wfChat/reports";

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
  // Google Slides 有「存好就演練驗證」的專用授權卡；其餘連線資料(收寄信、LINE、Telegram、Slack…)
  // 則優先用套用 API 直接回傳的結果立刻給安全輸入卡。這避免「先存圖、再 GET 最新狀態」的非同步
  // 間隙讓卡片偶發消失；GET 分支只保留給舊版/外部呼叫端的相容備援。
  const slidesKeys = new Set(["googleOAuthClientId", "googleOAuthClientSecret", "googleOAuthRefreshToken"]);
  const usesSlides = graph.nodes.some((node) => node.type === "google-slides-refresh" || node.type === "google-slides-create");
  // 「換圖腳本的驗證碼」也不能進這張必填卡(實測踩過的雞生蛋)：值是「換掉簡報圖片」設定流程的
  // 產物(自動部署會自己產生並存好)，新使用者此刻不可能有——放進必填卡會讓其他填得出來的欄位
  // 一起卡死存不了。它的設定入口由畫布上方的準備檢查橫幅「去設定換簡報圖片」負責。
  const usesSlidesImage = graph.nodes.some((node) => node.type === "google-slides-replace-image" || node.type === "google-slides-copy-page");
  const missing = Array.isArray(data.missingSecrets)
    ? data.missingSecrets.filter((field) =>
      (!usesSlides || !slidesKeys.has(field.key)) && (!usesSlidesImage || field.key !== "slidesImageScriptToken"))
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
      else if (!pending) appendAssistantNote(id, "目前沒有一筆等你確認的演練。先說「測試看看」，我會跑到寫入前並把結果列給你核對。");
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
        chat: [...history, { role: "assistant", parts: [{ kind: "text", text: stripReadyOnlyPromise(data.message ?? "演練已完成") }] }],
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
      const newChat: ChatMsg[] = [...history, { role: "assistant", parts: [{ kind: "text", text: `${stripReadyOnlyPromise(data.message)}${detailBlock}` }] }];
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
      const { chat: chatWithCards, slidesSetupNodeIds } = appendSetupCards([...history, { role: "assistant", parts: [{ kind: "text", text: stripReadyOnlyPromise(data.message ?? "…") }] }], data);
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
          title: "填一次就好的帳密",
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
          title: "填一次就好的帳密",
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
      ? "✅ 已安全保存，內容沒有放進對話，也沒有傳給 AI。現在演練驗證 Google 簡報連線，不會更新投影片。"
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
  // Google Slides 是一個獨立的「存好就立刻演練驗證」流程。即使這條 workflow 剛好還留著
  // 其他對話的 continuation，也絕不能優先重送舊需求而跳過驗證，否則使用者會以為授權設好了、
  // 卻沒有任何證據知道網址/權限/圖表是否真的正確。
  if (afterSave?.kind === "verify-google-slides") await verifyGoogleSlidesSetup(id, afterSave.nodeIds);
  else if (continuation) await resumeContinuation(id, continuation, pending.kind, values);
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
      appendAssistantNote(id, "✅ 已確認授權資料存在，現在演練驗證 Google 簡報連線，不會更新投影片。");
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
    appendAssistantNote(id, "目前停在外部流程的來源確認。請按「信任來源並演練」；模糊的「繼續」不會被當成安全授權。");
    return;
  }
  if (state.pendingExecution) {
    appendAssistantNote(id, "演練已完成，正等你核對。若數字正確，請說「確認正式執行」或按下面的確認鍵；我不會把模糊的「繼續」當成寫入授權。");
    return;
  }
  if (state.activeExecution?.status === "failed") { await retryChatExecution(id); return; }
  await reportChatStatus(id);
}

export function cancelChatInput(id: string) {
  continuations.delete(id);
  set(id, { pendingInput: null });
  appendAssistantNote(id, "已取消，沒有儲存或執行任何東西。");
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
