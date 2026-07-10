import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { getDb } from "../db";
import { getGlobalSettings, getWorkflowModel, getWorkflowSecrets, getMaxConcurrent } from "../settingsStore";
import { resolveValue, DATE_TOKENS } from "../relativeDate";
import { notifyDesktop } from "../notify";
import { getClient } from "../modelClient";
import { aiRepairNode } from "./repair";
import { createProposal } from "./fixProposals";
import { withSchemaDefaults } from "./graphLint";
import { getWorkflow } from "./store";
import { getNodeDef } from "./registry";
import { PermanentError, RetryableError } from "./types";
import type { Workflow, WorkflowNode, RunSession, NodeContext } from "./types";

// 併發上限的預設(依 CPU 推算)；實際值由「設定」的 maxConcurrent 覆寫，1=依序、>1=併行
const DEFAULT_MAX_CONCURRENT = Math.max(1, Math.min(3, os.cpus().length - 1));
export function defaultMaxConcurrent() { return DEFAULT_MAX_CONCURRENT; }
const RETRY_BACKOFF_MS = [3000, 9000];
const MAX_ATTEMPTS = 3;
const NODE_TIMEOUT_MS = 3 * 60 * 1000;

interface QueueItem {
  runId: string;
  workflowId: string;
  triggerParams: Record<string, unknown>;
  headed: boolean;
  trigger: "manual" | "schedule";
}

const queue: QueueItem[] = [];
const runningWorkflows = new Set<string>();
let activeCount = 0;

// 使用者按「⏹ 停止執行」用的狀態：cancelRequested 標記哪些 run 要停；activeSessions 讓 cancelRun
// 能直接關掉正在跑的那個瀏覽器分頁，卡住的 Playwright 操作會立刻拋錯結束；cancelSignals 則是給
// 「不靠瀏覽器分頁」的節點(http-request 的 fetch、llm-decide/custom-code 產碼的 AI 呼叫)用的中斷訊號——
// 沒有這個的話，停止只對瀏覽器操作有效，卡在一個慢 API/AI 呼叫的節點按停止會像沒反應一樣，
// 要等那個呼叫自己的逾時(可能長達 90 秒)才會真的停下來(這是使用者回報「按停止不會停」的根因)。
const cancelRequested = new Set<string>();
const activeSessions = new Map<string, RunSession>();
const cancelSignals = new Map<string, AbortController>();
/** 這次失敗是不是使用者自己按停止造成的(用來跳過失敗分類/排程失敗通知，顯示成中性的「已停止」)。
 * export 出去讓 autofix/autorun 等呼叫端能判斷「這不是真的壞掉，是使用者主動停的」，不要拿去餵 AI 修。 */
export const USER_CANCELLED = "USER_CANCELLED";
export function isUserCancelled(error: string | null | undefined): boolean {
  return error === USER_CANCELLED;
}

function log(runId: string, nodeId: string | null, line: string) {
  getDb()
    .prepare(`INSERT INTO run_logs (run_id, node_id, ts, line) VALUES (?, ?, datetime('now'), ?)`)
    .run(runId, nodeId, line);
}

function makeSession(headed: boolean): RunSession {
  let browser: Browser | null = null;
  let page: Page | null = null;
  return {
    async getBrowser() {
      if (!browser) browser = await chromium.launch({ headless: !headed });
      return browser;
    },
    async getPage() {
      if (!page) {
        const b = await this.getBrowser();
        const context = await b.newContext({ acceptDownloads: true });
        page = await context.newPage();
      }
      return page;
    },
    async resetPage() {
      const stale = page;
      page = null;
      // 關掉整個 context(不只分頁)：讓卡住的舊操作(page.click/waitForSelector等)立刻拋錯結束，不會繼續跟下一次嘗試搶同一頁
      if (stale) await stale.context().close().catch(() => {});
    },
    async close() {
      if (browser) await browser.close().catch(() => {});
      browser = null;
      page = null;
    },
  };
}

// withSchemaDefaults 移到 graphLint.ts(執行端與修復端要共用同一份「空值→預設」語意，含 allowEmpty 例外)

