"use client";

// 流程頁對話的「回報／恢復」層：回答「現在跑到哪」「剛剛做了什麼」「執行時能選什麼」
// 一律讀真實伺服器狀態(不讓模型憑聊天猜)；頁面重整後接回進行中的工作(recoverChatRuntime)；
// 以及「驗證看懂(只讀)」的實跑與結果整理。依賴 types/store/execution。

import type { ParamField } from "@/lib/workflow/types";
import { humanizePreviewPair } from "@/lib/workflow/plainLanguage";
import type { ChatExecutionState, ChatMsg, PendingExecution, PendingGraph } from "./types";
import { appendAssistantNote, get, restorePendingInput, runtimeRecovering, set, stripInterruptedNote, verificationControllers, withInterruptedNote } from "./store";
import { monitorChatRun } from "./execution";

export async function reportChatStatus(id: string) {
  const state = get(id);
  if (state.thinking) { appendAssistantNote(id, "目前正在理解需求／建圖，還沒有卡住；可以隨時說「停止」。"); return; }
  if (state.verifying) { appendAssistantNote(id, "目前正在演練：讀取與計算會真的做，所有寫入都被攔住。可以隨時說「停止」。"); return; }
  if (state.autoTest?.running) { appendAssistantNote(id, "目前正在「測到會跑」。它會反覆跑、看錯誤、修改再驗證，最多 15 分鐘；可以隨時說「停止」。"); return; }
  if (state.pendingInput) { appendAssistantNote(id, `目前停在「${state.pendingInput.title}」，等你填下面的欄位；填完會自動繼續。`); return; }
  if (state.pendingTrust) { appendAssistantNote(id, "目前等待你確認是否信任外部匯入流程；尚未開始讀檔或連線。"); return; }
  if (state.pendingExecution) { appendAssistantNote(id, "演練已完成，現在等你核對結果。沒有按確認前不會真的寫入。"); return; }
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
    // 從本機 server 備份恢復對話的兩種情況：
    // ①本地全空(換電腦/清掉瀏覽器資料/localStorage 爆掉)。
    // ②本地停在「使用者說完話、沒有回覆」而伺服器已經有後續——建圖期間重整/關頁時，
    //   伺服器端會把建圖跑完並補寫結果(/build 的 appendServerBuildOutcome)，這裡撈回來，
    //   使用者才不會白等好幾分鐘還被叫重送一次。
    const adoptServerIfNewer = async (buildStillRunning: boolean) => {
      const saved = await fetch(`/api/workflows/${id}/chat-context`).then((response) => response.json()) as {
        state?: { chat?: ChatMsg[]; pendingGraph?: PendingGraph | null; pendingExecution?: PendingExecution | null; pendingInput?: unknown } | null;
      };
      const server = saved.state;
      if (!Array.isArray(server?.chat) || server.chat.length === 0) return;
      const local = get(id).chat;
      const localLast = local[local.length - 1] as ChatMsg | undefined;
      const localWaitingForReply = local.length === 0
        || (server.chat.length > local.length && (localLast?.role === "user" || Boolean(localLast?.isControl)));
      if (!localWaitingForReply) return;
      set(id, {
        // 建圖還在跑的話不補「被中斷」提示(它會說「請再送一次」，跟事實矛盾)；其他情況照舊補。
        chat: buildStillRunning ? stripInterruptedNote(server.chat) : withInterruptedNote(server.chat, Boolean(server.pendingGraph)),
        pendingGraph: server.pendingGraph ?? null,
        pendingExecution: server.pendingExecution ?? null,
        pendingInput: restorePendingInput(server.pendingInput),
      });
    };

    // 建圖是否還在伺服器上進行中(這個分頁若是重整後的新分頁，原本的請求已斷、thinking 不會為 true)
    let buildActive = false;
    if (!get(id).thinking) {
      const progress = await fetch(`/api/workflows/${id}/build-progress`).then((response) => response.json()).catch(() => null) as { stage?: string } | null;
      buildActive = Boolean(progress?.stage);
    }
    await adoptServerIfNewer(buildActive);

    if (buildActive && !get(id).thinking) {
      // 恢復「思考中」顯示＋撤掉誤導的中斷提示，等伺服器把建圖跑完再撈一次結果。
      // thinking=true 也讓輸入區照常進入「建立中」狀態，擋住使用者誤以為沒送出而重送。
      set(id, { thinking: true, chat: stripInterruptedNote(get(id).chat) });
      try {
        const deadline = Date.now() + 15 * 60_000; // 對齊 buildProgress 的殭屍階段上限
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const progress = await fetch(`/api/workflows/${id}/build-progress`).then((response) => response.json()).catch(() => null) as { stage?: string } | null;
          if (!progress?.stage) break;
        }
        await adoptServerIfNewer(false);
      } finally {
        set(id, { thinking: false });
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
    ? `\n\n🔒 演練驗證：已略過「${(d.skippedWrites ?? []).join("、")}」——不會真的寫回試算表/發通知。`
    : "";
  if (!d.ok) {
    return `我實際讀+算到一半卡在「${d.failedNode ?? "某一步"}」：${(d.error ?? "").slice(0, 200)}。\n` +
      `可能是這步的設定要調、或這份檔案跟流程預期的結構不一樣。你可以點那一步用白話補充，我再修。${skip}`;
  }
  const lines = (d.values ?? []).map((v) => {
    const pairs = Object.entries(v.computed).map(([k, val]) => humanizePreviewPair(k, val)).join("、");
    return `• ${v.nodeLabel}：${pairs || "(這步沒有可對照的數值)"}`;
  });
  const body = lines.length ? lines.join("\n") : "(這條流程沒有抽出可對照的數值，可能是它主要在做搬移/通知)";
  return `我用你給的檔案實際跑到「寫回」之前，各步驟算出來是：\n${body}${skip}\n\n` +
    `這些跟你手上已知的正確答案對得上嗎？對不上的話，直接告訴我正確答案，我就去把它修到對。`;
}
