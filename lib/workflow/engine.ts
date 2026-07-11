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
import { getWorkflow, findWorkflowByRef } from "./store";
import { getNodeDef } from "./registry";
import { PermanentError, RetryableError, WaitingForHuman } from "./types";
import type { Workflow, WorkflowNode, RunSession, NodeContext } from "./types";

// 併發上限的預設(依 CPU 推算)；實際值由「設定」的 maxConcurrent 覆寫，1=依序、>1=併行
const DEFAULT_MAX_CONCURRENT = Math.max(1, Math.min(3, os.cpus().length - 1));
export function defaultMaxConcurrent() { return DEFAULT_MAX_CONCURRENT; }
const RETRY_BACKOFF_MS = [3000, 9000];
const MAX_ATTEMPTS = 3;
const NODE_TIMEOUT_MS = 3 * 60 * 1000;

/** manual=使用者按執行；其餘都是無人值守的自動觸發(結果要靠桌面通知讓人知道) */
export type TriggerSource = "manual" | "schedule" | "watch" | "webhook" | "form" | "error";
const TRIGGER_LABEL: Record<TriggerSource, string> = { manual: "手動", schedule: "排程", watch: "資料夾監聽", webhook: "Webhook", form: "表單", error: "錯誤觸發" };

/** 續跑規格：從某個節點接著跑，之前成功的節點沿用結果不重跑(修好一步不用整條從頭來、簽核恢復也靠它) */
export interface ResumeSpec {
  /** nodeId → 上次的合併輸出({...input,...output})，沿用節點直接拿這份餵下游 */
  seeds: Record<string, Record<string, unknown>>;
  /** 沿用節點上次選中的分支 port(if/switch)，續跑時要重放否則下游分支邏輯全失效 */
  seedPorts: Record<string, string[]>;
  /** 要重新執行的節點(失敗那步+它的下游+需要瀏覽器狀態的上游鏈) */
  rerunNodeIds: string[];
  /** 簽核恢復用：這個節點不執行，直接視為成功、輸出指定資料並走指定分支 */
  preResolved?: { nodeId: string; output: Record<string, unknown>; activePort?: string };
}