/** 解析 config 裡的相對日期 token（{{yesterday}} 等）；{{nodeId.field}} 等留給節點層 resolveTemplate 處理 */
function resolveDatesInConfig(config: Record<string, unknown>, now: Date): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // 從單一真相來源(DATE_TOKENS)生成，不要在這裡手寫第二份清單
  const dateTokens = new RegExp(`\\{\\{\\s*(${DATE_TOKENS.join("|")})(-\\d+)?\\s*\\}\\}`);
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "string" && dateTokens.test(v)) {
      out[k] = v.replace(new RegExp(dateTokens, "g"), (m) => resolveValue(m, now));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 拓樸排序 + 依 activePorts 決定走向的執行順序（簡化版：線性/分支，無複雜合流） */
function topoOrder(wf: Workflow): WorkflowNode[] {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const indeg = new Map(wf.nodes.map((n) => [n.id, 0]));
  for (const e of wf.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = wf.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: WorkflowNode[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) order.push(node);
    for (const e of wf.edges.filter((e) => e.from === id)) {
      const d = (indeg.get(e.to) ?? 1) - 1;
      indeg.set(e.to, d);
      if (d <= 0) queue.push(e.to);
    }
  }
  // 保底：漏掉的節點(有環或孤立)也附在後面
  for (const n of wf.nodes) if (!seen.has(n.id)) order.push(n);
  return order;
}

export function startWorkflowRun(
  workflowId: string,
  triggerParams: Record<string, unknown> = {},
  options: { headed?: boolean; trigger?: "manual" | "schedule" } = {},
): string {
  const db = getDb();
  const wf = getWorkflow(workflowId);
  if (!wf) throw new Error("workflow 不存在");
  const runId = randomUUID();
  const headed = options.headed ?? wf.status === "draft";
  const trigger = options.trigger ?? "manual";

  // owner_pid 記下「這個 run 是哪個進程在跑」——執行佇列/瀏覽器 session 全是進程內記憶體，
  // DB 裡的 running/queued 若不記進程歸屬，另一個進程(daemon + dev 同時開)開機做崩潰復原時
  // 會把「別的進程其實還在跑的 run」一起誤標失敗。見 recoverCrashedRuns。
  db.prepare(
    `INSERT INTO runs (id, workflow_id, status, trigger_type, headed, trigger_params_json, owner_pid, started_at)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, datetime('now'))`,
  ).run(runId, workflowId, trigger, headed ? 1 : 0, JSON.stringify(triggerParams), process.pid);

  for (const node of wf.nodes) {
    db.prepare(
      `INSERT INTO node_runs (run_id, node_id, status) VALUES (?, ?, 'pending')`,
    ).run(runId, node.id);
  }

  pruneRuns(workflowId);

  queue.push({ runId, workflowId, triggerParams, headed, trigger });
  processQueue();
  return runId;
}

/**
 * 使用者按「⏹ 停止執行」：
 * - 還在排隊沒開始跑 → 直接從佇列拿掉，標記失敗(已停止)，不會真的跑起來。
 * - 已經在跑 → 標記 cancelRequested，並強制關掉目前的分頁讓卡住的操作立刻結束；
 *   執行迴圈會在下一個檢查點(每個節點開始前，以及被強制中斷的那個節點)發現並乾淨結束。
 * 回傳 false 代表這個 run 已經結束了，沒有東西可以停。
 */
// runId → 停止的「原因文字」。cancelRun 不只使用者按停止會呼叫——runWorkflowAndWait 的時間預算逾時
// 也會呼叫來真的停掉引擎。不區分原因的話，逾時停止的 run 紀錄會寫成「使用者手動停止」(使用者明明沒按，
// 紀錄卻說是他停的，誤導排查方向)。只影響紀錄顯示，錯誤碼仍統一用 USER_CANCELLED 走同一條停止路徑。
const cancelCause = new Map<string, string>();

export function cancelRun(runId: string, cause?: string): boolean {
  const db = getDb();
  const queuedIdx = queue.findIndex((q) => q.runId === runId);
  if (queuedIdx !== -1) {
    queue.splice(queuedIdx, 1);
    db.prepare(
      `UPDATE runs SET status='failed', error=?, reason=?, resolution='needs-human', finished_at=datetime('now') WHERE id=?`,
    ).run(USER_CANCELLED, cause ?? "使用者手動停止了這次執行(還沒開始跑就被取消)。", runId);
    // 這個 run 的節點還全是 'pending'(startWorkflowRun 預先插的)，標成 skipped 免得紀錄畫面一直卡在等待中
    db.prepare(`UPDATE node_runs SET status='skipped' WHERE run_id=? AND status='pending'`).run(runId);
    notifyFinished(runId);
    return true;
  }
  const row = db.prepare(`SELECT status FROM runs WHERE id = ?`).get(runId) as { status: string } | undefined;
  if (!row || (row.status !== "running" && row.status !== "queued")) return false; // 已經結束了
  if (cause) cancelCause.set(runId, cause);
  cancelRequested.add(runId);
  activeSessions.get(runId)?.resetPage().catch(() => {});
  cancelSignals.get(runId)?.abort(); // 中斷正在進行中的 fetch/AI 呼叫(見上方 cancelSignals 註解)
  return true;
}

// runId → 完成時要通知的 callback，讓「自動修復」可以 await 一次執行跑完
const completions = new Map<string, { resolve: (r: RunFinal) => void; timer: ReturnType<typeof setTimeout> }>();
export interface RunFinal {
  runId: string;
  status: "success" | "failed";
  failedNode: string | null;
  error: string | null;
  /**
   * 執行過程中「{{變數}} 沒對應到資料」的警告數。status='success' 但這個 >0 = 表面綠、
   * 實際產出可能是垃圾(檔名/內容字面殘留 {{...}})——自動修復迴圈的收斂判準必須是
   * 「成功且 varWarnings===0」，不能只看 status，否則會把走樣的結果蓋章成功收工。
   */
  varWarnings: number;
}

/** 這次執行有幾個 {{變數}} 沒解析到 + 分別發生在哪些節點(給修復迴圈當「該修哪裡」的線索) */
export function getVarWarnings(runId: string): { count: number; nodes: { nodeId: string; line: string }[] } {
  const db = getDb();
  const rows = db
    .prepare(`SELECT node_id, line FROM run_logs WHERE run_id = ? AND line LIKE '%沒對應到上游資料%'`)
    .all(runId) as { node_id: string | null; line: string }[];
  return { count: rows.length, nodes: rows.filter((r) => r.node_id).map((r) => ({ nodeId: r.node_id!, line: r.line })) };
}

function notifyFinished(runId: string) {
  const entry = completions.get(runId);
  if (entry) {
    completions.delete(runId);
    clearTimeout(entry.timer); // 一定清掉逾時保險計時器，不然每個 run 都會讓 process 多掛一個計時器到期
    const db = getDb();
    const r = db.prepare(`SELECT status, error, failed_node FROM runs WHERE id = ?`).get(runId) as
      | { status: string; error: string | null; failed_node: string | null }
      | undefined;
    entry.resolve({
      runId,
      status: (r?.status as "success" | "failed") ?? "failed",
      failedNode: r?.failed_node ?? null,
      error: r?.error ?? null,
      varWarnings: getVarWarnings(runId).count,
    });
  }
}

// 保險逾時上限：單一節點最壞情況(逾時180s×3次嘗試+重試等待) ≈ 9.2 分鐘，多節點/多次重試疊加很容易超過舊的 10 分鐘，
// 導致引擎其實還在跑、呼叫端卻已經當作失敗結束(autorun/autofix 因此提前放棄或疊加新的一輪執行)。拉高到 25 分鐘給足空間。
const RUN_WAIT_TIMEOUT_MS = 25 * 60 * 1000;

/** 觸發一次執行並等它跑完，回傳最終結果(給自動修復迴圈用) */
export function runWorkflowAndWait(
  workflowId: string,
  triggerParams: Record<string, unknown>,
  options: { headed?: boolean; timeoutMs?: number } = {},
): Promise<RunFinal> {
  const runId = startWorkflowRun(workflowId, triggerParams, { headed: options.headed, trigger: "manual" });
  // 呼叫端(autofix 的總時間預算)可以給更短的上限，但不能超過引擎預設的天花板
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? RUN_WAIT_TIMEOUT_MS, 10_000), RUN_WAIT_TIMEOUT_MS);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (completions.has(runId)) {
        completions.delete(runId);
        // 逾時不能只是回報失敗——引擎其實還在跑，呼叫端(autofix/autorun)收到失敗會再疊一輪新的執行，
        // 新舊兩輪對真實系統(webmail 登入、下載)形成非預期的連續操作。直接把這個 run 停掉。
        // 帶明確原因：這是「時間預算用完的系統停止」，紀錄不能寫成「使用者手動停止」(使用者根本沒按)。
        cancelRun(runId, "執行時間超過上限，系統自動停止了這次執行(不是手動停止)。");
        resolve({ runId, status: "failed", failedNode: null, error: "執行逾時", varWarnings: 0 });
      }
    }, timeoutMs);
    completions.set(runId, { resolve, timer });
  });
}

