import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { DEFAULT_MODEL } from "../models";
import { getWorkflowModel, setWorkflowModel } from "../settingsStore";
// 注意：registry→customCode→store 形成模組循環，但 getNodeDef 只在函式執行期被呼叫(不在模組初始化期)，
// ESM 對這種「延遲取用」的循環是安全的。不要在模組頂層直接取用 registry 的值。
import { getNodeDef } from "./registry";
import type { Workflow } from "./types";

const EXAMPLES_DIR = path.join(process.cwd(), "examples");
const USER_DIR = path.join(process.cwd(), "data", "workflows");

function ensureUserDir() {
  fs.mkdirSync(USER_DIR, { recursive: true });
}

/** workflow id 只允許安全字元，擋掉 ../ 之類的路徑穿越 */
export function isValidWorkflowId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}
function assertValidId(id: string) {
  if (!isValidWorkflowId(id)) throw new Error(`不合法的 workflow id：${id}`);
}

function readWorkflowFile(file: string, builtinDefault: boolean): Workflow | null {
  if (!fs.existsSync(file)) return null;
  // 單一檔案壞掉(手動編輯打錯字、或極端情況下寫到一半斷電)不能讓整個列表頁連鎖炸掉——
  // parse 失敗就當這個檔不存在，其他 workflow 照常運作，使用者還能從版本備份還原這一個。
  let raw: Partial<Workflow>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<Workflow>;
  } catch {
    console.error(`workflow 檔案損毀，已跳過：${file}(可到該流程的版本紀錄還原)`);
    return null;
  }
  if (!raw.id) return null;
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    status: raw.status ?? (builtinDefault ? "official" : "draft"),
    builtin: raw.builtin ?? builtinDefault,
    description: raw.description ?? "",
    longDescription: raw.longDescription,
    defaultModel: raw.defaultModel ?? DEFAULT_MODEL,
    requiresSecrets: raw.requiresSecrets ?? [],
    triggerParams: raw.triggerParams ?? [],
    onFailureWorkflow: raw.onFailureWorkflow,
    nodes: raw.nodes ?? [],
    edges: raw.edges ?? [],
  };
}

function workflowPath(id: string): { file: string; builtin: boolean } {
  assertValidId(id);
  const userFile = path.join(USER_DIR, `${id}.json`);
  if (fs.existsSync(userFile)) return { file: userFile, builtin: false };
  return { file: path.join(EXAMPLES_DIR, `${id}.json`), builtin: true };
}

export function listWorkflows(): Workflow[] {
  const map = new Map<string, Workflow>();
  if (fs.existsSync(EXAMPLES_DIR)) {
    for (const f of fs.readdirSync(EXAMPLES_DIR)) {
      if (!f.endsWith(".json")) continue;
      const wf = readWorkflowFile(path.join(EXAMPLES_DIR, f), true);
      if (wf) map.set(wf.id, wf);
    }
  }
  if (fs.existsSync(USER_DIR)) {
    for (const f of fs.readdirSync(USER_DIR)) {
      if (!f.endsWith(".json")) continue;
      const wf = readWorkflowFile(path.join(USER_DIR, f), false);
      if (wf) map.set(wf.id, wf);
    }
  }
  return Array.from(map.values());
}

export function getWorkflow(id: string): Workflow | null {
  const { file, builtin } = workflowPath(id);
  return readWorkflowFile(file, builtin);
}

/**
 * 依「id 或名稱」找流程(執行子流程節點、失敗備援流程共用同一套解析)。
 * getWorkflow 對「不像 id 的字串」(如中文名稱)會直接 throw(路徑穿越防護)，要先驗格式再走 id 路。
 * 名稱重複時回 null(呼叫端自己決定要不要提示改用 id)——需要區分「重名」的呼叫端用 findWorkflowsByName。
 */
export function findWorkflowsByName(name: string): Workflow[] {
  return listWorkflows().filter((w) => w.name === name);
}
export function findWorkflowByRef(ref: string): Workflow | null {
  const byId = /^[a-zA-Z0-9_-]{1,80}$/.test(ref) ? getWorkflow(ref) : null;
  if (byId) return byId;
  const hits = findWorkflowsByName(ref);
  return hits.length === 1 ? hits[0] : null;
}

export function isBuiltin(id: string): boolean {
  return workflowPath(id).builtin;
}

function syncMeta(wf: Workflow) {
  const db = getDb();
  db.prepare(
    `INSERT INTO workflows_meta (id, name, status, builtin, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status, builtin=excluded.builtin, updated_at=excluded.updated_at`,
  ).run(wf.id, wf.name, wf.status, wf.builtin ? 1 : 0);
}

/**
 * 儲存到 data/workflows/（使用者版）。內建範例透過此函式儲存 = 自動變成使用者版覆蓋。
 *
 * 存檔前一定先備份「即將被覆蓋的現有版本」——不管呼叫方是誰、透過哪個 API(AI 套用流程圖、拖節點位置、
 * 改單一節點設定、連線、刪除節點...)。這是唯一的存檔進入點，把備份做在這裡而不是每個呼叫方各自負責，
 * 才能保證「以後任何存檔動作都留得住上一步可以復原」——包含未來新寫的程式路徑，不會有人忘記加備份。
 * (踩過的教訓：曾經只有 build 路徑會呼叫 backupWorkflow，直接 PATCH 的路徑沒有，一次不小心的錯誤寫入
 * 就把整個流程覆蓋掉、還沒有任何版本可以還原。)
 */
