"use client";

// 流程頁對話的「演練／正式執行」層：對話說「測試看看」的參數蒐集與只讀演練、
// 使用者確認後的正式執行、run 輪詢(monitorChatRun)、自動測試修復迴圈(startAutoTest)
// 與各種停止/取消動作。依賴 types/store/setupCards，不依賴入口檔(wfChatStore.ts)。

import type { ParamField } from "@/lib/workflow/types";
import { formatPlannedWriteLines, formatSafeRunOutput, humanizePreviewPair } from "@/lib/workflow/plainLanguage";
import { compactHistoryForRequest, historyHasReusablePreviewFile } from "@/lib/chatHistory";
import { extractChatRunParams, schemaAcceptsDateRange, type DateRange } from "@/lib/workflow/chatRunParams";
import { isNonModelMsg, type AutoStep, type ChatExecutionState, type ChatMsg, type Part } from "./types";
import { appendAssistantNote, chatControllers, chatEpoch, continuations, get, runControllers, set, verificationControllers } from "./store";
import { announceSlidesOAuthFailureIfNeeded, promptForMissingSecrets } from "./setupCards";

export type PreviewResponse = {
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
  appendAssistantNote(id, `你指定了 ${range.start} 到 ${range.end}，但這條舊流程還沒有真正接上可選區間。我現在先把開始／結束日期接進實際運算步驟，完成後會直接用這段日期演練，不會叫你去別處設定。`);
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
    appendAssistantNote(id, `✅ 已把開始／結束日期接成執行時選項${detail ? `（${detail}）` : ""}。現在接著用你指定的區間演練。`);
    return true;
  } catch (error) {
    appendAssistantNote(id, `⚠️ 準備指定區間時連線失敗：${error instanceof Error ? error.message : "未知錯誤"}。沒有拿其他日期代替。`);
    return false;
  } finally {
    set(id, { thinking: false });
  }
}

export async function prepareChatPreview(
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
          token: Date.now(), kind: "params", title: "這次執行要用的資料",
          description: "填完我就自動接著演練；這些值只拿來執行，不需要懂流程設定。",
          fields: visible.map((field) => ({ ...field, required: missing.some((item) => item.key === field.key) })),
        },
      });
      appendAssistantNote(id, `還差 ${missing.map((field) => `「${field.label}」`).join("、")} 才能實際測。直接在下面填好，我會自動接著做。`);
      return;
    }
    await previewWorkflowFromChat(id, history, params);
  } catch (error) {
    appendAssistantNote(id, `⚠️ 準備演練時出錯了：${error instanceof Error ? error.message : "未知錯誤"}`);
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
      appendAssistantNote(id, "這是外部匯入的流程。即使現在只做不寫入的測試，它仍可能讀本機檔案或開啟外部網站；請先確認來源可信，再按下面的「信任來源並演練」。");
      return;
    }
    const data: PreviewResponse = envelope.preview ?? { ok: false, error: envelope.error ?? "演練沒有回傳結果" };
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
          `⚠️ 演練停在「${data.failedNode ?? "某一步"}」，原因是還缺 ${missingOnFailure.map((item) => item.label).join("、")}——不是流程設定有問題。直接在下面安全欄位補好，我會自動接著重跑預覽。`,
        );
        set(id, {
          activeExecution: data.runId ? { runId: data.runId, mode: "preview", status: "failed", reason: data.error ?? undefined, failedNode: data.failedNode } : null,
          // 若這時已經有另一張卡在等使用者填(例如 Google Slides 專屬授權卡剛好同時要顯示)，
          // 不能悄悄蓋掉它讓使用者已經填到一半的內容消失——跟這個檔案其他地方(見
          // announceSlidesOAuthSetupIfNeeded 等)的既有保護同一套慣例：get(id).pendingInput ?? 新卡片。
          pendingInput: get(id).pendingInput ?? {
            token: Date.now(), kind: "settings", title: "填一次就好的帳密",
            description: "內容會直接存進本機加密設定，不會出現在對話紀錄，也不會送給 AI。填完會自動繼續。",
            fields: missingOnFailure.map((item) => ({ ...item, type: /密碼|password|token|secret/i.test(`${item.key} ${item.label}`) ? "password" : "text", required: true })),
          },
        });
        return;
      }
      appendAssistantNote(id, `⚠️ 演練沒有通過，停在「${data.failedNode ?? "某一步"}」：${data.error ?? "未知錯誤"}\n\n沒有執行任何寫入。`);
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
      "✅ 演練完成。以下是實際抓到、算出的結果：",
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
          token: Date.now(), kind: "settings", title: "填一次就好的帳密",
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
      appendAssistantNote(id, "已停止演練，沒有執行任何寫入。");
      return;
    }
    appendAssistantNote(id, `⚠️ 演練連線失敗：${error instanceof Error ? error.message : "未知錯誤"}。沒有執行任何寫入。`);
  } finally {
    if (verificationControllers.get(id) === controller) {
      verificationControllers.delete(id);
      set(id, { verifying: false });
    }
  }
}

