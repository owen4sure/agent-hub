import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page, type BrowserContextOptions } from "playwright";
import { getDb } from "../db";
import { decryptSecret, encryptSecret } from "../secretVault";
import { getGlobalSettings, getWorkflowModel, getWorkflowSecretsForKeys, getMaxConcurrent } from "../settingsStore";
import { resolveValue, DATE_TOKENS } from "../relativeDate";
import { notifyDesktop } from "../notify";
import { getClient } from "../modelClient";
import { aiRepairGraph } from "./graphRepair";
import { createProposal } from "./fixProposals";
import { assertRunnableGraph, hasExecutableSteps, withSchemaDefaults } from "./graphLint";
import { getWorkflow, findWorkflowByRef, deriveRequiresSecrets } from "./store";
import { getNodeDef } from "./registry";
import { dryRunSkipKind, DRY_RUN_SKIPPED_WRITES_KEY } from "./dryRun";
import { markPendingNodeRunsSkipped } from "./runState";
import { workflowExecutionFingerprint } from "./fingerprint";
import { collectRunSeeds, downstreamNodeIds, type RunSeedRow } from "./partialRun";
import { ExternalPreflightError, preflightExternalIntegrations } from "./preflight";
import { isPlaceholderCode } from "./codegen";
import { PermanentError, RetryableError, WaitingForHuman } from "./types";
import type { Workflow, WorkflowNode, RunSession, NodeContext } from "./types";

// 併發上限的預設(依 CPU 推算)；實際值由「設定」的 maxConcurrent 覆寫，1=依序、>1=併行
const DEFAULT_MAX_CONCURRENT = Math.max(1, Math.min(3, os.cpus().length - 1));
export function defaultMaxConcurrent() { return DEFAULT_MAX_CONCURRENT; }
const RETRY_BACKOFF_MS = [3000, 9000];
const MAX_ATTEMPTS = 3;
const NODE_TIMEOUT_MS = 3 * 60 * 1000;
// 無人值守正式流程失敗、且判定為外部服務暫時性問題(見 classifyFailure 的 transient)時，
// 延後自動重跑的等待時間與最多重試次數——避免真的卡死的東西被無限重試下去。
const AUTO_RETRY_DELAY_MINUTES = 5;
const MAX_AUTO_RETRIES = 2;

/** manual=使用者按執行；其餘都是無人值守的自動觸發(結果要靠桌面通知讓人知道) */
export type TriggerSource = "manual" | "schedule" | "watch" | "webhook" | "form" | "error" | "email" | "telegram" | "line" | "retry";
const TRIGGER_LABEL: Record<TriggerSource, string> = { manual: "手動", schedule: "排程", watch: "資料夾監聽", webhook: "Webhook", form: "表單", error: "錯誤觸發", email: "收信觸發", telegram: "Telegram 訊息", line: "LINE 訊息", retry: "失敗自動重跑" };

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
  /** 「從這一步開始測」用：不在重跑清單又沒有 seed 的節點一律標 skipped、絕不默默正常執行——
   * 使用者就是要略過前面登入/抓資料/寫入那段;缺資料會以 {{變數}} 警告老實浮出,不是假裝跑過。 */
  skipUnseeded?: boolean;
}

interface QueueItem {
  runId: string;
  workflowId: string;
  triggerParams: Record<string, unknown>;
  headed: boolean;
  trigger: TriggerSource;
  resume?: ResumeSpec;
  /** 只讀驗證模式:照常跑「讀檔/抽取/計算」,但「寫回試算表/發通知」那幾步一律略過(不改使用者的資料)。
   * 使用者「叫他去看檔案、證明有沒有看懂」用的——見 dryRunSkipKind、/api/workflows/[id]/verify。 */
  dryRun?: boolean;
  /** 只限 dryRun，或 server 以一次性 preview token 確認過的讀取來源覆寫。瀏覽器不能直接指定。 */
  secretOverrides?: Record<string, string>;
  /** 同上：本輪對話貼的來源網址可暫時替換唯一對應的讀取步驟，不存回 workflow。 */
  nodeConfigOverrides?: Record<string, Record<string, unknown>>;
}

const queue: QueueItem[] = [];
const runningWorkflows = new Set<string>();
let activeCount = 0;
const MAX_QUEUED_TOTAL = 500;
const MAX_QUEUED_PER_WORKFLOW = 50;

export class QueueCapacityError extends Error {}

export interface MissingWorkflowSetting {
  key: string;
  label: string;
  /** 節點自己宣告的欄位型別(text/password)——前端安全輸入卡要用這個決定要不要用密碼框遮住，
   * 不能靠猜 key 名稱像不像密碼(Slack webhook 網址這類敏感值 key 名稱完全不含 pass/token/secret，
   * 猜錯就會讓機密網址明文顯示在畫面上)。 */
  type: "text" | "password";
}

/** 所有觸發來源共用的執行前檢查；別等登入、抓信、下載都做完才在最後一步發現少一個寫入網址。
 * 帳密清單「每次都重新推導」，不用磁碟上存的舊 requiresSecrets——custom-code 的帳密需求(ctx.secrets.X)
 * 是掃文字推導的，舊清單沒有它，會放行一個必然在半路炸 undefined 的執行(踩過:Google 登入自訂步驟)。 */
export function getMissingWorkflowSettings(wf: Workflow, trustedOverrides: Record<string, string> = {}): MissingWorkflowSetting[] {
  const required = deriveRequiresSecrets(wf) ?? [];
  const secrets = { ...getWorkflowSecretsForKeys(wf.id, required.map((field) => field.key)), ...trustedOverrides };
  return required
    .filter((field) => !String(secrets[field.key] ?? "").trim())
    .map((field) => ({ key: field.key, label: field.label, type: field.type }));
}

export class MissingWorkflowSettingsError extends Error {
  readonly missing: MissingWorkflowSetting[];

  constructor(missing: MissingWorkflowSetting[]) {
    super(`執行前還缺少設定：${missing.map((item) => item.label).join("、")}。請先到「設定」頁補齊，系統沒有開始登入、抓資料或寫入。`);
    this.name = "MissingWorkflowSettingsError";
    this.missing = missing;
  }
}

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
/** 系統為避免無限等待而停止，和使用者主動按停止完全不同，UI 必須如實區分。 */
export const SYSTEM_TIMEOUT = "SYSTEM_TIMEOUT";
export function isUserCancelled(error: string | null | undefined): boolean {
  return error === USER_CANCELLED;
}

function log(runId: string, nodeId: string | null, line: string) {
  getDb()
    .prepare(`INSERT INTO run_logs (run_id, node_id, ts, line) VALUES (?, ?, datetime('now'), ?)`)
    .run(runId, nodeId, line);
}