/**
 * 從節點圖自動推導這條流程需要哪些帳密欄位(併上既有宣告，依 key 去重)。
 * 為什麼要自動推導：設定頁的帳密輸入框完全來自 requiresSecrets，而 AI 從零建的圖沒有人手動宣告——
 * 不推導的話，含登入/通知節點的流程使用者根本沒有地方填帳密，卡死在「尚未填入帳密」。
 */
function deriveRequiresSecrets(wf: Workflow): Workflow["requiresSecrets"] {
  const byKey = new Map((wf.requiresSecrets ?? []).map((f) => [f.key, f]));
  for (const node of wf.nodes) {
    const def = getNodeDef(node.type);
    for (const f of def?.secretFields?.(node.config ?? {}) ?? []) {
      if (!byKey.has(f.key)) byKey.set(f.key, f);
    }
  }
  return [...byKey.values()];
}

export function saveWorkflow(wf: Workflow): void {
  assertValidId(wf.id);
  ensureUserDir();
  backupWorkflow(wf.id);
  // repeat-steps 的 steps 全系統的不變量是「JSON 字串」(lint/說明/截短/persistStepCode 都這樣讀)，
  // 但 AI 建圖常直接給真陣列——在唯一的存檔入口正規化成字串，下游全部不用各自防
  // (實測踩過：真陣列被 String() 成 "[object Object]"，節點直接炸，還得靠修復迴圈燒一輪 AI 救)。
  const nodes = wf.nodes.map((n) =>
    n.type === "repeat-steps" && Array.isArray(n.config?.steps)
      ? { ...n, config: { ...n.config, steps: JSON.stringify(n.config.steps) } }
      : n,
  );
  const normalized: Workflow = { ...wf, nodes };
  const toSave: Workflow = { ...normalized, builtin: false, requiresSecrets: deriveRequiresSecrets(normalized) };
  // 原子寫入：先寫暫存檔再 rename(同一檔案系統內 rename 是原子的)。
  // 直接 writeFileSync 寫到一半程式崩潰/斷電，會留下半截 JSON，整個 workflow 檔就毀了。
  // 暫存檔名必須帶 pid+隨機值：同一顆資料目錄可能有兩個進程(daemon 常駐 + 使用者又開 dev)同時存
  // 同一個 workflow，固定檔名會讓兩邊寫進同一個 .tmp、交錯出半截 JSON 再 rename 上去(整檔損毀)。
  const target = path.join(USER_DIR, `${wf.id}.json`);
  const tmp = `${target}.${process.pid}-${randomUUID().slice(0, 6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(toSave, null, 2));
  fs.renameSync(tmp, target);
  syncMeta(toSave);
}

export function createWorkflow(name: string): Workflow {
  const id = `wf-${randomUUID().slice(0, 8)}`;
  const wf: Workflow = {
    id,
    name,
    status: "draft",
    builtin: false,
    description: "",
    defaultModel: DEFAULT_MODEL,
    requiresSecrets: [],
    triggerParams: [],
    nodes: [
      { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 250, y: 40 } },
    ],
    edges: [],
  };
  saveWorkflow(wf);
  return wf;
}

export function copyWorkflow(id: string): Workflow | null {
  const src = getWorkflow(id);
  if (!src) return null;
  const newId = `${id}-copy-${randomUUID().slice(0, 6)}`;
  const copy: Workflow = {
    ...src,
    id: newId,
    name: `${src.name}(複製)`,
    status: "draft",
    builtin: false,
  };
  saveWorkflow(copy);
  // 模型選擇存在 wf_model 表(不在 workflow JSON 裡)，複製時要一起帶過去，
  // 不然原本特意選了 minimax-m3/Claude Code 的流程，複製出來會悄悄退回預設模型
  setWorkflowModel(newId, getWorkflowModel(id, src.defaultModel));
  return copy;
}

export function deleteWorkflow(id: string): void {
  assertValidId(id);
  const userFile = path.join(USER_DIR, `${id}.json`);
  if (fs.existsSync(userFile)) fs.rmSync(userFile);
  fs.rmSync(historyDir(id), { recursive: true, force: true }); // 版本備份也一起清掉，不然刪了的 workflow 留著孤兒備份資料夾
  // 連帶清掉所有跟這個 workflow 綁定的資料，不留孤兒(執行紀錄/產出檔紀錄/排程/模型選擇/AI修法提案/除錯截圖/產出檔)
  const db = getDb();
  const runIds = (db.prepare(`SELECT id FROM runs WHERE workflow_id = ?`).all(id) as { id: string }[]).map((r) => r.id);
  db.prepare(`DELETE FROM workflows_meta WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM wf_model WHERE workflow_id = ?`).run(id);
  db.prepare(`DELETE FROM schedules WHERE workflow_id = ?`).run(id);
  db.prepare(`DELETE FROM fix_proposals WHERE workflow_id = ?`).run(id);
  db.prepare(`DELETE FROM run_files WHERE workflow_id = ?`).run(id);
  db.prepare(`DELETE FROM watch_seen WHERE workflow_id = ?`).run(id);
  db.prepare(`DELETE FROM approvals WHERE workflow_id = ?`).run(id); // 待簽核的也一併作廢，首頁不能留「已刪除流程」的簽核卡
  for (const runId of runIds) {
    db.prepare(`DELETE FROM node_runs WHERE run_id = ?`).run(runId);
    db.prepare(`DELETE FROM run_logs WHERE run_id = ?`).run(runId);
    fs.rmSync(path.join(process.cwd(), "data", "runs", runId), { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), "data", "outputs", runId), { recursive: true, force: true });
  }
  db.prepare(`DELETE FROM runs WHERE workflow_id = ?`).run(id);
}

// 現在每一次 saveWorkflow() 都會呼叫這裡(不只是 AI 套用流程圖)，次數比以前多很多，
// 保留份數跟著拉高，不然頻繁的小改動(如拖節點位置)會把有意義的舊版本擠出 30 份的視窗。
const MAX_BACKUPS = 60;

function historyDir(id: string): string {
  return path.join(USER_DIR, "history", id);
}

/** 去掉節點座標後序列化——用來判斷「這次存檔是不是只有拖動節點位置、內容根本沒變」 */
function serializeWithoutPositions(wf: Workflow): string {
  return JSON.stringify({ ...wf, nodes: wf.nodes.map((n) => ({ ...n, position: undefined })) });
}

/**
 * 存版本備份，可還原。saveWorkflow() 內部會自動呼叫，不需要呼叫方自己記得。
 * 只保留最近 60 份，不然會無限長大。兩種情況跳過、不浪費名額：
 * ①內容跟最新一份備份完全一樣(同一份資料被存兩次)；
 * ②跟最新一份備份只差在「節點座標」——使用者在畫布上反覆拖動排版，一次拖動就吃掉一個名額的話，
 *   拖 60 次就會把「AI 改壞前」這種真正想還原的版本擠出視窗永久刪除。座標不值得佔版本名額。
 */
export function backupWorkflow(id: string): void {
  const wf = getWorkflow(id);
  if (!wf) return;
  const dir = historyDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const serialized = JSON.stringify(wf, null, 2);

  const existing = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  const latest = existing[existing.length - 1];
  if (latest) {
    const latestRaw = fs.readFileSync(path.join(dir, latest), "utf-8");
    if (latestRaw === serialized) return;
    try {
      if (serializeWithoutPositions(JSON.parse(latestRaw) as Workflow) === serializeWithoutPositions(wf)) return;
    } catch {
      // 最新備份壞了就照常再存一份新的
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(dir, `${ts}.json`), serialized);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const excess = files.length - MAX_BACKUPS;
  if (excess > 0) {
    for (const f of files.slice(0, excess)) fs.rmSync(path.join(dir, f));
  }
}

export interface BackupInfo { filename: string; timestamp: string; name: string; nodeCount: number }

/** 列出這個 workflow 所有版本備份(新到舊)，讓使用者看得到「AI 改了什麼、什麼時候改的」並可以還原 */
export function listBackups(id: string): BackupInfo[] {
  assertValidId(id);
  const dir = historyDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .map((filename) => {
      try {
        const wf = JSON.parse(fs.readFileSync(path.join(dir, filename), "utf-8")) as Workflow;
        // 檔名格式固定是 ISO 時間把 : 和 . 換成 -(見 backupWorkflow)，直接抓回來組成好讀的時間
        const m = filename.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-\d+Z\.json$/);
        const timestamp = m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : filename;
        return { filename, timestamp, name: wf.name, nodeCount: wf.nodes?.length ?? 0 };
      } catch {
        return null;
      }
    })
    .filter((b): b is BackupInfo => b !== null);
}

/** 還原到某個版本備份：先把「還原前的現況」也存一份備份(還原本身可逆)，再套用備份內容 */
export function restoreBackup(id: string, filename: string): Workflow | null {
  assertValidId(id);
  if (!/^[0-9T-]+Z\.json$/.test(filename)) throw new Error("不合法的備份檔名");
  const dir = historyDir(id);
  const backupPath = path.join(dir, filename);
  if (!fs.existsSync(backupPath)) return null;
  const backup = JSON.parse(fs.readFileSync(backupPath, "utf-8")) as Workflow;
  const current = getWorkflow(id);
  backupWorkflow(id); // 現況也存一份，還原這個動作本身還能再復原
  // 只還原「內容」(節點/連線/參數/名稱)，不還原 status——不然還原一個當初是草稿時存的備份，
  // 會把現在已經是正式的流程偷偷變回草稿(連帶讓之後手動執行變成有頭瀏覽器)。status 維持現況。
  const restored: Workflow = { ...backup, id, builtin: false, status: current?.status ?? backup.status };
  saveWorkflow(restored);
  return restored;
}