interface QueueItem {
  runId: string;
  workflowId: string;
  triggerParams: Record<string, unknown>;
  headed: boolean;
  trigger: TriggerSource;
  resume?: ResumeSpec;
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
  options: { headed?: boolean; trigger?: TriggerSource } = {},
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
 * 續跑：同一筆 run 從「失敗(或等簽核)的那個節點」接著跑，之前成功的節點沿用上次結果不重跑。
 * 這是兩個功能的共同地基：①長流程修好一步後不用整條從頭來(登入/搜信/下載都不用重做)；
 * ②等人簽核——簽核人按核准/拒絕後，用 preResolved 讓簽核節點直接帶結果走對應分支繼續。
 *
 * 誠實邊界：需要瀏覽器狀態的節點(登入後才能搜信/下載)沒辦法沿用——瀏覽器早就關了。
 * 重跑清單會自動把「要重跑的瀏覽器類節點」的上游瀏覽器鏈(登入等)一併排進去重跑，
 * 並在紀錄裡講明，不會假裝登入狀態還在。
 */
export function resumeRun(
  runId: string,
  opts: { preResolved?: ResumeSpec["preResolved"]; headed?: boolean } = {},
): { ok: boolean; error?: string } {
  const db = getDb();
  const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as
    | { id: string; workflow_id: string; status: string; failed_node: string | null; trigger_type: string; headed: number; trigger_params_json: string | null }
    | undefined;
  if (!run) return { ok: false, error: "找不到這次執行紀錄(可能已被自動清理)，請直接重新執行。" };
  const wf = getWorkflow(run.workflow_id);
  if (!wf) return { ok: false, error: "這條流程已被刪除。" };
  if (run.status === "running" || run.status === "queued") return { ok: false, error: "這次執行還在跑，不能續跑。" };
  if (run.status === "waiting" && !opts.preResolved) return { ok: false, error: "這次執行停在等簽核——請由簽核頁按核准/拒絕，它會自己繼續。" };
  if (run.status === "success" && !opts.preResolved) return { ok: false, error: "這次執行已經成功了，不需要續跑。" };

  const startNodeId = opts.preResolved?.nodeId ?? run.failed_node;
  if (!startNodeId) return { ok: false, error: "這次執行沒有記錄到失敗在哪一步，請直接重新執行。" };
  if (!wf.nodes.some((n) => n.id === startNodeId)) {
    return { ok: false, error: "當初失敗的那一步已經不在流程裡(圖改過了)，請直接重新執行整條流程。" };
  }

  // ── 上次的成果：成功節點的合併輸出 + 它們選過的分支 ──
  const rows = db
    .prepare(`SELECT node_id, status, input_json, output_json, active_ports FROM node_runs WHERE run_id = ?`)
    .all(runId) as { node_id: string; status: string; input_json: string | null; output_json: string | null; active_ports: string | null }[];
  const parse = (s: string | null): Record<string, unknown> => {
    try { return s ? (JSON.parse(s) as Record<string, unknown>) : {}; } catch { return {}; }
  };
  const seeds: Record<string, Record<string, unknown>> = {};
  const seedPorts: Record<string, string[]> = {};
  const nodeTypeById = new Map(wf.nodes.map((n) => [n.id, n.type]));
  for (const r of rows) {
    if (r.status === "success") {
      seeds[r.node_id] = { ...parse(r.input_json), ...parse(r.output_json) };
      if (r.active_ports) {
        try { seedPorts[r.node_id] = JSON.parse(r.active_ports) as string[]; } catch { /* 壞資料當沒有 */ }
      } else {
        // 舊資料沒存 active_ports：分支節點從輸出反推(if 的 result / switch 的 matched)，反推不出就不放
        const out = parse(r.output_json);
        const t = nodeTypeById.get(r.node_id);
        if (t === "if-condition" && typeof out.result === "boolean") seedPorts[r.node_id] = [out.result ? "true" : "false"];
        if (t === "switch" && typeof out.matched === "string") seedPorts[r.node_id] = [out.matched];
      }
    }
  }
  // 簽核節點自己沒有「成功輸出」(它是 waiting)——把它上次收到的 input 當 seed，
  // preResolved 的簽核結果會疊在上面，下游才拿得到上游算好的欄位+簽核結果。
  if (opts.preResolved) {
    const prRow = rows.find((r) => r.node_id === opts.preResolved!.nodeId);
    seeds[opts.preResolved.nodeId] = parse(prRow?.input_json ?? null);
  }

  // ── 重跑清單：起點+它的所有下游；加上「重跑清單裡的瀏覽器類節點」的上游瀏覽器鏈(登入狀態沒辦法沿用) ──
  const rerun = new Set<string>([startNodeId]);
  const outAdj = new Map<string, string[]>();
  const inAdj = new Map<string, string[]>();
  for (const e of wf.edges) {
    outAdj.set(e.from, [...(outAdj.get(e.from) ?? []), e.to]);
    inAdj.set(e.to, [...(inAdj.get(e.to) ?? []), e.from]);
  }
  const bfs = [startNodeId];
  while (bfs.length) {
    for (const next of outAdj.get(bfs.shift()!) ?? []) {
      if (!rerun.has(next)) { rerun.add(next); bfs.push(next); }
    }
  }
  const downstreamOnly = new Set(rerun); // 記住「純下游」集合，等下 log 才分得出哪些是額外補進來重跑的瀏覽器鏈
  const isBrowserNode = (id: string) => getNodeDef(nodeTypeById.get(id) ?? "")?.category === "browser";
  const needsBrowser = [...rerun].filter(isBrowserNode);
  for (const id of needsBrowser) {
    const up = [...(inAdj.get(id) ?? [])];
    const seen = new Set<string>();
    while (up.length) {
      const cur = up.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (isBrowserNode(cur) && !rerun.has(cur)) rerun.add(cur);
      up.push(...(inAdj.get(cur) ?? []));
    }
  }

  // preResolved 的節點不重跑(它由簽核結果直接代位)
  if (opts.preResolved) rerun.delete(opts.preResolved.nodeId);

  // ── 重設狀態：重跑節點回 pending；圖改過新增的節點補列；刪掉的節點清列 ──
  const wfNodeIds = new Set(wf.nodes.map((n) => n.id));
  db.prepare(`DELETE FROM node_runs WHERE run_id=? AND node_id NOT IN (${[...wfNodeIds].map(() => "?").join(",")})`).run(runId, ...wfNodeIds);
  for (const n of wf.nodes) {
    const exists = rows.some((r) => r.node_id === n.id);
    if (!exists) db.prepare(`INSERT INTO node_runs (run_id, node_id, status) VALUES (?, ?, 'pending')`).run(runId, n.id);
  }
  for (const id of rerun) {
    db.prepare(
      `UPDATE node_runs SET status='pending', error=NULL, output_json=NULL, active_ports=NULL, started_at=NULL, finished_at=NULL WHERE run_id=? AND node_id=?`,
    ).run(runId, id);
  }
  db.prepare(
    `UPDATE runs SET status='queued', error=NULL, reason=NULL, resolution=NULL, failed_node=NULL, finished_at=NULL, owner_pid=? WHERE id=?`,
  ).run(process.pid, runId);
  log(runId, null, `▶ 從「${wf.nodes.find((n) => n.id === startNodeId)?.label ?? startNodeId}」續跑(前面成功的步驟沿用上次結果)`);
  const rerunBrowser = [...rerun].filter((id) => !downstreamOnly.has(id));
  if (rerunBrowser.length > 0) {
    log(runId, null, `🌐 這段需要瀏覽器登入狀態，上游的瀏覽器步驟會一併重跑：${rerunBrowser.map((id) => wf.nodes.find((n) => n.id === id)?.label ?? id).join("、")}`);
  }

  let triggerParams: Record<string, unknown> = {};
  try { triggerParams = run.trigger_params_json ? JSON.parse(run.trigger_params_json) : {}; } catch { /* 壞資料當空 */ }
  queue.push({
    runId,
    workflowId: run.workflow_id,
    triggerParams,
    headed: opts.headed ?? Boolean(run.headed),
    trigger: (run.trigger_type as TriggerSource) ?? "manual",
    resume: { seeds, seedPorts, rerunNodeIds: [...rerun], preResolved: opts.preResolved },
  });
  processQueue();
  return { ok: true };
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
  if (row?.status === "waiting") {
    // 停掉一個「正在等簽核」的 run：它不在引擎的執行迴圈裡(早就退出了)，直接改 DB 收尾，
    // 並把對應的簽核請求作廢(不然簽核人事後按核准會試著恢復一個已取消的 run)。
    db.prepare(
      `UPDATE runs SET status='failed', error=?, reason=?, resolution='needs-human', finished_at=datetime('now') WHERE id=? AND status='waiting'`,
    ).run(USER_CANCELLED, cause ?? "使用者取消了這次執行(原本停在等人簽核)。", runId);
    db.prepare(`UPDATE node_runs SET status='failed', error='執行被取消，簽核作廢' WHERE run_id=? AND status='waiting'`).run(runId);
    db.prepare(`UPDATE node_runs SET status='skipped' WHERE run_id=? AND status='pending'`).run(runId);
    db.prepare(`UPDATE approvals SET status='cancelled', decided_at=datetime('now') WHERE run_id=? AND status='pending'`).run(runId);
    log(runId, null, "⏹ 已取消(原本在等簽核)");
    notifyFinished(runId);
    return true;
  }
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
  /** waiting = 停在等人簽核(不是失敗——流程正確地暫停了，等簽核人決定後會自己繼續) */
  status: "success" | "failed" | "waiting";
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
      status: (r?.status as "success" | "failed" | "waiting") ?? "failed",
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
  if (/找不到.*信|搜尋不到.*信|查無|報表名稱|沒有寄|該日期.*沒有|這天.*沒有|不是公開的|分享設定|一般存取權|誰可以存取|重新部署/.test(e)) {
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
    if (trigger !== "manual") notifyDesktop(`Agent Hub ${TRIGGER_LABEL[trigger]}觸發失敗`, "流程已被刪除，執行取消");
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
  // 成功跑完的節點：它們的 fromPort="error" 出線(失敗分支)是死的——失敗分支只在「真的失敗」時走，
  // 不這樣擋的話，接了失敗分支的節點每次「成功」也會把告警/備案那條路一起跑起來(最糟的假告警)。
  const succeededNodes = new Set<string>();
  // 「失敗但被失敗分支接住」的節點：只有 error 出線活著，正常出線全死。
  const errorRouted = new Set<string>();
  // 這條 edge 是不是死的(不會有資料流過)：來源被 skip、來源有分支且這條的 fromPort 沒被選中、
  // 來源成功但這條是失敗分支、來源走了失敗分支但這條是正常出線。
  const isEdgeDead = (e: { from: string; fromPort?: string }): boolean => {
    if (skipped.has(e.from)) return true;
    if (succeededNodes.has(e.from) && e.fromPort === "error") return true;
    if (errorRouted.has(e.from) && e.fromPort !== "error") return true;
    const ap = nodeActivePorts.get(e.from);
    return !!(ap && e.fromPort && !ap.includes(e.fromPort));
  };
  // 節點跑完(成功或走失敗分支)後，把確定死掉的出線的下游(整條上游都死的那些)標記跳過
  const skipDeadDownstream = (nodeId: string) => {
    for (const e of wf.edges.filter((ed) => ed.from === nodeId)) {
      if (!isEdgeDead(e)) continue;
      // 不能無條件 skip e.to：菱形圖裡死分支和另一條活著的路徑可能都連到同一個匯流節點，
      // 只有當 e.to 的「每一條上游 edge 都死了」才 skip 它(留著的會等活上游跑完再執行)。
      const inEdgesAllDead = wf.edges.filter((ed) => ed.to === e.to).every(isEdgeDead);
      if (inEdgesAllDead && !skipped.has(e.to)) {
        skipped.add(e.to);
        skipDownstream(e.to);
      }
    }
  };
  let failed = false;
  let failError = "";
  let failedNode = "";
  let failedNodeLabel = "";
  let successCount = 0;
  /** 停在等簽核：不是失敗也不是成功，run 標成 waiting 等簽核人決定後恢復 */
  let waiting: { nodeLabel: string; message: string } | null = null;
  /** 這輪被失敗分支接住的錯誤(run 最後算成功，但要老實告訴使用者哪步出過事) */
  const handledFailures: { label: string; error: string }[] = [];

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

    // ── 續跑：簽核恢復的那個節點不重新執行，直接視為成功、帶簽核結果走指定分支 ──
    if (item.resume?.preResolved?.nodeId === node.id) {
      const pr = item.resume.preResolved;
      const merged = { ...(item.resume.seeds[node.id] ?? {}), ...pr.output };
      nodeOutputs.set(node.id, merged);
      if (pr.activePort) nodeActivePorts.set(node.id, [pr.activePort]);
      succeededNodes.add(node.id);
      successCount++;
      db.prepare(
        `UPDATE node_runs SET status='success', output_json=?, active_ports=?, finished_at=datetime('now') WHERE run_id=? AND node_id=?`,
      ).run(JSON.stringify(pr.output), pr.activePort ? JSON.stringify([pr.activePort]) : null, runId, node.id);
      log(runId, node.id, `[${node.label}] 簽核結果已回來，繼續往下跑`);
      skipDeadDownstream(node.id);
      continue;
    }

    // ── 續跑：之前成功過、又不在重跑清單裡的節點，沿用上次結果(不重新執行) ──
    if (item.resume && !item.resume.rerunNodeIds.includes(node.id)) {
      const seed = item.resume.seeds[node.id];
      if (seed) {
        nodeOutputs.set(node.id, seed);
        const ports = item.resume.seedPorts[node.id];
        if (ports) nodeActivePorts.set(node.id, ports); // 重放上次選的分支，下游分支邏輯才會一致
        succeededNodes.add(node.id);
        successCount++;
        log(runId, node.id, `[${node.label}] ↩︎ 沿用上次成功的結果(續跑不重跑這步)`);
        skipDeadDownstream(node.id);
        continue;
      }
      // 沒有 seed(上次沒成功、圖改過新增的節點等)：往下走正常執行——老實重跑比沿用不存在的結果安全
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
      succeededNodes.add(node.id); // 成功的節點,它的失敗分支(fromPort="error")那條路是死的
      db.prepare(`UPDATE node_runs SET status='success', output_json=?, active_ports=?, attempt=?, finished_at=datetime('now') WHERE run_id=? AND node_id=?`)
        .run(JSON.stringify(result.output), result.activePorts ? JSON.stringify(result.activePorts) : null, attempt, runId, node.id);
      log(runId, node.id, `[${node.label}] 完成`);

      // 分支：只走 activePorts 指定的下游，其餘整條標記 skip。
      // 只有「明確標了 port、但這個 port 沒被選中」才跳過；edge.fromPort 完全沒填(AI 建圖忘記標/舊資料)
      // 一律當作「留著跑」而不是預設塞一個永遠不會命中的 "out" ——不然一個缺欄位就會讓 if 節點的
      // 兩條分支全部靜默跳過、下游整條都不執行，run 卻還回報「成功」，是最難被使用者發現的那種 bug。
      // (死線的完整判定在 isEdgeDead：沒被選中的分支、成功節點的失敗分支都算死，skipDeadDownstream
      //  只跳過「所有上游 edge 都死」的節點——菱形匯流有活上游就保留。)
      if (result.activePorts) nodeActivePorts.set(node.id, result.activePorts);
      skipDeadDownstream(node.id);
    } catch (err) {
      const isCancel = cancelRequested.has(runId);

      // ── 等人簽核：不是失敗，是流程正確地暫停了。標記 waiting 後結束這輪執行，
      //    簽核人決定後由 approvals 模組用「續跑」機制讓這個 run 從簽核節點接著跑。 ──
      if (!isCancel && err instanceof WaitingForHuman) {
        waiting = { nodeLabel: node.label, message: err.approvalMessage };
        db.prepare(`UPDATE node_runs SET status='waiting', finished_at=NULL WHERE run_id=? AND node_id=?`).run(runId, node.id);
        log(runId, node.id, `[${node.label}] ⏸ 等待簽核中：${err.approvalMessage.slice(0, 100)}`);
        break;
      }

      // 這個節點若是被 cancelRun() 強制關頁面才拋錯的(使用者按了停止)，不要顯示 Playwright 那句
      // 難懂的英文錯誤(如 "Target page, context or browser has been closed")，改顯示清楚的中文原因
      const errMsg = isCancel ? USER_CANCELLED : err instanceof Error ? err.message : String(err);

      // ── 失敗分支(Plan B)：節點接了 fromPort="error" 的出線，就不讓整條 run 倒下——
      //    把錯誤資訊當這個節點的輸出({{error}}/{{errorStep}})、只走失敗分支繼續跑。
      //    使用者按停止不走備案(他要的是停，不是 Plan B)。 ──
      const hasErrorBranch = wf.edges.some((e) => e.from === node.id && e.fromPort === "error");
      if (!isCancel && hasErrorBranch) {
        db.prepare(`UPDATE node_runs SET status='failed', error=?, finished_at=datetime('now') WHERE run_id=? AND node_id=?`)
          .run(errMsg, runId, node.id);
        log(runId, node.id, `[${node.label}] 失敗：${errMsg}`);
        log(runId, node.id, `[${node.label}] 🆘 有接失敗分支——改走 Plan B 繼續執行`);
        nodeOutputs.set(node.id, { ...input, error: errMsg, errorStep: node.label });
        errorRouted.add(node.id);
        handledFailures.push({ label: node.label, error: errMsg });
        skipDeadDownstream(node.id); // 正常出線全死、只有失敗分支活著
        continue;
      }

      failed = true;
      failError = errMsg;
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

  if (waiting) {
    // 停在等簽核：run 標 waiting(不是失敗)，等簽核人決定後 approvals 模組會用續跑機制接著跑。
    // finished_at 留空——這次執行還沒結束，只是暫停。逾時保險由 scheduler 的定期掃描負責。
    const reason = `⏸ 停在「${waiting.nodeLabel}」等人簽核：${waiting.message.slice(0, 150)}`;
    db.prepare(`UPDATE runs SET status='waiting', reason=?, failed_node=NULL, error=NULL WHERE id=?`).run(reason, runId);
    log(runId, null, "⏸ 流程暫停，等簽核人決定後會自動繼續");
  } else if (failed && failError === USER_CANCELLED) {
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
    // 無人值守觸發(排程/資料夾監聽/webhook)的失敗一定要主動通知——這是使用者唯一能知道「沒跑成功」的管道，不然只能自己想到才會去開網頁看
    if (trigger !== "manual") {
      if (resolution === "ai-fixable" && wf.status === "official" && failedNode) {
        // 正式流程無人值守失敗且看起來 AI 修得好：在背景讓 AI 想一個修法提案(不自動套用，不影響正式在跑的設定)，
        // 想好之後通知裡順便講一句「AI 已經想好怎麼修」，使用者開網頁就能一鍵套用+重跑，不用自己動手找問題。
        notifyDesktop(`「${wf.name}」${TRIGGER_LABEL[trigger]}執行失敗`, `${fullReason.slice(0, 150)}｜AI 正在想辦法修…`);
        proposeFixInBackground(workflowId, runId, failedNode, failedNodeLabel, failError).catch(() => {});
      } else {
        notifyDesktop(`「${wf.name}」${TRIGGER_LABEL[trigger]}執行失敗`, fullReason.slice(0, 200));
      }
    }
    // ── 全域備援：這條流程設定了「失敗時自動執行另一條流程」就把它叫起來(帶失敗現場資訊)。
    //    __errorHop 防連鎖迴圈：備援流程自己也失敗、又指回來 → 最多跳 2 層就停。 ──
    if (wf.onFailureWorkflow) {
      const hop = Number(triggerParams.__errorHop ?? 0) + 1;
      if (hop > 2) {
        log(runId, null, `🆘 失敗備援流程已連鎖 ${hop - 1} 層，為避免無限迴圈不再觸發`);
      } else {
        const target = findWorkflowByRef(wf.onFailureWorkflow);
        if (!target) {
          log(runId, null, `🆘 找不到設定的失敗備援流程「${wf.onFailureWorkflow}」(可能已改名/刪除)，沒有觸發`);
          notifyDesktop(`「${wf.name}」的失敗備援流程沒觸發`, `找不到「${wf.onFailureWorkflow}」，請到觸發面板重新設定`);
        } else {
          try {
            startWorkflowRun(target.id, {
              failedWorkflow: wf.name,
              failedStep: failedNodeLabel || "(未知步驟)",
              error: failError.slice(0, 500),
              __errorHop: hop,
            }, { headed: false, trigger: "error" });
            log(runId, null, `🆘 已觸發失敗備援流程「${target.name}」`);
          } catch (e) {
            log(runId, null, `🆘 觸發失敗備援流程時出錯：${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
  } else {
    // 「全綠」不等於「結果正確」——最陰險的走樣是 {{變數}} 沒對應到資料、字面留在檔名/內容裡
    // (cfgStr 刻意只警告不拋錯，見 nodeHelpers)。這種執行技術上成功、產出卻是垃圾，
    // 若總結只寫「執行成功」使用者根本不會發現。把警告數浮上來，讓人一眼看到該去檢查。
    const varWarnings = getVarWarnings(runId).count;
    const reason =
      `執行成功，完成 ${successCount} 個步驟。` +
      (handledFailures.length > 0
        ? `🆘 其中「${handledFailures.map((h) => h.label).join("、")}」出了錯，已由你畫好的失敗分支(Plan B)接手處理——請確認備案結果符合預期(原錯誤：${handledFailures[0].error.slice(0, 100)})。`
        : "") +
      (varWarnings > 0 ? `⚠️ 但有 ${varWarnings} 個設定裡的 {{變數}} 沒有對應到資料，可能讓檔名或內容出現 {{...}} 字樣——請檢查產出結果，不對就在對話裡跟 AI 說。` : "");
    db.prepare(`UPDATE runs SET status='success', reason=?, finished_at=datetime('now') WHERE id=?`).run(reason, runId);
    log(runId, null, varWarnings > 0 ? `✅ 執行完成(有 ${varWarnings} 個變數警告，見上方紀錄)` : "✅ 執行完成");
    if (trigger !== "manual") notifyDesktop(`「${wf.name}」${TRIGGER_LABEL[trigger]}執行完成`, reason);
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