const KEEP_RUNS = 20;

/**
 * 每個 workflow 只保留最近 20 筆「已結束」的執行紀錄，舊的連同 node_runs/logs/除錯截圖一起清掉，避免無限長大。
 * 只看 status IN ('success','failed')：正在跑(running/queued)的絕不能被排進去刪，
 * 不然執行到一半紀錄被砍會讓那次執行的後續 UPDATE 變成空操作、最後被誤判失敗。
 */
function pruneRuns(workflowId: string) {
  const db = getDb();
  const old = db
    .prepare(
      `SELECT id FROM runs WHERE workflow_id = ? AND status IN ('success','failed')
       ORDER BY started_at DESC LIMIT -1 OFFSET ?`,
    )
    .all(workflowId, KEEP_RUNS) as { id: string }[];
  for (const { id } of old) {
    db.prepare(`DELETE FROM node_runs WHERE run_id = ?`).run(id);
    db.prepare(`DELETE FROM run_logs WHERE run_id = ?`).run(id);
    // 產出檔紀錄與檔案要跟著 run 一起清。以前是「有登記成 run_files 的檔就保留」，結果 run_files 列
    // 永遠不刪 → 開機的 pruneOrphanOutputs 又規定 run_files 還在就不清資料夾 → 每天跑的排程流程
    // 幾個月下來 data/outputs 無上限累積灌爆磁碟。保留策略統一成「最近 20 筆 run 的檔案」：
    // 檔案的主要去處本來就是流程自己送到桌面/指定位置，data/outputs 只是給「下載」按鈕用的副本。
    db.prepare(`DELETE FROM run_files WHERE run_id = ?`).run(id);
    db.prepare(`DELETE FROM runs WHERE id = ?`).run(id);
    fs.rmSync(path.join(process.cwd(), "data", "runs", id), { recursive: true, force: true }); // 除錯截圖
    fs.rmSync(path.join(process.cwd(), "data", "outputs", id), { recursive: true, force: true });
  }
}