/** JSON.stringify 但物件 key 先排序——比較兩份「內容相同、鍵值順序不保證相同」的參數物件是否相等時用，
 * 單純 JSON.stringify 會因鍵值順序不同而誤判不相等。 */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, vv]) => [k, sort(vv)]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function safeParseJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function makeSession(headed: boolean, workflowId: string): RunSession {
  let browser: Browser | null = null;
  let page: Page | null = null;
  const stateDir = path.join(process.cwd(), "data", "browser-sessions");
  const statePath = path.join(stateDir, `${workflowId}.json`);
  const loadState = (): BrowserContextOptions["storageState"] | undefined => {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as { cookies?: unknown; origins?: unknown };
      if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) return undefined;
      return parsed as BrowserContextOptions["storageState"];
    } catch { return undefined; }
  };
  return {
    async getBrowser() {
      // AutomationControlled 特徵(navigator.webdriver=true)是 Google 這類網站判定機器人的主要訊號之一,
      // 拿掉它讓「手動登入一次存下的 session」在自動化執行時比較不會被重新盤查。
      if (!browser) browser = await chromium.launch({ headless: !headed, args: ["--disable-blink-features=AutomationControlled"] });
      return browser;
    },
    async getPage() {
      if (!page) {
        const b = await this.getBrowser();
        const storageState = loadState();
        const context = await b.newContext({ acceptDownloads: true, ...(storageState ? { storageState } : {}) });
        page = await context.newPage();
      }
      return page;
    },
    currentPage() {
      return page;
    },
    async resetPage() {
      const stale = page;
      page = null;
      // 關掉整個 context(不只分頁)：讓卡住的舊操作(page.click/waitForSelector等)立刻拋錯結束，不會繼續跟下一次嘗試搶同一頁
      if (stale) await stale.context().close().catch(() => {});
    },
    async saveState() {
      if (!page) return;
      const state = await page.context().storageState();
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") fs.chmodSync(stateDir, 0o700);
      const temp = `${statePath}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(temp, statePath);
        if (process.platform !== "win32") fs.chmodSync(statePath, 0o600);
      } finally {
        fs.rmSync(temp, { force: true });
      }
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
  options: { headed?: boolean; trigger?: TriggerSource; dryRun?: boolean; secretOverrides?: Record<string, string>; nodeConfigOverrides?: Record<string, Record<string, unknown>>; confirmedPreview?: boolean; startAtNodeId?: string; onlyNodeIds?: string[] } = {},
): string {
  const db = getDb();
  const wf = getWorkflow(workflowId);
  if (!wf) throw new Error("workflow 不存在");
  if (!hasExecutableSteps(wf.nodes)) {
    throw new Error("這條流程還沒有要執行的步驟。直接在右側說你想完成什麼，AI 會先幫你建立流程；目前沒有開始任何外部操作。");
  }
  if (options.startAtNodeId && !wf.nodes.some((n) => n.id === options.startAtNodeId)) {
    throw new Error("找不到要當起點的那一步(流程可能剛被改過)，請重新整理頁面再試一次");
  }
  if (options.onlyNodeIds?.length && options.onlyNodeIds.some((nid) => !wf.nodes.some((n) => n.id === nid))) {
    throw new Error("選取的步驟有的不在這條流程裡(流程可能剛被改過)，請重新整理頁面再試一次");
  }
  if (wf.importedUntrusted) {
    throw new Error("這是尚未確認的外部匯入流程，請先在流程頁手動執行並確認安全提醒");
  }
  // 部分執行(框選幾步/從某步開始)的語意由使用者拍板(2026-07-16)：「圈起來執行的，那就執行到底，
  // 除非我有說只測試不更改任何資料」——所以這裡尊重呼叫端的 dryRun，預設是「真的執行」(含寫入/發送)；
  // UI 上有明確的「只測試」勾選，勾了才傳 dryRun:true 走安全排練。曾經一度改成部分執行一律強制
  // dryRun，結果使用者框選的互動步驟(點簡報重新整理)永遠不會真的執行、也沒說明，比危險更糟的是不可用。
  const dryRun = options.dryRun;
  // 不相信「建圖當下驗過」：手動編輯、版本還原、舊資料或其他 API 都可能在之後把圖改壞。
  // 這裡是 manual/schedule/watch/webhook/form/email/Telegram/LINE/子流程共同會經過的唯一入口。
  assertRunnableGraph(wf.nodes, wf.edges);
  // 只讀驗證會刻意略過寫入步驟，並把缺少設定列在預覽結果，所以不能在這裡擋；正式執行則一律
  // 在任何外部操作之前失敗，避免跑完前面幾分鐘才發現最後一個必要設定沒填。
  if (!dryRun) {
    const missing = getMissingWorkflowSettings(wf, options.confirmedPreview ? options.secretOverrides : undefined);
    if (missing.length > 0) throw new MissingWorkflowSettingsError(missing);
  }
  // Webhook/表單/訊息觸發可能瞬間灌入大量事件；只有併發上限、沒有排隊上限，仍會讓記憶體與 DB
  // 無限長大。到達上限要明確回壓，不能接受後再默默丟事件。
  const totalQueued = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status='queued'`).get() as { n: number }).n;
  const workflowQueued = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status='queued' AND workflow_id=?`).get(workflowId) as { n: number }).n;
  if (totalQueued >= MAX_QUEUED_TOTAL || workflowQueued >= MAX_QUEUED_PER_WORKFLOW) {
    throw new QueueCapacityError(`執行佇列已滿（這條流程 ${workflowQueued}/${MAX_QUEUED_PER_WORKFLOW}，全部 ${totalQueued}/${MAX_QUEUED_TOTAL}），請等前面的工作完成後再送`);
  }
  const runId = randomUUID();
  const headed = options.headed ?? wf.status === "draft";
  const trigger = options.trigger ?? "manual";
  // 這次執行當下的圖版本指紋——存下來讓未來的部分執行知道「哪些舊 run 的輸出還能安全沿用」
  // (圖被改過之後的舊 run，節點設定/接線都可能不一樣了，不能拿它的輸出當這次的種子)。
  const graphFingerprint = workflowExecutionFingerprint(wf);

  // owner_pid 記下「這個 run 是哪個進程在跑」——執行佇列/瀏覽器 session 全是進程內記憶體，
  // DB 裡的 running/queued 若不記進程歸屬，另一個進程(daemon + dev 同時開)開機做崩潰復原時
  // 會把「別的進程其實還在跑的 run」一起誤標失敗。見 recoverCrashedRuns。
  db.prepare(
    `INSERT INTO runs (id, workflow_id, status, trigger_type, headed, trigger_params_json, secret_overrides_json, node_config_overrides_json, dry_run, owner_pid, graph_fingerprint, started_at)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    runId, workflowId, trigger, headed ? 1 : 0, JSON.stringify(triggerParams),
    options.confirmedPreview && options.secretOverrides ? encryptSecret(JSON.stringify(options.secretOverrides)) : null,
    options.confirmedPreview && options.nodeConfigOverrides ? JSON.stringify(options.nodeConfigOverrides) : null,
    dryRun ? 1 : 0,
    process.pid,
    graphFingerprint,
  );

  for (const node of wf.nodes) {
    db.prepare(
      `INSERT INTO node_runs (run_id, node_id, status) VALUES (?, ?, 'pending')`,
    ).run(runId, node.id);
  }

  pruneRuns(workflowId);

  // ── 部分執行：「從這一步開始測」(startAtNodeId=起點+它的所有下游) 或「只測選取的幾步」
  // (onlyNodeIds=畫布框選的集合,像 n8n 那樣)。只執行 rerunNodeIds 裡的節點，其餘有最近一次結果
  // 就沿用、沒有就老實標 skipped——驗證新段落/單一步驟時,不用每次都把登入/抓信/填表整條重跑。
  // 注意這裡「不」像 resumeRun 那樣自動把上游瀏覽器鏈排進重跑：那個機制會把 google-sheet 寫入這類
  // 有副作用的瀏覽器節點一起重跑,正好違背「只測後段、不要動前面」的本意。若這段真的依賴前面步驟
  // 建立的登入狀態,會老實失敗並顯示在紀錄裡,使用者再改用完整執行即可。
  let resume: ResumeSpec | undefined;
  const partialIds = options.onlyNodeIds?.length
    ? [...new Set(options.onlyNodeIds)]
    : options.startAtNodeId
      ? downstreamNodeIds(wf.edges, options.startAtNodeId)
      : undefined;
  if (partialIds) {
    // 種子只能來自「圖版本相同 + 這次執行參數相同」的舊 run——不能只挑「最近一次成功過的執行」就沿用。
    // 使用者常常會在部分執行前改了篩選日期/期間、或改過節點設定，若這裡不核對，會把舊日期/舊邏輯
    // 算出的資料靜默當成這次的種子餵給下游寫入節點，而畫面只顯示「沿用最近一次的結果」——
    // 這是會讓使用者拿過期資料覆蓋正式資料的真實風險，不是理論上的邊界案例。
    // 只掃最近 20 筆(有成功節點的)候選，找「圖版本 + 執行參數都吻合」裡最新的一筆；一律不比對
    // dry_run(安全排練也是同一套邏輯算出來的合法結果，值得沿用，只是不能拿它去覆寫正式資料——
    // 而正式寫入節點本身自然會照 dryRun 旗標決定要不要真的送出，這裡只是挑「輸入資料」的來源)。
    const candidates = db
      .prepare(
        `SELECT r.id, r.trigger_params_json FROM runs r WHERE r.workflow_id=? AND r.id!=? AND r.status NOT IN ('queued','running')
           AND EXISTS (SELECT 1 FROM node_runs nr WHERE nr.run_id = r.id AND nr.status='success')
           AND r.graph_fingerprint = ?
         ORDER BY r.started_at DESC, r.rowid DESC LIMIT 20`,
      )
      .all(workflowId, runId, graphFingerprint) as { id: string; trigger_params_json: string | null }[];
    const currentParamsKey = stableJson(triggerParams);
    const prior = candidates.find((c) => stableJson(safeParseJson(c.trigger_params_json)) === currentParamsKey);
    const rows = prior
      ? (db.prepare(`SELECT node_id, status, input_json, output_json, active_ports FROM node_runs WHERE run_id = ?`).all(prior.id) as RunSeedRow[])
      : [];
    const { seeds, seedPorts } = collectRunSeeds(wf.nodes, rows);
    resume = { seeds, seedPorts, rerunNodeIds: partialIds, skipUnseeded: true };
    const label = (nid: string) => wf.nodes.find((n) => n.id === nid)?.label ?? nid;
    // 「執行」vs「只測」是兩種模式,開場橫幅要講對:預設是真的執行(含寫入/發送),勾了「只測試」才是安全排練
    const mode = dryRun ? "只測" : "執行";
    const banner = options.onlyNodeIds?.length
      ? `▶ ${mode}選取的 ${partialIds.length} 步：${partialIds.map(label).join("、")}——其餘步驟不會重新執行(有相同版本、相同參數的最近結果就沿用，沒有就跳過)${dryRun ? "" : "。這是正式執行:選到的步驟會真的寫入/發送。"}`
      : `▶ ${mode}「${label(options.startAtNodeId!)}」開始的後段——前面的步驟不會重新執行(有相同版本、相同參數的最近結果就沿用，沒有就跳過)${dryRun ? "" : "。這是正式執行:跑到的步驟會真的寫入/發送。"}`;
    log(runId, null, banner);
    if (!prior && candidates.length > 0) {
      log(runId, null, `⚠️ 找到 ${candidates.length} 筆這條流程的先前執行紀錄，但都是用不同的執行參數(例如不同的期間/日期)跑的——為了不把舊參數算出的資料當成這次的結果，沒有拿它們當種子；沒有種子的步驟會標記跳過。`);
    }
  }

  queue.push({
    runId, workflowId, triggerParams, headed, trigger, dryRun, resume,
    // 正式執行只接受 server 端從一次性 preview token 取回的覆寫；API body 不能直接塞。
    secretOverrides: dryRun || options.confirmedPreview ? options.secretOverrides : undefined,
    nodeConfigOverrides: dryRun || options.confirmedPreview ? options.nodeConfigOverrides : undefined,
  });
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
    | { id: string; workflow_id: string; status: string; failed_node: string | null; trigger_type: string; headed: number; trigger_params_json: string | null; secret_overrides_json: string | null; node_config_overrides_json: string | null; dry_run: number }
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
  const nodeTypeById = new Map(wf.nodes.map((n) => [n.id, n.type]));
  // 成功節點的合併輸出+分支重放,與「從這一步開始測」共用同一套萃取規則(partialRun.ts)
  const { seeds, seedPorts } = collectRunSeeds(wf.nodes, rows);
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
  let secretOverrides: Record<string, string> | undefined;
  let nodeConfigOverrides: Record<string, Record<string, unknown>> | undefined;
  try { secretOverrides = run.secret_overrides_json ? JSON.parse(decryptSecret(run.secret_overrides_json)) : undefined; } catch { /* 壞資料不用 */ }
  try { nodeConfigOverrides = run.node_config_overrides_json ? JSON.parse(run.node_config_overrides_json) : undefined; } catch { /* 壞資料不用 */ }
  queue.push({
    runId,
    workflowId: run.workflow_id,
    triggerParams,
    headed: opts.headed ?? Boolean(run.headed),
    trigger: (run.trigger_type as TriggerSource) ?? "manual",
    // 高風險邊界：安全試跑從失敗處續跑後仍必須略過寫入，不能因為來到一條新 queue item 就丟掉 dryRun。
    dryRun: Boolean(run.dry_run),
    secretOverrides,
    nodeConfigOverrides,
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
    markPendingNodeRunsSkipped(db, runId);
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
    markPendingNodeRunsSkipped(db, runId);
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
const completions = new Map<string, { resolve: (r: RunFinal) => void; timer: ReturnType<typeof setTimeout>; cleanup?: () => void }>();
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
    entry.cleanup?.();
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
/**
 * runWorkflowAndWait 與 resumeRunAndWait 共用的等待邏輯：run 已經被排進 queue 之後，
 * 掛一個 completions 項目，讓 notifyFinished(runId)(引擎跑到終態時呼叫)能解出這個 Promise。
 * 抽出來是因為兩者的差異只在「怎麼把 run 排進 queue」(全新觸發 vs 從失敗處續跑)，等待/逾時/
 * 取消這段邏輯完全一樣，不應該維護兩份。
 */
function waitForRunCompletion(runId: string, timeoutMs: number, signal?: AbortSignal): Promise<RunFinal> {
  return new Promise((resolve) => {
    const finishWait = (result: RunFinal) => {
      const entry = completions.get(runId);
      if (!entry) return;
      completions.delete(runId);
      clearTimeout(entry.timer);
      entry.cleanup?.();
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (completions.has(runId)) {
        // 逾時不能只是回報失敗——引擎其實還在跑，呼叫端(autofix/autorun)收到失敗會再疊一輪新的執行，
        // 新舊兩輪對真實系統(webmail 登入、下載)形成非預期的連續操作。直接把這個 run 停掉。
        // 帶明確原因：這是「時間預算用完的系統停止」，紀錄不能寫成「使用者手動停止」(使用者根本沒按)。
        cancelRun(runId, "執行時間超過上限，系統自動停止了這次執行(不是手動停止)。");
        finishWait({ runId, status: "failed", failedNode: null, error: "執行逾時", varWarnings: 0 });
      }
    }, timeoutMs);
    const onAbort = () => {
      if (!completions.has(runId)) return;
      const reason = signal?.reason;
      const message = reason instanceof Error ? reason.message : "這次驗證已被停止";
      cancelRun(runId, message);
      finishWait({ runId, status: "failed", failedNode: null, error: message, varWarnings: 0 });
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    completions.set(runId, { resolve, timer, cleanup });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function runWorkflowAndWait(
  workflowId: string,
  triggerParams: Record<string, unknown>,
  options: { headed?: boolean; timeoutMs?: number; dryRun?: boolean; secretOverrides?: Record<string, string>; nodeConfigOverrides?: Record<string, Record<string, unknown>>; signal?: AbortSignal } = {},
): Promise<RunFinal> {
  const runId = startWorkflowRun(workflowId, triggerParams, {
    headed: options.headed,
    trigger: "manual",
    dryRun: options.dryRun,
    secretOverrides: options.secretOverrides,
    nodeConfigOverrides: options.nodeConfigOverrides,
  });
  // 呼叫端(autofix 的總時間預算)可以給更短的上限，但不能超過引擎預設的天花板
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? RUN_WAIT_TIMEOUT_MS, 10_000), RUN_WAIT_TIMEOUT_MS);
  return waitForRunCompletion(runId, timeoutMs, options.signal);
}

/**
 * 續跑失敗的那次執行並等它跑完(給「套用修復提案後重跑驗證」這類需要同步結果的呼叫端用)——
 * 之前成功的步驟(含已經寫入/寄出的副作用)沿用上次結果，不會重跑一遍，只重跑失敗那步和它的下游。
 * 真實顧慮：不用這個、改叫 runWorkflowAndWait 從頭跑一次的話，若失敗前已經有步驟寫入試算表/
 * 寄出通知，從頭重跑會讓那些副作用重演一次(這正是 resumeRun 存在的理由，套用修復提案後
 * 卻沒有走這條路，是同一類問題在另一個呼叫端重演)。
 *
 * 回傳多帶一個 resumed 欄位，區分兩種完全不同的「失敗」：
 * - resumed:false = resumeRun 這個機制本身就啟動不了(run 已被清理／圖改過找不到失敗節點／
 *   run 還在跑)——呼叫端這時應該自行決定要不要退回 runWorkflowAndWait 從頭跑一次。
 * - resumed:true 但 status:"failed" = 續跑機制正常啟動、也真的重新跑了失敗節點及其下游，
 *   結果還是失敗——這是誠實的「修復沒有生效」，呼叫端不該因此又疊加一輪從頭的全新執行
 *   (那會讓已經成功過的副作用重演，正是這個函式想避免的事)。
 */
export async function resumeRunAndWait(
  runId: string,
  opts: { preResolved?: ResumeSpec["preResolved"]; headed?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RunFinal & { resumed: boolean }> {
  const started = resumeRun(runId, { preResolved: opts.preResolved, headed: opts.headed });
  if (!started.ok) {
    return { runId, status: "failed", failedNode: null, error: started.error ?? "無法從失敗處續跑", varWarnings: 0, resumed: false };
  }
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? RUN_WAIT_TIMEOUT_MS, 10_000), RUN_WAIT_TIMEOUT_MS);
  const result = await waitForRunCompletion(runId, timeoutMs, opts.signal);
  return { ...result, resumed: true };
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
export type FailureCategory = "credentials" | "configuration" | "data" | "ai-fixable" | "unknown";
export function classifyFailure(error: string): { reason: string; resolution: "ai-fixable" | "needs-human"; category: FailureCategory; transient: boolean } {
  const e = error || "未知錯誤";
  // ① 帳號/密碼類最優先當「需人工」——AI 無法憑空生出正確帳密，重試也沒用，直接請使用者處理。
  //    (但要排除「認證資訊檢查失敗」這種驗證碼打錯也會出現的通用訊息——那個歸 ai-fixable)
  //    Chat ID／傳送對象 ID 錯誤跟 Token 錯誤是同一類「只有使用者能取得的識別碼」，但這兩則
  //    訊息沒有出現「Token」字樣(是 Telegram/LINE 各自的說法)，原本只認 Token 抓不到，會掉到
  //    預設的 ai-fixable，讓修復迴圈對著使用者自己才能取得的值一直空轉重試。
  if (/帳號.{0,4}密碼.{0,4}錯誤|密碼錯誤|帳號不存在|使用者不存在|帳號已被停用|帳號已鎖定|尚未.*填.*帳|沒有設定.*帳|請到設定.*帳|未設定.*帳|[Tt]oken 不正確|不正確\(API 回 401\)|Chat ID 不正確|傳送對象.{0,4}ID 不正確/.test(e)) {
    return { reason: `${e}｜需人工：請到「設定」頁確認並填入正確的帳號密碼後重跑。`, resolution: "needs-human", category: "credentials", transient: false };
  }
  // Google/Microsoft 這類平台「擋自動化登入」或登入狀態過期——帳密全對也照擋,AI 重試/改設定都無解,
  // 唯一解是使用者本人到流程頁「⋯→🔐 手動登入一次」。絕不能歸 ai-fixable,否則修復迴圈會開開關關空轉。
  if (/無法登入帳戶|安全疑慮|機器人偵測|兩步驟驗證|登入卡在|手動登入一次|登入狀態不存在|登入狀態.{0,6}(?:過期|失效)/i.test(e)) {
    return { reason: `${e}｜需人工：這類網站會擋「自動化登入」(帳密正確也一樣)，重試無效。請到流程頁右上「⋯ → 🔐 手動登入一次」親手登入，之後執行會自動帶入登入狀態、不再經過登入頁。`, resolution: "needs-human", category: "credentials", transient: false };
  }
  // Google OAuth(API 直連類節點，如重新整理簡報圖表)的憑證問題跟上面的瀏覽器登入是不同機制——
  // invalid_grant(refresh token 被撤銷/過期)要重新走一次 OAuth 流程拿新 token；invalid_client
  // (Client ID/Secret 貼錯或不成對)要回 Google Cloud Console 重新核對——兩種都只有使用者本人
  // 能解，AI 改設定或重試都沒用。真實踩過的漏網之魚：一開始只寫了 invalid_grant 這條規則，
  // invalid_client 沒被歸類到，就掉到預設的 ai-fixable，讓修復迴圈對著「憑證本身就貼錯」這種
  // 只有使用者能修的事一直空轉重試，使用者也永遠不會被主動提醒去檢查 Client ID/Secret。
  if (/Google OAuth 憑證已失效|invalid_grant|Google OAuth 用戶端 ID.*不正確|invalid_client/i.test(e)) {
    return { reason: `${e}｜需人工：這是 Google OAuth 憑證問題，需要你本人到 Google Cloud Console 或 OAuth Playground 重新核對/走一次流程，AI 沒辦法自己生成或修好。`, resolution: "needs-human", category: "credentials", transient: false };
  }
  // ExcelJS/JSZip 對 CSV、HTML 錯誤頁或損毀下載檔會丟非常技術性的「central directory」錯誤。
  // 這不是選擇器或程式碼能修的問題；把真正要做的事直接講成白話，避免使用者傻等 AI 重跑。
  if (/can't find end of central directory|is this a zip file|end of central directory/i.test(e)) {
    return { reason: "這一步需要 Excel 活頁簿，但這次選到的檔案不是有效的 .xlsx/.xls 檔（可能選成 CSV、下載到登入頁，或檔案還沒下載完整）。請重新選原始 Excel 檔後再試，不需要叫 AI 重跑。", resolution: "needs-human", category: "data", transient: false };
  }
  // 缺少網址、端點或其他必要設定 ≠ 密碼錯誤。這類值 AI 不能憑空猜，直接點名缺什麼，不讓修復迴圈浪費時間。
  if (/執行前還缺少設定|尚未填入.*(網址|URL|端點|路徑|Chat ID)|尚未設定.*(?:OAuth|憑證)|沒有設定.*(網址|URL|端點|路徑)|缺少.*(網址|URL|端點|路徑)|Apps Script.*(?:版本|部署)|部署版本太舊|寫入服務還不能使用/i.test(e)) {
    return { reason: `${e}｜需人工：請依上面的提示更新對應節點或設定頁；這類外部網址／部署版本不是 AI 重跑能修好的。`, resolution: "needs-human", category: "configuration", transient: false };
  }
  // Apps Script 執行當下找不到指令碼函式(如 doGet)——真實踩過：同一份部署、完全沒改設定，
  // 這次失敗、幾分鐘後重跑就直接成功，是 Google Apps Script 執行環境偶發的暫時性問題，
  // 不是部署真的少了那個函式(那種情況會一直穩定失敗，不會重跑就好)。標成 transient 讓它自動重跑；
  // 若同一個部署真的持續失敗，MAX_AUTO_RETRIES 的上限會讓它幾次後照樣落回正常通知使用者。
  if (/Apps Script 執行失敗.{0,4}找不到以下指令碼函式|找不到以下指令碼函式.{0,10}doGet/i.test(e)) {
    return { reason: `${e}｜Apps Script 執行環境偶發問題，多半重跑就會成功，已排定自動重跑；若持續發生請確認 Apps Script 部署狀態。`, resolution: "needs-human", category: "configuration", transient: true };
  }
  // 外部視覺服務當下整體無回應，改節點設定/選擇器不會有用；但這是「服務暫時掛掉」而不是
  // 「設定本身有問題」——多半過幾分鐘服務就恢復了，重跑同一份設定很可能就直接成功。
  // 標成 transient，讓無人值守觸發的正式流程能自動排一次延後重跑，不用使用者自己想到要重試。
  if (/驗證碼視覺模型目前沒有回應|視覺模型.*(?:沒有回應|無回應|不可用)/i.test(e)) {
    return { reason: `${e}｜視覺服務目前不可用，改流程設定無法解決；Agent Hub 已停止自動空轉與 AI 修圖，會排一次延後自動重跑。`, resolution: "needs-human", category: "configuration", transient: true };
  }
  // 「自訂程式碼本來是空的，執行時臨時請 AI 產碼卻逾時」不是使用者的資料或設定問題。
  // 若只回報「節點逾時」，使用者會去亂改 sheet/欄位，修復 AI 也會誤猜 selector。要把真正
  // 卡住的是哪一層直接講出來，並交給整圖修復產出、保存完整程式碼。
  if (/正在由 AI 臨時產碼但.*沒有完成|沒有可執行程式碼.*AI.*產碼/i.test(e)) {
    return { reason: `${e}｜這不是資料或欄位設定錯誤，而是這個步驟沒有保存可執行程式碼。AI 會直接補完整程式碼並保存；不要重跑或手動調整其他節點。`, resolution: "ai-fixable", category: "ai-fixable", transient: false };
  }
  // ② 結構性/技術性問題 → AI 可修。這一類要排在「資料確認」前面判斷，因為它們的訊息裡也常含「請確認」，
  //    但真正的原因是流程邏輯/選擇器/資料接法(AI 改得動)，不是使用者要提供的值。
  //    特別是「{{變數}} 沒解析到/上游沒產出」這種資料流問題——原因在上游節點，整圖修復改得掉。
  if (/沒有解析到實際資料|上游節點|還沒有內容|還沒有程式碼|自訂步驟|程式碼.*錯誤|語法|選擇器|selector|逾時|超過|timeout|驗證碼|認證資訊檢查失敗|找不到.*元素|找不到搜尋框|element|網路|網絡|503|下載/i.test(e)) {
    return { reason: `${e}｜AI 可修：多半是流程邏輯、資料接法或網頁選擇器的問題，AI 會看整條流程+截圖自動修。`, resolution: "ai-fixable", category: "ai-fixable", transient: false };
  }
  // ③ 真的是「使用者要確認的值」(某封信不存在/報表名稱/日期輸入/目標頁面內容跟預期兜不上)才歸需人工——
  //    但自動測試迴圈仍會先讓 AI 試一次(整圖修復可能發現是上游把搜尋條件算錯了)，試過還是這類錯誤才真的停下來問使用者。
  //    「找不到目標頁面：沒有任何一頁符合...」這類是真實踩過的漏網之魚——原本的規則只認「信」，
  //    這種「掃過所有候選、內容真的對不上原本假設」的錯誤沒被歸類到，就掉到預設的 ai-fixable/unknown，
  //    讓修復迴圈對著「頁面內容跟業務現況不符」這種只有使用者知道答案的事，一直誤以為是選擇器問題而重複瞎猜。
  //    「找不到分頁: X」(Apps Script 寫入時回傳)是同一類漏網之魚——真實踩過：使用者解決 Apps Script
  //    部署/授權問題後緊接著撞上這個，AI 沒辦法連進使用者的 Google 試算表看裡面實際有哪些分頁，
  //    只能瞎猜著改設定，猜不中就一直卡著，使用者看起來像是「AI 修很久都沒改變」。
  //    excelProcess.ts 找不到指定欄位是同一種情境(一樣會列出實際欄位清單)，AI 一樣沒辦法連進
  //    使用者的真實檔案確認正確欄名，必須同樣歸類成需人工。
  if (/找不到.*信|搜尋不到.*信|查無|報表名稱|沒有寄|該日期.*沒有|這天.*沒有|日期設定互相矛盾|早於週增量結束日|不是公開的|分享設定|一般存取權|誰可以存取|重新部署|找不到目標(?:頁面|檔案)|找不到分頁|找不到.{0,20}欄|沒有(?:任何)?一(?:頁|筆|項|份|個|張).{0,6}(?:符合|對得上)/.test(e)) {
    return { reason: `${e}｜可能需人工：請確認日期、報表名稱、目標頁面等輸入是否正確；AI 也會先試著看是不是上游把搜尋條件算錯了。`, resolution: "needs-human", category: "data", transient: false };
  }
  // 預設：先讓 AI 試(很多 Playwright 英文錯誤其實是選擇器/暫時性問題)
  return { reason: `${e}｜先讓 AI 試修：看整條流程與截圖找原因。`, resolution: "ai-fixable", category: "unknown", transient: false };
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
    // 改用整圖感知修復(跟手動按「讓 AI 修」同一套)，不是只改回報失敗的那個節點——真正原因常常
    // 在上游沒把資料準備好的節點(見 aiRepairGraph 文件註解)。以前這裡用單節點的 aiRepairNode，
    // 手動修復跟自動監控失敗的修復能力不一致：對著錯的節點瞎改，真正的上游問題永遠修不到。
    const repair = await Promise.race([
      aiRepairGraph(client, model, workflowId, nodeId, error, runId, { apply: false }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("想修法逾時")), 5 * 60 * 1000)),
    ]);
    if (repair.edits.length === 0) throw new Error("沒有找到有效的修復方案");
    // 主要節點優先選「原本回報失敗的那個」(使用者最容易對上);真正原因在別的節點時，
    // 那格也會在 edits 裡、被存進 extraEdits，套用提案時一起套，不會漏掉。
    const primary = repair.edits.find((e) => e.nodeId === nodeId) ?? repair.edits[0];
    const extraEdits = repair.edits.filter((e) => e.nodeId !== primary.nodeId)
      .map((e) => ({ nodeId: e.nodeId, nodeLabel: e.nodeLabel, before: e.before, after: e.after }));
    createProposal({
      runId, workflowId, nodeId: primary.nodeId, nodeLabel: primary.nodeLabel, error,
      before: primary.before, after: primary.after, extraEdits,
    });
    const extraNote = extraEdits.length ? `(連同「${extraEdits.map((e) => e.nodeLabel).join("、")}」共 ${extraEdits.length + 1} 步)` : "";
    notifyDesktop(`「${wf.name}」AI 已經想好修法`, `「${primary.nodeLabel}」這步${extraNote}，打開 Agent Hub 看一鍵套用+重跑。`);
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

/**
 * 第一次失敗就已能確定「同一份設定、同一份輸入再跑一次不會變好」的情況。
 * 重試只留給網路短暫中斷、503 這類有機會自行恢復的問題；選擇器、欄位、分頁、語法、資料校驗
 * 等結構性錯誤重跑只會讓使用者多等幾分鐘，應立即留下失敗現場給 AI 修。
 */
export function isDeterministicValidationFailure(nodeType: string, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/互相矛盾|資料.{0,12}(?:不一致|對不上)|(?:校驗|驗證)(?:不通過|失敗)|早於.{0,12}(?:結束日|起始日)|晚於.{0,12}(?:結束日|起始日)/.test(message)) return true;
  if (/選擇器|selector|找不到.{0,12}(?:元素|欄位|分頁|標題|檔案)|沒有解析到實際資料|未解析(?:的)?(?:變數|欄位)|程式碼.{0,12}(?:語法|錯誤)|syntax error|is not defined|cannot read propert/i.test(message)) return true;
  // custom-code 本身的失敗幾乎都是相同 input 下的邏輯／欄位問題；真正網路暫時故障才保留一次重試。
  if (nodeType === "custom-code" && !/timeout|timed out|network|fetch failed|econn|503|502/i.test(message)) return true;
  return false;
}

async function runNodeWithRetry(node: WorkflowNode, ctx: NodeContext, retryable: boolean, configuredMaxAttempts?: number) {
  let lastErr: unknown;
  const maxAttempts = retryable
    ? Math.max(1, Math.min(MAX_ATTEMPTS, configuredMaxAttempts ?? MAX_ATTEMPTS))
    : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      ctx.log(`第 ${attempt} 次重試`);
      await new Promise<void>((resolve, reject) => {
        if (ctx.cancelSignal.aborted) return reject(new PermanentError("已停止執行"));
        const onAbort = () => { clearTimeout(timer); reject(new PermanentError("已停止執行")); };
        const timer = setTimeout(() => {
          ctx.cancelSignal.removeEventListener("abort", onAbort);
          resolve();
        }, RETRY_BACKOFF_MS[attempt - 2] ?? 9000);
        ctx.cancelSignal.addEventListener("abort", onAbort, { once: true });
      });
    }
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    // 個別接住 execute() 的 promise：Promise.race 逾時後這個 promise 還可能在背景繼續跑，
    // 之後(被 resetPage 關頁面)拋錯時若沒人接住會變成 unhandledRejection 讓整個 process 崩潰
    const nodeDef = getNodeDef(node.type)!;
    // 容器型節點(repeat-steps 一個節點做 N 輪工作)可以宣告自己的逾時上限,其餘用引擎預設
    const timeoutMs = nodeDef.timeoutMs ?? NODE_TIMEOUT_MS;
    // 每一次嘗試都有自己的中斷訊號。以前 Promise.race 只回「逾時」，真正的 fetch/AI/Claude
    // 子程序仍在背景跑；下一次重試又開一份，形成殭屍互踩。逾時時 abort 這一次，重試再拿新 signal。
    const attemptController = new AbortController();
    if (ctx.cancelSignal.aborted) attemptController.abort(ctx.cancelSignal.reason);
    const onRunAbort = () => attemptController.abort(ctx.cancelSignal.reason);
    ctx.cancelSignal.addEventListener("abort", onRunAbort, { once: true });
    const attemptCtx: NodeContext = { ...ctx, cancelSignal: attemptController.signal };
    const execPromise = nodeDef.execute(attemptCtx);
    execPromise.catch(() => {});
    try {
      const result = await Promise.race([
        execPromise,
        new Promise<never>((_, rej) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            const missingSavedCode = node.type === "custom-code" && isPlaceholderCode(node.config.code);
            const message = missingSavedCode
              ? `自訂步驟「${node.label}」沒有可執行程式碼，正在由 AI 臨時產碼但 ${timeoutMs / 1000} 秒內沒有完成；這不是 Excel、資料或其他節點設定的問題。`
              : `節點執行超過 ${timeoutMs / 1000} 秒`;
            attemptController.abort(new Error(message));
            rej(new RetryableError(message));
          }, timeoutMs);
        }),
      ]);
      return { result, attempt };
    } catch (err) {
      lastErr = err;
      if (timedOut) {
        // 逾時的那次操作可能還在背景跑(Playwright 沒有真正的取消)。強制關掉分頁讓它立刻拋錯結束，
        // 下一次重試會拿到全新分頁，不會跟殭屍操作同時搶同一頁(避免出現隨機、難重現的失敗)。
        await ctx.session.resetPage().catch(() => {});
        // 一次已經等到節點自己的完整時限，重跑同一份設定只會再等一次相同的時限；停止並把現場
        // 留給 AI 修，別讓使用者為了看到紅色錯誤卡還得白等第二、第三輪。
        const message = err instanceof Error ? err.message : String(err);
        throw new PermanentError(`${message}｜同一個節點已等到上限，系統不會用相同設定重跑；請直接讓 AI 依這次失敗現場修復。`);
      }
      if (err instanceof PermanentError || isDeterministicValidationFailure(node.type, err)) throw err;
      if (ctx.cancelSignal.aborted) throw err; // 使用者按了停止——別浪費重試次數重打一個注定失敗的呼叫
      if (!retryable) throw err;
    } finally {
      // 節點成功(或失敗)後一定清掉逾時計時器，不然每個節點留一個存活 3 分鐘的 timer，
      // 長流程累積一堆、也拖延伺服器優雅關機
      clearTimeout(timeoutId);
      ctx.cancelSignal.removeEventListener("abort", onRunAbort);
      if (!attemptController.signal.aborted) attemptController.abort(new Error("本次節點嘗試已結束"));
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
  const requiredSecretKeys = new Set((deriveRequiresSecrets(wf) ?? []).map((field) => field.key));
  const approvedOverrides = Object.fromEntries(
    Object.entries(item.secretOverrides ?? {}).filter(([key]) => requiredSecretKeys.has(key)),
  );
  const secrets = {
    ...getWorkflowSecretsForKeys(workflowId, requiredSecretKeys),
    // 只讀試跑可暫用對話這一輪附的讀取設定；正式 run 在入隊時已強制丟棄 overrides。
    ...approvedOverrides,
  };
  const session = makeSession(headed, workflowId);
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

  // 只讀驗證:是不是有「使用者直接給的檔案」——有的話，去信箱/瀏覽器抓輸入的那幾步可以略過改用這份檔案
  const dryRun = !!item.dryRun;
  const hasProvidedFile = dryRun && ["filePath", "attachmentPath", "savedPath", "inputFile"]
    .some((k) => typeof triggerParams[k] === "string" && (triggerParams[k] as string).length > 0);

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
  // 真實踩過的事故：一個節點失敗且沒接失敗分支時，以前是整個執行迴圈直接 break，不只擋住
  // 「真的依賴這個失敗節點」的下游，連完全獨立、沒有任何依賴關係的兄弟分支(例如同一顆
  // wait-approval 核准後同時要做的「寫入試算表」+「桌面通知」，寫入失敗)也一起放棄——
  // 使用者看到的是「明明要求同時做兩件事，其中一件失敗，另一件卻連跑都沒跑」。這個節點失敗後，
  // 只有真正依賴它的下游才該被跳過，其餘不相干的分支要繼續跑，記錄哪些節點是這樣失敗的。
  const unhandledFailedNodes = new Set<string>();
  // 這條 edge 是不是死的(不會有資料流過)：來源被 skip、來源有分支且這條的 fromPort 沒被選中、
  // 來源成功但這條是失敗分支、來源走了失敗分支但這條是正常出線、來源失敗且沒有失敗分支可接。
  const isEdgeDead = (e: { from: string; fromPort?: string }): boolean => {
    if (skipped.has(e.from)) return true;
    if (succeededNodes.has(e.from) && e.fromPort === "error") return true;
    if (errorRouted.has(e.from) && e.fromPort !== "error") return true;
    if (unhandledFailedNodes.has(e.from)) return true;
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
  /** 沒接失敗分支、但因為有不相干的獨立分支而讓迴圈繼續跑的失敗——run 最後仍算失敗，
   * 但總結要列出「還有哪些其他失敗」，不能因為只記第一個而讓使用者漏看其他也失敗的分支。 */
  const unhandledFailures: { label: string; error: string }[] = [];
  /** 只讀安全模式攔下的「寫出/操作外部系統」步驟——最後總結必須點名,不能只寫「執行成功」。
   * 真實踩過:使用者框選 5 步只測,其中關鍵的那步(點正式簡報的重新整理)被安全模式默默略過,
   * 總結卻只寫「完成 3 個步驟」,使用者完全不知道為什麼圈了 5 步只跑 2 步。 */
  const withheldWrites: string[] = [];

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
  // 會在很後面才寫入的外部服務，若有無副作用的能力檢查就先驗。這能避免登入、抓信、下載九步後，
  // 才發現最後的 Apps Script 還是舊版本。只讀驗證刻意略過寫入，所以不在那個模式攔截。
  if (!dryRun) {
    try {
      await preflightExternalIntegrations(wf, abortController.signal);
    } catch (error) {
      failed = true;
      failError = error instanceof Error ? error.message : String(error);
      if (error instanceof ExternalPreflightError) {
        failedNode = error.nodeId;
        failedNodeLabel = error.nodeLabel;
        db.prepare(`UPDATE node_runs SET status='failed', error=?, finished_at=datetime('now') WHERE run_id=? AND node_id=?`)
          .run(failError, runId, failedNode);
        log(runId, failedNode, `[${failedNodeLabel}] 執行前檢查失敗：${failError}`);
      }
    }
  }
  if (!failed) for (const node of order) {
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
        // 從中段起跑是「新的 run」，node_runs 全是 pending，要在這裡補上沿用的結果；
        // 失敗續跑(resumeRun)沿用的是同一筆 run 既有的成功列，不能重寫(會把純 output 蓋成合併值)。
        if (item.resume.skipUnseeded) {
          db.prepare(`UPDATE node_runs SET status='success', output_json=?, active_ports=?, finished_at=datetime('now') WHERE run_id=? AND node_id=?`)
            .run(JSON.stringify(seed), ports ? JSON.stringify(ports) : null, runId, node.id);
        }
        log(runId, node.id, item.resume.skipUnseeded
          ? `[${node.label}] ↩︎ 沿用最近一次執行的結果(這次只測後段)`
          : `[${node.label}] ↩︎ 沿用上次成功的結果(續跑不重跑這步)`);
        skipDeadDownstream(node.id);
        continue;
      }
      // 從中段開始測：沒有結果可沿用的上游一律「跳過」，絕不能掉進下面的正常執行——
      // 使用者就是要略過前面登入/抓信/寫入那段。缺的欄位會以 {{變數}} 警告老實浮出。
      if (item.resume.skipUnseeded) {
        db.prepare(`UPDATE node_runs SET status='skipped', finished_at=datetime('now') WHERE run_id=? AND node_id=?`).run(runId, node.id);
        log(runId, node.id, `[${node.label}] ⏭ 只測後段：跳過這步(沒有最近的結果可沿用)`);
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
    // 多個上游分支對同一個欄位輸出不同值時，以前只依連線順序留下最後一個、完全沒有任何提示——
    // 流程可能全綠、下游卻靜默拿到不是預期分支的資料。這裡不改變既有的合併行為(仍是「依連線
    // 順序、後面蓋過前面」，貿然改語意可能讓原本正常運作的分流圖表反而失敗)，但偵測到真的不同
    // 值時記一筆警告，讓衝突至少變成看得見的事，使用者/AI 修復迴圈才有機會發現並處理。
    if (upstreamIds.length > 1) {
      const seenFrom = new Map<string, { nodeId: string; value: unknown }>();
      for (const uid of upstreamIds) {
        for (const [k, v] of Object.entries(nodeOutputs.get(uid) ?? {})) {
          const prior = seenFrom.get(k);
          if (prior && JSON.stringify(prior.value) !== JSON.stringify(v)) {
            const priorLabel = wf.nodes.find((n) => n.id === prior.nodeId)?.label ?? prior.nodeId;
            const curLabel = wf.nodes.find((n) => n.id === uid)?.label ?? uid;
            log(runId, node.id, `⚠️ 欄位「${k}」同時被多個上游分支輸出不同的值(「${priorLabel}」與「${curLabel}」)——依連線順序這裡用的是「${curLabel}」的值；如果這不是預期的分支，請確認上游邏輯或改用明確的合併步驟`);
          }
          seenFrom.set(k, { nodeId: uid, value: v });
        }
      }
    }
    for (const uid of upstreamIds) Object.assign(input, nodeOutputs.get(uid) ?? {});
    // 也把 trigger 參數一路帶著方便引用(只補 input 還沒有的 key，上游算出的值優先)
    for (const [k, v] of Object.entries(triggerParams)) if (!(k in input)) input[k] = v;

    // ── 只讀驗證:略過會寫出/發送的步驟(不改使用者資料),使用者已給檔案時也略過去抓輸入的步驟 ──
    // 透傳 input 當這步的 output,下游還能引用上游算出的欄位(含使用者給的檔案路徑);當成功處理讓下游正常流。
    if (dryRun) {
      const skipKind = dryRunSkipKind(node, hasProvidedFile);
      if (skipKind) {
        if (skipKind === "write") withheldWrites.push(node.label);
        nodeOutputs.set(node.id, { ...input });
        db.prepare(`UPDATE node_runs SET status='skipped', input_json=?, finished_at=datetime('now') WHERE run_id=? AND node_id=?`)
          .run(JSON.stringify(input), runId, node.id);
        log(runId, node.id, skipKind === "write"
          ? `[${node.label}] 🔒 只讀驗證:略過這步——不會真的寫回/發送`
          : `[${node.label}] 🔒 只讀驗證:你已直接給檔案，略過去抓取這步、改用你給的檔案`);
        succeededNodes.add(node.id);
        successCount++;
        skipDeadDownstream(node.id);
        continue;
      }
    }

    db.prepare(`UPDATE node_runs SET status='running', input_json=?, started_at=datetime('now') WHERE run_id=? AND node_id=?`)
      .run(JSON.stringify(input), runId, node.id);
    log(runId, node.id, `[${node.label}] 開始`);

    const ctx: NodeContext = {
      runId,
      workflowId,
      nodeId: node.id,
      input,
      config: resolveDatesInConfig(withSchemaDefaults({
        ...node.config,
        ...(item.nodeConfigOverrides?.[node.id] ?? {}),
      }, def.configSchema), now),
      secrets,
      vars,
      model,
      baseUrl,
      apiKey,
      headed,
      outputDir,
      debugDir,
      session,
      dryRun,
      cancelSignal: abortController.signal,
      log: (msg: string) => log(runId, node.id, msg),
      registerFile: (filename, filePath, mime, kind = "output") => {
        let size = 0;
        try {
          size = fs.statSync(filePath).size;
        } catch {}
        db.prepare(
          `INSERT INTO run_files (run_id, workflow_id, filename, path, mime, size, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
        ).run(runId, workflowId, filename, filePath, mime, size, kind);
      },
    };

    try {
      const { result, attempt } = await runNodeWithRetry(node, ctx, def.retryable, def.maxAttempts);
      // 存進 nodeOutputs 的是「這個節點收到的 input + 它自己新增的欄位」，不是單純 result.output——
      // 這樣任何下游節點(不管中間隔了幾個節點)都能繼續用 {{欄位}} 引用更早以前算出來的資料。
      // 之前每個內建節點的 output 只回自己新增的那幾個欄位(只有 trigger/custom-code 手動 {...ctx.input})，
      // 資料經過 browser-login/find-email 這類節點就會不見——這正是「上游算好的日期，中間繞過一個節點
      // 就消失、下游拿到的是原封不動的 {{欄位}} 字面文字」的真實根因。改在這個唯一存放輸出的地方統一處理，
      // 不用去每個節點檔案裡各自補 spread、以後新增節點型別也不會漏。
      nodeOutputs.set(node.id, { ...input, ...result.output });
      // custom-code 的空殼在執行期才產碼,產出的碼若含寫出動作是在節點「裡面」被只讀防護攔住的
      // (回傳 success+標記,不走上面的 engine 層略過)——這種也算被攔下,總結一樣要點名。
      if (dryRun && result.output && (result.output as Record<string, unknown>)[DRY_RUN_SKIPPED_WRITES_KEY]) {
        withheldWrites.push(node.label);
      }
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

      // 節點失敗時,若它開過瀏覽器,自動把「當下頁面」截圖+存 HTML 到除錯目錄。
      // custom-code 自己開瀏覽器操作(例如抓 Google Drive 資料夾清單)失敗時,以前完全不留現場——
      // AI 修復(getLastFailureContext 從這個目錄讀 HTML/截圖)拿不到頁面,只能瞎換 selector、永遠收斂不了
      // (「明明登入成功了還一直說失敗、AI 怎麼修都修不好」的真實根因)。內建 browser-login 早就會存,
      // 這裡補上讓「任何節點」都存,不再漏掉 custom-code。使用者主動停止的不存(頁面已被強關、截圖也會失敗)。
      if (!isCancel) {
        const failPage = session.currentPage();
        if (failPage) {
          try {
            const dir = path.join(/* turbopackIgnore: true */ debugDir, node.id);
            fs.mkdirSync(dir, { recursive: true });
            await failPage.screenshot({ path: path.join(/* turbopackIgnore: true */ dir, "99-failure.png"), fullPage: true }).catch(() => {});
            await fs.promises.writeFile(path.join(/* turbopackIgnore: true */ dir, "99-failure.html"), await failPage.content()).catch(() => {});
            log(runId, node.id, `[${node.label}] 📸 已保存失敗當下的畫面與網頁內容(供 AI 修復和你自己檢視真正卡在哪)`);
          } catch { /* 存除錯現場失敗不能影響主流程 */ }
        }
      }

      // ── 失敗分支(Plan B)：節點接了 fromPort="error" 的出線，就不讓整條 run 倒下——
      //    把錯誤資訊當這個節點的輸出({{error}}/{{errorStep}})、只走失敗分支繼續跑。
      //    使用者按停止不走備案(他要的是停，不是 Plan B)。 ──
      const hasErrorBranch = wf.edges.some((e) => e.from === node.id && e.fromPort === "error");
      if (!isCancel && hasErrorBranch) {
        // active_ports 記 ["error"]:分支覆蓋率統計要知道「失敗分支真的被走過」(不只成功分支)
        db.prepare(`UPDATE node_runs SET status='failed', error=?, active_ports='["error"]', finished_at=datetime('now') WHERE run_id=? AND node_id=?`)
          .run(errMsg, runId, node.id);
        log(runId, node.id, `[${node.label}] 失敗：${errMsg}`);
        log(runId, node.id, `[${node.label}] 🆘 有接失敗分支——改走 Plan B 繼續執行`);
        nodeOutputs.set(node.id, { ...input, error: errMsg, errorStep: node.label });
        errorRouted.add(node.id);
        handledFailures.push({ label: node.label, error: errMsg });
        skipDeadDownstream(node.id); // 正常出線全死、只有失敗分支活著
        continue;
      }

      // 第一個失敗的節點決定 run 最後回報的主要原因(通知/AI 修復提案/失敗備援流程都認這個)；
      // 後面若還有其他不相干分支也失敗，記進 unhandledFailures，不覆蓋掉第一個。
      if (!failed) {
        failed = true;
        failError = errMsg;
        failedNode = node.id;
        failedNodeLabel = node.label;
      } else {
        unhandledFailures.push({ label: node.label, error: errMsg });
      }
      db.prepare(`UPDATE node_runs SET status='failed', error=?, finished_at=datetime('now') WHERE run_id=? AND node_id=?`)
        .run(errMsg, runId, node.id);
      log(runId, node.id, `[${node.label}] 失敗：${errMsg}`);
      // 只跳過「真的依賴這個失敗節點」的下游；不相干的獨立分支(如同一顆 wait-approval 核准後
      // 同時要做的另一件事)要繼續執行，不能因為這個節點沒接失敗分支就整條 run 直接放棄。
      unhandledFailedNodes.add(node.id);
      skipDeadDownstream(node.id);
      continue;
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
    markPendingNodeRunsSkipped(db, runId);
    // runWorkflowAndWait 的時間預算用 cancelRun 來確實中斷底層工作；以前沿用 USER_CANCELLED
    // 當內部控制碼，畫面卻顯示成「使用者取消」，讓人完全不知道實際是 AI/節點跑太久。
    const recordError = cause ? SYSTEM_TIMEOUT : USER_CANCELLED;
    const resolution = cause ? "ai-fixable" : "needs-human";
    db.prepare(`UPDATE runs SET status='failed', error=?, reason=?, resolution=?, failed_node=?, finished_at=datetime('now') WHERE id=?`)
      .run(recordError, reason, resolution, failedNode || null, runId);
    log(runId, null, cause ? "⏱ 系統時間預算用完，已停止執行" : "⏹ 使用者已停止執行");
  } else if (failed) {
    const { reason, resolution, transient } = classifyFailure(failError);
    // 其他不相干的獨立分支也失敗時要老實列出來，不能因為只回報第一個失敗就讓使用者以為
    // 只有那一步出事——他們是各自獨立的分支，每一個都可能需要個別處理。
    const otherFailuresNote = unhandledFailures.length > 0
      ? `\n\n另外「${unhandledFailures.map((f) => f.label).join("、")}」這幾個不相干的獨立分支也失敗了，已個別記錄原因，請逐一確認。`
      : "";
    const fullReason = (failedNodeLabel ? `在「${failedNodeLabel}」這步失敗：${reason}` : reason) + otherFailuresNote;
    db.prepare(`UPDATE runs SET status='failed', error=?, reason=?, resolution=?, failed_node=?, finished_at=datetime('now') WHERE id=?`)
      .run(failError, fullReason, resolution, failedNode || null, runId);
    log(runId, null, `❌ 執行失敗：${fullReason}`);
    // 無人值守觸發(排程/資料夾監聽/webhook)的失敗一定要主動通知——這是使用者唯一能知道「沒跑成功」的管道，不然只能自己想到才會去開網頁看
    if (trigger !== "manual") {
      // 判定為「外部服務暫時性問題」(不是邏輯/帳密/設定問題)時，AI 改設定沒用，但重跑同一份設定
      // 很可能就直接成功——正式流程排一次延後自動重跑，不用使用者自己想到要手動重試(真實踩過的
      // 抱怨：「失敗要重複跑啊，不然就停滯了」)。用 __retryAttempt 帶在觸發參數裡數第幾次重試，
      // 超過上限就不再排、退回原本的通知流程，避免真的卡死的東西無限重試下去。
      const retryAttempt = Number(triggerParams.__retryAttempt ?? 0);
      const willAutoRetry = transient && wf.status === "official" && !dryRun && retryAttempt < MAX_AUTO_RETRIES;
      if (willAutoRetry) {
        const nextAttempt = retryAttempt + 1;
        const retryParams = { ...triggerParams, __retryAttempt: nextAttempt };
        db.prepare(
          `INSERT INTO pending_retries (id, workflow_id, trigger_params_json, attempt, retry_at, original_trigger, created_at, run_id) VALUES (?,?,?,?,datetime('now', ?),?,datetime('now'),?)`,
        ).run(randomUUID(), workflowId, JSON.stringify(retryParams), nextAttempt, `+${AUTO_RETRY_DELAY_MINUTES} minutes`, trigger, runId);
        notifyDesktop(
          `「${wf.name}」${TRIGGER_LABEL[trigger]}執行失敗`,
          `${fullReason.slice(0, 150)}｜判斷是外部服務暫時性問題，已排定 ${AUTO_RETRY_DELAY_MINUTES} 分鐘後自動重跑(第 ${nextAttempt}/${MAX_AUTO_RETRIES} 次)`,
        );
        log(runId, null, `🔁 判定為暫時性問題，已排定 ${AUTO_RETRY_DELAY_MINUTES} 分鐘後自動重跑(第 ${nextAttempt}/${MAX_AUTO_RETRIES} 次)`);
      } else if (resolution === "ai-fixable" && wf.status === "official" && failedNode) {
        // 正式流程無人值守失敗且看起來 AI 修得好：在背景讓 AI 想一個修法提案(不自動套用，不影響正式在跑的設定)，
        // 想好之後通知裡順便講一句「AI 已經想好怎麼修」，使用者開網頁就能一鍵套用+重跑，不用自己動手找問題。
        notifyDesktop(`「${wf.name}」${TRIGGER_LABEL[trigger]}執行失敗`, `${fullReason.slice(0, 150)}｜AI 正在想辦法修…`);
        proposeFixInBackground(workflowId, runId, failedNode, failedNodeLabel, failError).catch(() => {});
      } else {
        notifyDesktop(`「${wf.name}」${TRIGGER_LABEL[trigger]}執行失敗`, fullReason.slice(0, 200));
      }
    }
    // ── 全域備援：這條流程設定了「失敗時自動執行另一條流程」就把它叫起來(帶失敗現場資訊)。
    //    __errorHop 防連鎖迴圈：備援流程自己也失敗、又指回來 → 最多跳 2 層就停。
    //    只讀試跑(dryRun)失敗不能觸發——備援流程通常會真的寫入/通知，試跑的失敗只是「證明看懂了沒」，
    //    不該因此打一輪真的備援動作。 ──
    if (wf.onFailureWorkflow && dryRun) {
      log(runId, null, `🔒 設定了失敗備援流程「${wf.onFailureWorkflow}」，但這是只讀試跑，不觸發真正的備援動作`);
    } else if (wf.onFailureWorkflow) {
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
    // 部分執行(框選幾步/從某步開始測)裡「使用者明確選了、卻沒有真的執行」的步驟,總結必須逐一講明原因:
    // ①被只讀安全模式攔下(寫入/發送/操作外部系統)②分流沒走到的分支。不講清楚的話,使用者看到
    // 「圈 5 步只跑 2 步」只會以為壞掉了(真實踩過的抱怨),而不知道這是安全設計+分支語意。
    const selectedIds = item.resume?.skipUnseeded ? item.resume.rerunNodeIds : null;
    const label = (nid: string) => wf.nodes.find((n) => n.id === nid)?.label ?? nid;
    const selectedDeadBranch = selectedIds
      ? selectedIds.filter((nid) => skipped.has(nid)).map(label)
      : [];
    const withheldNote = withheldWrites.length > 0
      ? `🔒 其中「${withheldWrites.join("、")}」會真的寫入、發送或操作外部系統——測試模式為了不動到正式資料，刻意沒有執行這${withheldWrites.length > 1 ? "幾" : "一"}步(前面的讀取/計算都是真的跑過)。確認流程沒問題後，按「▶ 執行」完整執行才會真的做。`
      : "";
    const deadBranchNote = selectedDeadBranch.length > 0
      ? `⏭「${selectedDeadBranch.join("、")}」是分流沒走到的分支，這次本來就不需要執行。`
      : "";
    const reason =
      `執行成功，完成 ${successCount} 個步驟。` +
      withheldNote +
      deadBranchNote +
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
export function isPidAlive(pid: number): boolean {
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
  // API／頁面只需要這些欄位。絕不能 SELECT *：runs 內還有正式執行用的一次性 secret overrides、
  // node config overrides 與 owner_pid；把它們順手序列化到瀏覽器既沒必要，也會擴大敏感資料暴露面。
  return db.prepare(`
    SELECT id, workflow_id, status, trigger_type, headed, dry_run, reason, resolution, failed_node, error, started_at, finished_at
    FROM runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 20
  `).all(workflowId);
}
