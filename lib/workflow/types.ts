import type { Page, Browser } from "playwright";

/** 節點/觸發參數欄位定義，供產生設定表單 + 給 AI 知道有哪些參數 */
export interface ParamField {
  key: string;
  label: string;
  type: "text" | "number" | "date-or-token" | "select" | "boolean" | "secret" | "code" | "textarea";
  default?: string;
  help?: string;
  /** select 的選項；可用 "value=顯示文字" 指定顯示名 */
  options?: string[];
  /** 衍生欄位：由其他參數(如期間)自動算出，執行表單不顯示，但仍會參與解析 */
  derived?: boolean;
  /** 「留空」對這個欄位是有意義的設定(如找信節點的日期格式:留空=改用純標題搜尋)。
   * 沒標的欄位空值會被引擎自動補回預設值(防 AI 把選擇器清壞)——代價是永遠無法刻意清空;
   * 標了 allowEmpty 的欄位,明確存成空字串("")就真的是空,不會被補回預設(undefined/null 仍補)。 */
  allowEmpty?: boolean;
}

/** 一個節點在 workflow 圖裡的定義（存進 workflow json） */
export interface WorkflowNode {
  id: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** 分支節點(if/switch)用來標示走哪個 port，例如 "true"/"false"/"case-1" */
  fromPort?: string;
}

export interface Workflow {
  id: string;
  name: string;
  status: "draft" | "official";
  builtin: boolean;
  description?: string;
  longDescription?: string;
  defaultModel: string;
  requiresSecrets?: { key: string; label: string; type: "text" | "password" }[];
  triggerParams?: ParamField[];
  /** 這條流程失敗時要自動執行的備援流程(名稱或 id)。匯入時會被清空(不能讓外來檔案指揮本機流程)。 */
  onFailureWorkflow?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** 貫穿整張圖的長生資源（瀏覽器等），讓瀏覽器類節點共用同一分頁 */
export interface RunSession {
  getPage(): Promise<Page>;
  getBrowser(): Promise<Browser>;
  close(): Promise<void>;
  /** 節點逾時後呼叫：強制關掉當下分頁(讓卡住的操作立刻拋錯中止)，下一步會拿到全新分頁，不會跟逾時的殭屍操作搶同一頁 */
  resetPage(): Promise<void>;
}

/** 傳給每個節點 execute 的內容 */
export interface NodeContext {
  runId: string;
  workflowId: string;
  nodeId: string;
  input: Record<string, unknown>;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  vars: Record<string, unknown>;
  model: string;
  baseUrl: string;
  apiKey: string;
  headed: boolean;
  outputDir: string;
  debugDir: string;
  session: RunSession;
  log: (msg: string) => void;
  /** 登記一個產出檔，讓它出現在 dashboard 的檔案清單/可下載 */
  registerFile: (filename: string, filePath: string, mime: string) => void;
  /** 使用者按「⏹ 停止執行」時會 abort。cancelRequested 只在節點「之間」被檢查，對正在跑的 fetch/AI
   * 呼叫沒有效果——按停止後畫面卡在同一個節點好幾十秒是這個原因。會等待外部呼叫的節點(http-request/
   * llm-decide/custom-code 產碼)請把它接進 fetch 的 signal 或 callAIWithRetry 的 opts.signal，
   * 停止才能立刻中斷正在進行的呼叫，而不是等它自然跑完才發現要停。 */
  cancelSignal: AbortSignal;
}

/** 節點輸出的 port（分支節點會回傳多個；一般節點回一個 "out"） */
export interface NodeResult {
  /** 這個節點產生的資料，會傳給下游 */
  output: Record<string, unknown>;
  /** 分支節點指定接下來只走哪些 port；不指定=全部下游都走 */
  activePorts?: string[];
}

export interface NodeDefinition {
  type: string;
  category: "trigger" | "browser" | "data" | "file" | "integration" | "logic" | "ai" | "custom";
  label: string;
  description: string;
  icon: string;
  configSchema: ParamField[];
  /** 這個節點會輸出哪些欄位(給下游用 {{欄位}} 引用)，讓 AI 建圖時正確接線 */
  outputs?: string;
  /**
   * 這個節點執行時會用到哪些帳密欄位(依當下 config 回答，例如 browser-login 的帳密欄位名可設定)。
   * 有宣告的話，saveWorkflow 會自動把它們併進 workflow.requiresSecrets——設定頁的帳密欄位就是從
   * requiresSecrets 來的；AI 從零建的圖沒有人手動宣告，不自動推導的話使用者根本沒有地方填帳密。
   */
  secretFields?(config: Record<string, unknown>): { key: string; label: string; type: "text" | "password" }[];
  retryable: boolean;
  /** 單次執行的逾時上限(毫秒)。不設就用引擎預設(3分鐘)。repeat-steps 這種「一個節點做 N 輪工作」
   * 的容器型節點必須放寬——N 輪瀏覽器操作+第一次執行可能要產程式碼,3 分鐘必然不夠,逾時重試又整包重來。 */
  timeoutMs?: number;
  execute(ctx: NodeContext): Promise<NodeResult>;
}

/** 重跑也沒用的錯誤 → 不重試 */
export class PermanentError extends Error {}
/** 暫時性錯誤(網路/timeout) → 可重試 */
export class RetryableError extends Error {}
/** 等人簽核節點拋出：不是失敗，是「流程暫停等真人決定」。引擎收到會把 run 標成 waiting，
 * 簽核人按核准/拒絕後由 approvals 模組用續跑機制讓流程從簽核節點接著跑。 */
export class WaitingForHuman extends Error {
  approvalId: string;
  approvalMessage: string;
  constructor(approvalId: string, approvalMessage: string) {
    super(`等待簽核中：${approvalMessage.slice(0, 80)}`);
    this.approvalId = approvalId;
    this.approvalMessage = approvalMessage;
  }
}