/**
 * 開機清一次孤兒產出資料夾：data/outputs 底下若有某個 runId 資料夾，但 runs 表已經沒有這個 run
 * (被 pruneRuns 刪掉紀錄卻沒清資料夾的舊資料)，就整個刪掉，釋放磁碟。
 */
export function pruneOrphanOutputs() {
  const db = getDb();
  // 舊版 pruneRuns 刪 run 時沒有連 run_files 一起刪，遺留大量指向已刪除 run 的孤兒列——
  // 先把這些列清掉，下面的資料夾清理才不會被「還有 run_files 在引用」擋住。
  db.prepare(`DELETE FROM run_files WHERE run_id NOT IN (SELECT id FROM runs)`).run();
  const outputsRoot = path.join(process.cwd(), "data", "outputs");
  if (!fs.existsSync(outputsRoot)) return;
  for (const runId of fs.readdirSync(outputsRoot)) {
    const exists = db.prepare(`SELECT 1 FROM runs WHERE id = ?`).get(runId);
    if (!exists) fs.rmSync(path.join(outputsRoot, runId), { recursive: true, force: true });
  }
}

/**
 * 把失敗原因分類。category 比 resolution 更細，給草稿自動測試迴圈判斷用：
 *   - "credentials"/"data"：真的需要人補資料，AI 改設定也沒用 → 直接請使用者處理。
 *   - "ai-fixable"：選擇器/逾時/元素等，AI 看截圖可自動修。
 *   - "unknown"：無法歸類。UI 上仍顯示成 needs-human(較安全)，但自動測試迴圈會「至少讓 AI 試一次」，
 *     因為很多 Playwright 英文錯誤(Target closed / net::ERR…)其實是選擇器/暫時性問題，值得讓 AI 看一眼。
 */
export type FailureCategory = "credentials" | "data" | "ai-fixable" | "unknown";
export function classifyFailure(error: string): { reason: string; resolution: "ai-fixable" | "needs-human"; category: FailureCategory } {
  const e = error || "未知錯誤";
  // ① 帳號/密碼類最優先當「需人工」——AI 無法憑空生出正確帳密，重試也沒用，直接請使用者處理。
  //    (但要排除「認證資訊檢查失敗」這種驗證碼打錯也會出現的通用訊息——那個歸 ai-fixable)
  if (/帳號.{0,4}密碼.{0,4}錯誤|密碼錯誤|帳號不存在|使用者不存在|帳號已被停用|帳號已鎖定|尚未.*填.*帳|沒有設定.*帳|請到設定.*帳|未設定.*帳|尚未填入|[Tt]oken 不正確|不正確\(API 回 401\)/.test(e)) {
    return { reason: `${e}｜需人工：請到「設定」頁確認並填入正確的帳號密碼後重跑。`, resolution: "needs-human", category: "credentials" };
  }
  // ② 結構性/技術性問題 → AI 可修。這一類要排在「資料確認」前面判斷，因為它們的訊息裡也常含「請確認」，
  //    但真正的原因是流程邏輯/選擇器/資料接法(AI 改得動)，不是使用者要提供的值。
  //    特別是「{{變數}} 沒解析到/上游沒產出」這種資料流問題——原因在上游節點，整圖修復改得掉。
  if (/沒有解析到實際資料|上游節點|還沒有內容|還沒有程式碼|自訂步驟|程式碼.*錯誤|語法|選擇器|selector|逾時|超過|timeout|驗證碼|認證資訊檢查失敗|找不到.*元素|找不到搜尋框|element|網路|網絡|503|下載/i.test(e)) {
    return { reason: `${e}｜AI 可修：多半是流程邏輯、資料接法或網頁選擇器的問題，AI 會看整條流程+截圖自動修。`, resolution: "ai-fixable", category: "ai-fixable" };
  }
  // ③ 真的是「使用者要確認的值」(某封信不存在/報表名稱/日期輸入)才歸需人工——但自動測試迴圈仍會先讓 AI 試一次
  //    (整圖修復可能發現是上游把搜尋條件算錯了)，試過還是這類錯誤才真的停下來問使用者。
  if (/找不到.*信|搜尋不到.*信|查無|報表名稱|沒有寄|該日期.*沒有|這天.*沒有/.test(e)) {
    return { reason: `${e}｜可能需人工：請確認日期、報表名稱等輸入是否正確；AI 也會先試著看是不是上游把搜尋條件算錯了。`, resolution: "needs-human", category: "data" };
  }
  // 預設：先讓 AI 試(很多 Playwright 英文錯誤其實是選擇器/暫時性問題)
  return { reason: `${e}｜先讓 AI 試修：看整條流程與截圖找原因。`, resolution: "ai-fixable", category: "unknown" };
}