export function stopVerification(id: string) {
  verificationControllers.get(id)?.abort(new Error("使用者已停止演練"));
  // 中斷瀏覽器 fetch 不保證 Next.js 立刻收到 disconnect；同步通知 server 中止真正的 run/外部呼叫。
  void fetch(`/api/workflows/${id}/stop-build`, { method: "POST" }).catch(() => {});
}

export function cancelPendingExecution(id: string) {
  if (!get(id).pendingExecution) return;
  set(id, { pendingExecution: null });
  appendAssistantNote(id, "已取消，不會寫入任何資料。");
}

/** 使用者看過演練結果後明確確認，才啟動一次正式執行。 */
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
      appendAssistantNote(id, "流程在演練後被修改過；我不會拿舊預覽去執行新版本。現在自動重新演練，請再核對一次。");
      await prepareChatPreview(id, get(id).chat, pending.params);
      return;
    }
    if (start.status === 409 && started.code === "ACCEPTANCE_SPEC_OUTDATED") {
      set(id, { pendingExecution: null });
      appendAssistantNote(id, "這條流程的驗收答案屬於舊版本；我不會直接執行。現在先用安全只讀模式重新驗證，確認後再回來執行。");
      await startAutoTest(id, undefined, { source: "chat", params: pending.params });
      return;
    }
    if (start.status === 409 && started.code === "PREVIEW_INPUT_EXPIRED") {
      set(id, { pendingExecution: null });
      appendAssistantNote(id, "演練時用的附件／網址已過期，或確認鍵被重複送出；我不會改拿別份資料執行。現在重新演練，請再核對一次。");
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
          token: Date.now(), kind: "settings", title: "填一次就好的帳密",
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

export async function monitorChatRun(id: string, runId: string) {
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
          ? `✅ 只演練完成。這次沒有寫入或發送任何內容。${resultNote}`
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
          ? "已停止只演練；這次沒有寫入或發送任何內容。"
          : "已停止正式執行。已經完成的外部寫入不會自動回滾；尚未執行的步驟不會再繼續。"
        : data.run.resolution === "needs-human"
          ? `⚠️ 停在「${data.run.failed_node ?? "某一步"}」：${data.run.reason ?? "還缺少只有你手上才有的資料"}\n\n這不是改流程能猜出來的問題。我已經指出需要補的資料；補好後直接再試，不會叫 AI 白跑。`
        : mode === "preview"
          ? `⚠️ 只演練停在「${data.run.failed_node ?? "某一步"}」：${data.run.reason ?? "未知錯誤"}\n\n沒有執行任何寫入。可以讓 AI 修流程，或以只讀模式從失敗處再試。`
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

/**
 * Google Slides 的第一次授權填好後，直接演練驗證「這一格」而不是叫新手回畫布猜要按哪個鍵。
 * onlyNodeIds 讓無關的登入/寫入步驟不會把驗證結果攪在一起；dryRun 保證不會送 batchUpdate。
 */
export async function verifyGoogleSlidesSetup(id: string, nodeIds: string[]) {
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

export async function trustImportedAndContinue(id: string) {
  const continuation = continuations.get(id);
  if (!get(id).pendingTrust || continuation?.kind !== "preview") return;
  set(id, { pendingTrust: false });
  appendAssistantNote(id, "已收到信任確認。現在只做演練，所有寫入與通知仍然會被攔住。");
  await previewWorkflowFromChat(id, continuation.history, continuation.params, true);
}

export function cancelPendingTrust(id: string) {
  continuations.delete(id);
  set(id, { pendingTrust: false });
  appendAssistantNote(id, "已取消；沒有開啟這個外部流程，也沒有執行或寫入任何資料。");
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
  if (!runId) { appendAssistantNote(id, "找不到可以續跑的失敗紀錄。先說「測試看看」，我會從演練開始。"); return; }
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
    // autorun 伺服器端一律強制演練(dryRun 永遠 true，不管這裡傳什麼)——這裡仍傳 true 只是
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
          token: Date.now(), kind: "settings", title: "填一次就好的帳密",
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
          ? `✅ 已用真實資料完成演練驗證；沒有真的寫入。${summary ? `\n\n${summary}` : ""}\n\n我現在再做一次演練，把實際數字和預計寫入內容列給你確認。`
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
