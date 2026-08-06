"use client";

// 流程頁對話(wfChatStore)的型別與純函式層：訊息/卡片/狀態的形狀定義，以及不碰 store 的
// 判斷函式(錯誤訊息辨識、缺帳密欄位計算、空流程判斷、ready 專屬提示過濾)。
// 這一層不依賴 wfChat 其他檔案，是整組拆檔的依賴最底層。

import type { WorkflowNode, WorkflowEdge, ParamField } from "@/lib/workflow/types";
import type { SuggestedSchedule } from "@/lib/workflow/builder";

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

export type WorkflowSecretStatus = {
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
  /** preview=只演練；formal=使用者已確認的正式執行。UI 和續跑都不能混淆這個邊界。 */
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

export async function isBlankWorkflowForPreview(id: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/workflows/${id}`);
    if (!response.ok) return false; // 讀取暫時失敗時維持原本演練語意，不偷偷改成建圖
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
  /** 對話演練完成、等使用者核對後確認真正執行。沒有確認就絕不寫出。 */
  pendingExecution: PendingExecution | null;
  /** 只有人能提供的執行參數/帳密，直接在對話內收集；值只送設定 API，不會放進 chat 或送模型。 */
  pendingInput: PendingChatInput | null;
  /** 對話啟動的正式執行狀態。失敗後可在原地續跑或交給 AI 修，不必跳去紀錄頁。 */
  activeExecution: ChatExecutionState | null;
  /** 正式流程停在 wait-approval 時，直接在同一對話核准/拒絕。 */
  pendingApproval: PendingChatApproval | null;
  /** 外部匯入流程連演練都先要求信任來源，避免一句模糊的測試就開本機檔案/外部網站。 */
  pendingTrust: boolean;
}

/**
 * 只有 phase:"ready" 才會真的附上 pendingGraph、也才會由這裡自動掛「(下方預覽新流程，確認後按
 * 「套用」)」這句提示(見下面 phase:"ready" 分支)。但這句話一旦掛過一次，就會留在對話歷史裡被
 * 當成「AI 之前說過的話」送回模型——弱模型看得到這個句型，之後在別的 phase(尤其 phase:"clarify"，
 * 它可以自由決定要不要先描述一份完整方案再確認)有機會照樣抄一句類似的話當成自己講的，實際上
 * 那一輪根本沒有 pendingGraph 可看(2026-08 使用者實測踩到：對話文字明講「下方預覽新流程」，
 * 畫面卻完全沒有預覽卡，查證後端資料證實那一輪真的沒有存下任何 pendingGraph)。
 * phase 不是 "ready" 的訊息一律過這道濾網，寧可少一句「聽起來很像有預覽」的話，也不能讓使用者
 * 對著不存在的東西按「套用」或空等。
 */
export function stripReadyOnlyPromise(message: string): string {
  return message.replace(/[(（]\s*下方預覽新流程[，,]\s*確認後按[「"]套用[」"]\s*[)）]/g, "").replace(/[ \t]+\n/g, "\n").trim();
}