/**
 * 正式流程的排程執行失敗時，在背景讓 AI 想一個修法(不套用、不重跑，只是先想好)，存成提案讓使用者
 * 開網頁時能一鍵套用+重跑。這是「AI 看守正式流程」的核心：使用者不用自己發現問題、自己去點「讓 AI 修」，
 * 醒來就有現成的答案在等他確認。
 * 之前已經先發過「AI 正在想辦法修…」的通知，所以這裡若失敗(模型掛掉/沒金鑰)必須「補一則通知告訴使用者沒能修」，
 * 不然使用者被告知 AI 在想辦法卻永遠等不到下文。也設 5 分鐘上限，避免背景 promise 掛著不放記憶體。
 */
async function proposeFixInBackground(workflowId: string, runId: string, nodeId: string, nodeLabel: string, error: string) {
  const wf = getWorkflow(workflowId);
  if (!wf) return;
  try {
    const client = getClient();
    const model = getWorkflowModel(workflowId, wf.defaultModel);
    const edit = await Promise.race([
      aiRepairNode(client, model, workflowId, nodeId, error, runId, false),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("想修法逾時")), 5 * 60 * 1000)),
    ]);
    createProposal({ runId, workflowId, nodeId, nodeLabel, error, before: edit.before, after: edit.config });
    notifyDesktop(`「${wf.name}」AI 已經想好修法`, `「${nodeLabel}」這步，打開 Agent Hub 看一鍵套用+重跑。`);
  } catch {
    notifyDesktop(`「${wf.name}」AI 沒能自動想出修法`, `請打開 Agent Hub，到「${nodeLabel}」這步手動按「🔧 讓 AI 修」。`);
  }
}

function processQueue() {
  if (activeCount >= getMaxConcurrent(DEFAULT_MAX_CONCURRENT)) return;
  const idx = queue.findIndex((q) => !runningWorkflows.has(q.workflowId));
  if (idx === -1) return;
  const [item] = queue.splice(idx, 1);
  runningWorkflows.add(item.workflowId);
  activeCount++;
  executeWorkflow(item).finally(() => {
    runningWorkflows.delete(item.workflowId);
    activeCount--;
    processQueue();
  });
}

async function runNodeWithRetry(node: WorkflowNode, ctx: NodeContext, retryable: boolean) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= (retryable ? MAX_ATTEMPTS : 1); attempt++) {
    if (attempt > 1) {
      ctx.log(`第 ${attempt} 次重試`);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt - 2] ?? 9000));
    }
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    // 個別接住 execute() 的 promise：Promise.race 逾時後這個 promise 還可能在背景繼續跑，
    // 之後(被 resetPage 關頁面)拋錯時若沒人接住會變成 unhandledRejection 讓整個 process 崩潰
    const nodeDef = getNodeDef(node.type)!;
    // 容器型節點(repeat-steps 一個節點做 N 輪工作)可以宣告自己的逾時上限,其餘用引擎預設
    const timeoutMs = nodeDef.timeoutMs ?? NODE_TIMEOUT_MS;
    const execPromise = nodeDef.execute(ctx);
    execPromise.catch(() => {});
    try {
      const result = await Promise.race([
        execPromise,
        new Promise<never>((_, rej) => {
          timeoutId = setTimeout(() => { timedOut = true; rej(new RetryableError(`節點執行超過 ${timeoutMs / 1000} 秒`)); }, timeoutMs);
        }),
      ]);
      return { result, attempt };
    } catch (err) {
      lastErr = err;
      if (timedOut) {
        // 逾時的那次操作可能還在背景跑(Playwright 沒有真正的取消)。強制關掉分頁讓它立刻拋錯結束，
        // 下一次重試會拿到全新分頁，不會跟殭屍操作同時搶同一頁(避免出現隨機、難重現的失敗)。
        await ctx.session.resetPage().catch(() => {});
      }
      if (err instanceof PermanentError) throw err;
      if (ctx.cancelSignal.aborted) throw err; // 使用者按了停止——別浪費重試次數重打一個注定失敗的呼叫
      if (!retryable) throw err;
    } finally {
      // 節點成功(或失敗)後一定清掉逾時計時器，不然每個節點留一個存活 3 分鐘的 timer，
      // 長流程累積一堆、也拖延伺服器優雅關機
      clearTimeout(timeoutId);
    }
  }
  throw lastErr;
}

async function executeWorkflow(item: QueueItem) {
  const db = getDb();
  const { runId, workflowId, triggerParams, headed, trigger } = item;
  const wf = getWorkflow(workflowId);
  if (!wf) {
    db.prepare(`UPDATE runs SET status='failed', error='找不到 workflow(可能已被刪除)', finished_at=datetime('now') WHERE id=?`).run(runId);
    if (trigger === "schedule") notifyDesktop("Agent Hub 排程失敗", "排程的流程已被刪除，執行取消");
    notifyFinished(runId);
    return;
  }

  db.prepare(`UPDATE runs SET status = 'running' WHERE id = ?`).run(runId);
  const { baseUrl, apiKey } = getGlobalSettings();
  const model = getWorkflowModel(workflowId, wf.defaultModel);
  const secrets = getWorkflowSecrets(workflowId);
  const session = makeSession(headed);
  activeSessions.set(runId, session); // 讓 cancelRun() 找得到這個 run 的分頁，能立刻強制中斷
  const abortController = new AbortController();
  cancelSignals.set(runId, abortController); // 讓 cancelRun() 能中斷不靠瀏覽器分頁的 fetch/AI 呼叫
  const outputDir = path.join(process.cwd(), "data", "outputs", runId);
  const debugDir = path.join(process.cwd(), "data", "runs", runId);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(debugDir, { recursive: true });

  const vars: Record<string, unknown> = {};
  const nodeOutputs = new Map<string, Record<string, unknown>>();
  // trigger 參數(相對日期已在觸發時解析)當作 trigger 節點的 input 種子
  nodeOutputs.set("__trigger__", triggerParams);

  const order = topoOrder(wf);
  const skipped = new Set<string>();
  // 記錄每個「有分支」的節點實際選中的 activePorts，用來判斷某條 edge 是不是「死掉」的分支——
  // 一條 edge 死掉，代表 from 節點被 skip、或它是有標 port 但沒被選中的那條分支。
  const nodeActivePorts = new Map<string, string[]>();
  // 這條 edge 是不是死的(不會有資料流過)：來源被 skip、或來源有分支且這條的 fromPort 沒被選中。
  const isEdgeDead = (e: { from: string; fromPort?: string }): boolean => {
    if (skipped.has(e.from)) return true;
    const ap = nodeActivePorts.get(e.from);
    return !!(ap && e.fromPort && !ap.includes(e.fromPort));
  };
  let failed = false;
  let failError = "";
  let failedNode = "";
  let failedNodeLabel = "";
  let successCount = 0;

  const now = new Date();

  // 把「要跳過的節點」的下游也一起標記跳過(分支的整條路徑，不只直接下游)
  const skipDownstream = (fromId: string) => {
    const queue = [fromId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of wf.edges.filter((ed) => ed.from === cur)) {
        // 只有當一個節點的所有上游都被跳過，才跳過它(有其他活著的上游就留著)
        const parents = wf.edges.filter((ed) => ed.to === e.to).map((ed) => ed.from);
        if (parents.every((p) => skipped.has(p)) && !skipped.has(e.to)) {
          skipped.add(e.to);
          queue.push(e.to);
        }
      }
    }
  };

  try {
  for (const node of order) {
    if (cancelRequested.has(runId)) {
      // 使用者按了停止：這個節點還沒開始跑就中止，不算它失敗，只是標記整條 run 是「被停止」
      failed = true;
      failError = USER_CANCELLED;
      failedNode = node.id;
      failedNodeLabel = node.label;
      db.prepare(`UPDATE node_runs SET status='skipped' WHERE run_id=? AND node_id=?`).run(runId, node.id);
      break;
    }
    if (skipped.has(node.id)) {
      db.prepare(`UPDATE node_runs SET status='skipped' WHERE run_id=? AND node_id=?`).run(runId, node.id);
      continue;
    }
    const def = getNodeDef(node.type);
    if (!def) {
      failed = true;
      failError = `未知節點型別：${node.type}`;
      failedNode = node.id;
      failedNodeLabel = node.label;
      db.prepare(`UPDATE node_runs SET status='failed', error=? WHERE run_id=? AND node_id=?`).run(failError, runId, node.id);
      break;
    }

    // input = 所有上游節點的 output merge（trigger 節點吃 triggerParams）
    const upstreamIds = wf.edges.filter((e) => e.to === node.id).map((e) => e.from);
    const input: Record<string, unknown> = {};
    if (node.type === "trigger") Object.assign(input, triggerParams);
    for (const uid of upstreamIds) Object.assign(input, nodeOutputs.get(uid) ?? {});
    // 也把 trigger 參數一路帶著方便引用(只補 input 還沒有的 key，上游算出的值優先)
    for (const [k, v] of Object.entries(triggerParams)) if (!(k in input)) input[k] = v;

    db.prepare(`UPDATE node_runs SET status='running', input_json=?, started_at=datetime('now') WHERE run_id=? AND node_id=?`)
      .run(JSON.stringify(input), runId, node.id);
    log(runId, node.id, `[${node.label}] 開始`);

    const ctx: NodeContext = {
      runId,
      workflowId,
      nodeId: node.id,
      input,
      config: resolveDatesInConfig(withSchemaDefaults(node.config, def.configSchema), now),
      secrets,
      vars,
      model,
      baseUrl,
      apiKey,
      headed,
      outputDir,
      debugDir,
      session,
      cancelSignal: abortController.signal,
      log: (msg: string) => log(runId, node.id, msg),
      registerFile: (filename, filePath, mime) => {
        let size = 0;
        try {
          size = fs.statSync(filePath).size;
        } catch {}
        db.prepare(
          `INSERT INTO run_files (run_id, workflow_id, filename, path, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        ).run(runId, workflowId, filename, filePath, mime, size);
      },
    };

    try {
      const { result, attempt } = await runNodeWithRetry(node, ctx, def.retryable);
      // 存進 nodeOutputs 的是「這個節點收到的 input + 它自己新增的欄位」，不是單純 result.output——
      // 這樣任何下游節點(不管中間隔了幾個節點)都能繼續用 {{欄位}} 引用更早以前算出來的資料。
      // 之前每個內建節點的 output 只回自己新增的那幾個欄位(只有 trigger/custom-code 手動 {...ctx.input})，
      // 資料經過 browser-login/find-email 這類節點就會不見——這正是「上游算好的日期，中間繞過一個節點
      // 就消失、下游拿到的是原封不動的 {{欄位}} 字面文字」的真實根因。改在這個唯一存放輸出的地方統一處理，
      // 不用去每個節點檔案裡各自補 spread、以後新增節點型別也不會漏。
      nodeOutputs.set(node.id, { ...input, ...result.output });
      successCount++;
      db.prepare(`UPDATE node_runs SET status='success', output_json=?, attempt=?, finished_at=datetime('now') WHERE run_id=? AND node_id=?`)
        .run(JSON.stringify(result.output), attempt, runId, node.id);
      log(runId, node.id, `[${node.label}] 完成`);

      // 分支：只走 activePorts 指定的下游，其餘整條標記 skip。
      // 只有「明確標了 port、但這個 port 沒被選中」才跳過；edge.fromPort 完全沒填(AI 建圖忘記標/舊資料)
      // 一律當作「留著跑」而不是預設塞一個永遠不會命中的 "out" ——不然一個缺欄位就會讓 if 節點的
      // 兩條分支全部靜默跳過、下游整條都不執行，run 卻還回報「成功」，是最難被使用者發現的那種 bug。
      if (result.activePorts) {
        nodeActivePorts.set(node.id, result.activePorts);
        const outEdges = wf.edges.filter((e) => e.from === node.id);
        for (const e of outEdges) {
          if (e.fromPort && !result.activePorts.includes(e.fromPort)) {
            // 不能無條件 skip e.to：菱形圖裡 false 分支和另一條活著的路徑可能都連到同一個匯流節點，
            // 走 true 時若把匯流節點也 skip，它該做的事就沒做卻回報成功(最難發現的假成功)。
            // 比照 skipDownstream 的邏輯：只有當 e.to 的「每一條上游 edge 都死了」才 skip 它——
            // 只要還有一條活著的上游就保留(它會等那條上游跑完再執行)。
            const inEdgesAllDead = wf.edges.filter((ed) => ed.to === e.to).every(isEdgeDead);
            if (inEdgesAllDead && !skipped.has(e.to)) {
              skipped.add(e.to);
              skipDownstream(e.to);
            }
          }
        }
      }
    } catch (err) {
      failed = true;
      // 這個節點若是被 cancelRun() 強制關頁面才拋錯的(使用者按了停止)，不要顯示 Playwright 那句
      // 難懂的英文錯誤(如 "Target page, context or browser has been closed")，改顯示清楚的中文原因
      failError = cancelRequested.has(runId) ? USER_CANCELLED : err instanceof Error ? err.message : String(err);
      failedNode = node.id;
      failedNodeLabel = node.label;
      db.prepare(`UPDATE node_runs SET status='failed', error=?, finished_at=datetime('now') WHERE run_id=? AND node_id=?`)
        .run(failError, runId, node.id);
      log(runId, node.id, `[${node.label}] 失敗：${failError}`);
      break;
    }
  }
  } catch (err) {
    // 節點迴圈外的意外例外(不該發生，但保底)：標記失敗，避免 run 卡在 running
    failed = true;
    failError = err instanceof Error ? err.message : String(err);
    log(runId, null, `❌ 執行引擎意外錯誤：${failError}`);
  } finally {
    await session.close().catch(() => {}); // 一定關瀏覽器，避免 Chromium 殘留
    activeSessions.delete(runId);
    cancelSignals.delete(runId);
    cancelRequested.delete(runId); // 避免這個 Set 隨著跑過的 run 數量無限長大
    // cancelCause 不能在這裡刪——下面 USER_CANCELLED 收尾分支還要讀它(finally 先於那段執行)
  }

  if (failed && failError === USER_CANCELLED) {
    // 有指定停止原因(如時間預算逾時)就用它，沒有才是真的使用者手動停止
    const cause = cancelCause.get(runId);
    cancelCause.delete(runId);
    const reason = cause ?? (failedNodeLabel ? `使用者在「${failedNodeLabel}」這步手動停止了執行。` : "使用者手動停止了這次執行。");
    db.prepare(`UPDATE runs SET status='failed', error=?, reason=?, resolution='needs-human', failed_node=?, finished_at=datetime('now') WHERE id=?`)
      .run(failError, reason, failedNode || null, runId);
    log(runId, null, "⏹ 已停止執行");
  } else if (failed) {
    const { reason, resolution } = classifyFailure(failError);
    const fullReason = failedNodeLabel ? `在「${failedNodeLabel}」這步失敗：${reason}` : reason;
    db.prepare(`UPDATE runs SET status='failed', error=?, reason=?, resolution=?, failed_node=?, finished_at=datetime('now') WHERE id=?`)
      .run(failError, fullReason, resolution, failedNode || null, runId);
    log(runId, null, `❌ 執行失敗：${fullReason}`);
    // 排程觸發的失敗一定要主動通知——這是無人值守的排程唯一能讓使用者知道「沒跑成功」的管道，不然只能自己想到才會去開網頁看
    if (trigger === "schedule") {
      if (resolution === "ai-fixable" && wf.status === "official" && failedNode) {
        // 正式流程排程失敗且看起來 AI 修得好：在背景讓 AI 想一個修法提案(不自動套用，不影響正式在跑的設定)，
        // 想好之後通知裡順便講一句「AI 已經想好怎麼修」，使用者開網頁就能一鍵套用+重跑，不用自己動手找問題。
        notifyDesktop(`「${wf.name}」排程執行失敗`, `${fullReason.slice(0, 150)}｜AI 正在想辦法修…`);
        proposeFixInBackground(workflowId, runId, failedNode, failedNodeLabel, failError).catch(() => {});
      } else {
        notifyDesktop(`「${wf.name}」排程執行失敗`, fullReason.slice(0, 200));
      }
    }
  } else {
    // 「全綠」不等於「結果正確」——最陰險的走樣是 {{變數}} 沒對應到資料、字面留在檔名/內容裡
    // (cfgStr 刻意只警告不拋錯，見 nodeHelpers)。這種執行技術上成功、產出卻是垃圾，
    // 若總結只寫「執行成功」使用者根本不會發現。把警告數浮上來，讓人一眼看到該去檢查。
    const varWarnings = getVarWarnings(runId).count;
    const reason =
      `執行成功，完成 ${successCount} 個步驟。` +
      (varWarnings > 0 ? `⚠️ 但有 ${varWarnings} 個設定裡的 {{變數}} 沒有對應到資料，可能讓檔名或內容出現 {{...}} 字樣——請檢查產出結果，不對就在對話裡跟 AI 說。` : "");
    db.prepare(`UPDATE runs SET status='success', reason=?, finished_at=datetime('now') WHERE id=?`).run(reason, runId);
    log(runId, null, varWarnings > 0 ? `✅ 執行完成(有 ${varWarnings} 個變數警告，見上方紀錄)` : "✅ 執行完成");
    if (trigger === "schedule") notifyDesktop(`「${wf.name}」排程執行完成`, reason);
  }
  cancelCause.delete(runId); // 讀過(或沒用到)都要清，避免 Map 隨 run 數量無限長大
  notifyFinished(runId); // 一定通知等待者(runWorkflowAndWait)，不會讓 promise 卡住
}

/** 這個 pid 的進程現在還活著嗎？(signal 0 不會真的送信號，只檢查存在；EPERM 代表存在但無權限) */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function recoverCrashedRuns() {
  const db = getDb();
  const stuck = db.prepare(`SELECT id, owner_pid FROM runs WHERE status IN ('running','queued')`).all() as {
    id: string;
    owner_pid: number | null;
  }[];
  if (stuck.length === 0) return;
  // 不能無條件把所有 running/queued 標失敗——同一顆 DB 可能有兩個進程(daemon 常駐 + 使用者又開 dev)，
  // 本進程剛啟動不代表別的進程沒有正在跑的 run(Playwright 正在操作真實 webmail)。
  // 只回收「歸屬進程已經死掉」的殭屍：owner_pid 是本進程(pid 重用到自己=前世遺留)、是 null(舊版資料)、
  // 或該 pid 已不存在。別的活進程正在跑的，留給它自己收尾。
  const dead = stuck.filter((r) => r.owner_pid === null || r.owner_pid === process.pid || !isPidAlive(r.owner_pid));
  if (dead.length === 0) return;
  const markFailed = db.prepare(
    `UPDATE runs SET status='failed', error='引擎重啟，這次執行中斷', reason='引擎(程式)重新啟動導致這次執行中斷｜需人工：直接重跑一次即可。', resolution='needs-human', finished_at=datetime('now') WHERE id=?`,
  );
  const markNodes = db.prepare(`UPDATE node_runs SET status='failed', error='引擎重啟中斷' WHERE status IN ('running','pending') AND run_id=?`);
  for (const { id } of dead) {
    markFailed.run(id);
    markNodes.run(id);
    log(id, null, "❌ 引擎重啟，這次執行中斷");
  }
}

export function getRun(runId: string) {
  const db = getDb();
  const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId);
  const nodeRuns = db.prepare(`SELECT * FROM node_runs WHERE run_id = ? ORDER BY id ASC`).all(runId);
  return { run, nodeRuns };
}

export function getRunLogs(runId: string, afterId = 0) {
  const db = getDb();
  return db.prepare(`SELECT id, node_id, ts, line FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id ASC`).all(runId, afterId);
}

export function listRuns(workflowId: string) {
  const db = getDb();
  return db.prepare(`SELECT * FROM runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 20`).all(workflowId);
}
