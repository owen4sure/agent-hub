import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "../db";
import { DEFAULT_MODEL } from "../models";
import { getWorkflowModel, setWorkflowModel } from "../settingsStore";
// 注意：registry→customCode→store 形成模組循環，但 getNodeDef 只在函式執行期被呼叫(不在模組初始化期)，
// ESM 對這種「延遲取用」的循環是安全的。不要在模組頂層直接取用 registry 的值。
import { getNodeDef } from "./registry";
import { separateOverlappingNodes } from "./layout";
import { copyChatAttachmentsForWorkflow, deleteChatAttachmentsForWorkflow } from "../chatAttachments";
import { deleteWorkflowChatState, getWorkflowChatState } from "./chatStateStore";
import type { Workflow } from "./types";

const EXAMPLES_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "examples");
const USER_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "workflows");
const WORKFLOW_BASE = Symbol.for("agent-hub.workflow-base");

type VersionedWorkflow = Workflow & { [WORKFLOW_BASE]?: Workflow };

export class WorkflowConflictError extends Error {
  constructor(message = "流程同時被另一個視窗或背景程序修改；為了不蓋掉資料，這次沒有存檔，請重試一次") {
    super(message);
    this.name = "WorkflowConflictError";
  }
}

function ensureUserDir() {
  fs.mkdirSync(/* turbopackIgnore: true */ USER_DIR, { recursive: true });
}

/** workflow id 只允許安全字元，擋掉 ../ 之類的路徑穿越 */
export function isValidWorkflowId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}
function assertValidId(id: string) {
  if (!isValidWorkflowId(id)) throw new Error(`不合法的 workflow id：${id}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneWorkflow(wf: Workflow): Workflow {
  return JSON.parse(JSON.stringify(wf)) as Workflow;
}

/** 把載入當下的內容藏在 symbol（JSON 不會輸出、object spread 會保留），供 saveWorkflow 做三方合併。 */
function attachWorkflowBase(wf: Workflow): Workflow {
  Object.defineProperty(wf, WORKFLOW_BASE, { value: cloneWorkflow(wf), enumerable: true, configurable: false });
  return wf;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeRecord(base: Record<string, unknown>, desired: Record<string, unknown>, latest: Record<string, unknown>, pathLabel: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(desired), ...Object.keys(latest)])) {
    const value = mergeValue(base[key], desired[key], latest[key], `${pathLabel}.${key}`);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function mergeNodes(baseRaw: unknown[], desiredRaw: unknown[], latestRaw: unknown[], pathLabel: string): unknown[] {
  const idOf = (value: unknown): string | null => isPlainObject(value) && typeof value.id === "string" ? value.id : null;
  if ([...baseRaw, ...desiredRaw, ...latestRaw].some((value) => !idOf(value))) {
    throw new WorkflowConflictError(`流程的 ${pathLabel} 同時被兩個程序修改，且內容無法安全辨識；這次沒有覆蓋`);
  }
  const base = new Map(baseRaw.map((value) => [idOf(value)!, value]));
  const desired = new Map(desiredRaw.map((value) => [idOf(value)!, value]));
  const latest = new Map(latestRaw.map((value) => [idOf(value)!, value]));
  const orderedIds = [...latest.keys(), ...desired.keys()].filter((id, index, all) => all.indexOf(id) === index);
  const out: unknown[] = [];
  for (const id of orderedIds) {
    const b = base.get(id);
    const d = desired.get(id);
    const l = latest.get(id);
    if (b === undefined) {
      if (d !== undefined && l !== undefined && !same(d, l)) throw new WorkflowConflictError(`節點「${id}」被兩邊同時新增成不同內容；這次沒有覆蓋`);
      if (d !== undefined || l !== undefined) out.push(d ?? l);
      continue;
    }
    if (d === undefined) {
      if (l !== undefined && !same(l, b)) throw new WorkflowConflictError(`節點「${id}」一邊被刪除、一邊又被修改；這次沒有覆蓋`);
      continue;
    }
    if (l === undefined) {
      if (!same(d, b)) throw new WorkflowConflictError(`節點「${id}」一邊被刪除、一邊又被修改；這次沒有覆蓋`);
      continue;
    }
    out.push(mergeValue(b, d, l, `${pathLabel}.${id}`));
  }
  return out;
}

function mergeEdges(base: unknown[], desired: unknown[], latest: unknown[]): unknown[] {
  const key = (value: unknown) => JSON.stringify(value);
  const baseKeys = new Set(base.map(key));
  const desiredKeys = new Set(desired.map(key));
  const removedByDesired = new Set([...baseKeys].filter((item) => !desiredKeys.has(item)));
  const out = latest.filter((item) => !removedByDesired.has(key(item)));
  const outKeys = new Set(out.map(key));
  for (const item of desired) {
    const k = key(item);
    if (!baseKeys.has(k) && !outKeys.has(k)) { out.push(item); outKeys.add(k); }
  }
  return out;
}

function mergeValue(base: unknown, desired: unknown, latest: unknown, pathLabel: string): unknown {
  if (same(desired, base)) return latest;
  if (same(latest, base) || same(desired, latest)) return desired;
  if (Array.isArray(base) && Array.isArray(desired) && Array.isArray(latest)) {
    if (pathLabel === "workflow.nodes") return mergeNodes(base, desired, latest, pathLabel);
    if (pathLabel === "workflow.edges") return mergeEdges(base, desired, latest);
  }
  if (isPlainObject(base) && isPlainObject(desired) && isPlainObject(latest)) {
    return mergeRecord(base, desired, latest, pathLabel);
  }
  throw new WorkflowConflictError(`流程的「${pathLabel.replace(/^workflow\./, "") || "內容"}」同時被修改；這次沒有覆蓋任何一邊`);
}

/**
 * 兩個 Node 行程都從同一基線開始修改時做三方合併。位置與 config 可各自保留；同一欄位真的互撞才拒絕。
 * 匯出給回歸測試，正式路徑只由 saveWorkflow 在跨進程鎖內呼叫。
 */
export function mergeWorkflowWithLatest(base: Workflow, desired: Workflow, latest: Workflow): Workflow {
  return mergeValue(base, desired, latest, "workflow") as Workflow;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** mkdir 是跨進程原子的；把「檢查最新版→備份→rename→同步 DB」包在同一把 workflow 鎖。 */
function withWorkflowFileLock<T>(target: string, fn: () => T): T {
  const lockDir = `${target}.lock`;
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")) as { pid?: number; createdAt?: number };
        if (!processAlive(Number(owner.pid)) || Date.now() - Number(owner.createdAt ?? 0) > 5 * 60_000) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        try {
          if (Date.now() - fs.statSync(lockDir).mtimeMs > 30_000) { fs.rmSync(lockDir, { recursive: true, force: true }); continue; }
        } catch { /* 下一圈重試 */ }
      }
      if (Date.now() >= deadline) throw new WorkflowConflictError("另一個 Agent Hub 程序正在存這條流程；等了 5 秒仍未完成，這次沒有覆蓋，請再試一次");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
}

/**
 * JSON.parse 成功不代表內容能用。這層只驗「載入後所有頁面都可安全讀取」的結構；圖是否能執行
 * 另外由 graphLint／引擎閘門判斷，讓有邏輯錯誤的草稿仍可打開修復，而不是整份消失。
 */
function isWorkflowFileShape(raw: unknown, expectedId: string): raw is Workflow {
  if (!isPlainObject(raw) || raw.id !== expectedId || !isValidWorkflowId(expectedId)) return false;
  if (typeof raw.name !== "string" || (raw.status !== "draft" && raw.status !== "official")) return false;
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || raw.nodes.length > 1_000 || raw.edges.length > 5_000) return false;
  if (!raw.nodes.every((node) =>
    isPlainObject(node) &&
    typeof node.id === "string" &&
    typeof node.type === "string" &&
    typeof node.label === "string" &&
    isPlainObject(node.config) &&
    isPlainObject(node.position) &&
    typeof node.position.x === "number" && Number.isFinite(node.position.x) &&
    typeof node.position.y === "number" && Number.isFinite(node.position.y)
  )) return false;
  if (!raw.edges.every((edge) =>
    isPlainObject(edge) && typeof edge.from === "string" && typeof edge.to === "string" &&
    (edge.fromPort === undefined || typeof edge.fromPort === "string")
  )) return false;
  if (raw.triggerParams !== undefined && (!Array.isArray(raw.triggerParams) || !raw.triggerParams.every((field) =>
    isPlainObject(field) && typeof field.key === "string" && typeof field.label === "string" && typeof field.type === "string" &&
    (field.default === undefined || typeof field.default === "string") &&
    (field.help === undefined || typeof field.help === "string") &&
    (field.options === undefined || (Array.isArray(field.options) && field.options.every((item) => typeof item === "string"))) &&
    (field.derived === undefined || typeof field.derived === "boolean")
  ))) return false;
  if (raw.requiresSecrets !== undefined && (!Array.isArray(raw.requiresSecrets) || !raw.requiresSecrets.every((field) =>
    isPlainObject(field) && typeof field.key === "string" && typeof field.label === "string" &&
    (field.type === "text" || field.type === "password")
  ))) return false;
  if (raw.description !== undefined && typeof raw.description !== "string") return false;
  if (raw.longDescription !== undefined && typeof raw.longDescription !== "string") return false;
  if (raw.defaultModel !== undefined && typeof raw.defaultModel !== "string") return false;
  if (raw.onFailureWorkflow !== undefined && typeof raw.onFailureWorkflow !== "string") return false;
  if (raw.group !== undefined && typeof raw.group !== "string") return false;
  if (raw.copyHandoff !== undefined && (!isPlainObject(raw.copyHandoff) || typeof raw.copyHandoff.sourceName !== "string" || typeof raw.copyHandoff.summary !== "string" || typeof raw.copyHandoff.copiedAt !== "string" ||
    (raw.copyHandoff.attachments !== undefined && (!Array.isArray(raw.copyHandoff.attachments) || !raw.copyHandoff.attachments.every((item) => isPlainObject(item) && typeof item.assetId === "string" && typeof item.name === "string" && (item.kind === "file" || item.kind === "image")))))) return false;
  return true;
}

function readWorkflowFile(scope: "example" | "user", filename: string): Workflow | null {
  // Keep the dynamic filename visibly scoped at the filesystem call. Passing an
  // arbitrary absolute `file` into readFileSync makes Next's NFT tracer assume
  // this route could read the entire repository and bloats every server trace.
  const scopedFile = scope === "user"
    ? path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "workflows", filename)
    : path.join(/*turbopackIgnore: true*/ process.cwd(), "examples", filename);
  if (!fs.existsSync(/* turbopackIgnore: true */ scopedFile)) return null;
  // 單一檔案壞掉(手動編輯打錯字、或極端情況下寫到一半斷電)不能讓整個列表頁連鎖炸掉——
  // parse 失敗就當這個檔不存在，其他 workflow 照常運作，使用者還能從版本備份還原這一個。
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ scopedFile, "utf-8"));
  } catch {
    console.error(`workflow 檔案損毀，已跳過：${scopedFile}(可到該流程的版本紀錄還原)`);
    return null;
  }
  const expectedId = path.basename(filename, ".json");
  if (!isWorkflowFileShape(parsed, expectedId)) {
    console.error(`workflow 檔案結構不完整或 id 與檔名不一致，已跳過：${scopedFile}(可從版本紀錄還原)`);
    return null;
  }
  const raw = parsed;
  return attachWorkflowBase({
    id: raw.id,
    name: raw.name,
    status: raw.status,
    builtin: raw.builtin ?? (scope === "example"),
    description: raw.description ?? "",
    longDescription: raw.longDescription,
    defaultModel: raw.defaultModel ?? DEFAULT_MODEL,
    requiresSecrets: raw.requiresSecrets ?? [],
    triggerParams: raw.triggerParams ?? [],
    onFailureWorkflow: raw.onFailureWorkflow,
    group: raw.group,
    importedUntrusted: raw.importedUntrusted === true,
    copyHandoff: raw.copyHandoff as Workflow["copyHandoff"],
    nodes: raw.nodes ?? [],
    edges: raw.edges ?? [],
  });
}

function workflowPath(id: string): { file: string; builtin: boolean } {
  assertValidId(id);
  const userFile = path.join(/*turbopackIgnore: true*/ USER_DIR, `${id}.json`);
  if (fs.existsSync(/* turbopackIgnore: true */ userFile)) return { file: userFile, builtin: false };
  return { file: path.join(/*turbopackIgnore: true*/ EXAMPLES_DIR, `${id}.json`), builtin: true };
}

export function listWorkflows(): Workflow[] {
  const map = new Map<string, Workflow>();
  if (fs.existsSync(/* turbopackIgnore: true */ EXAMPLES_DIR)) {
    for (const f of fs.readdirSync(/* turbopackIgnore: true */ EXAMPLES_DIR)) {
      if (!f.endsWith(".json")) continue;
      const wf = readWorkflowFile("example", f);
      if (wf) map.set(wf.id, wf);
    }
  }
  if (fs.existsSync(/* turbopackIgnore: true */ USER_DIR)) {
    for (const f of fs.readdirSync(/* turbopackIgnore: true */ USER_DIR)) {
      if (!f.endsWith(".json")) continue;
      const wf = readWorkflowFile("user", f);
      if (wf) map.set(wf.id, wf);
    }
  }
  return Array.from(map.values());
}

/** 健康檢查用：壞檔不能只在 console 被跳過，否則使用者只會覺得某條流程憑空消失。 */
export function listWorkflowFileIssues(): { file: string }[] {
  const issues: { file: string }[] = [];
  for (const dir of [EXAMPLES_DIR, USER_DIR]) {
    if (!fs.existsSync(/* turbopackIgnore: true */ dir)) continue;
    for (const name of fs.readdirSync(/* turbopackIgnore: true */ dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(/*turbopackIgnore: true*/ dir, name);
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf-8"));
        if (!isWorkflowFileShape(parsed, path.basename(name, ".json"))) issues.push({ file: name });
      } catch {
        issues.push({ file: name });
      }
    }
  }
  return issues;
}

export function getWorkflow(id: string): Workflow | null {
  // URL 參數／外部觸發可能直接進來；查不到應該是正常的 null/404，不該因路徑字元讓整個 API 變 500。
  if (!isValidWorkflowId(id)) return null;
  const { builtin } = workflowPath(id);
  return readWorkflowFile(builtin ? "example" : "user", `${id}.json`);
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
export function deriveRequiresSecrets(wf: Workflow): Workflow["requiresSecrets"] {
  // `requiresSecrets` 曾經是只會累加的清單：流程從「自動輸入 Google 帳密」改為「手動登入一次」後，
  // 舊的 googleAccount/googlePassword 仍留在設定頁，使用者會誤以為必填、甚至把不該交給流程的
  // Google 密碼貼進去。保留仍被節點實際引用的既有欄位(例如 http-request 的 {{serviceToken}})，
  // 但淘汰已沒有任何節點使用的殘留欄位。
  const graphText = wf.nodes.map((node) => JSON.stringify(node.config ?? {})).join("\n");
  const isStillReferenced = (key: string) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:\\{\\{\\s*${escaped}(?:[.\\s}]|$)|ctx\\.secrets\\??\\.\\s*${escaped}\\b|ctx\\.secrets\\[\\s*["']${escaped}["']\\s*\\])`).test(graphText);
  };
  // sheetAppendUrl 已改成每個寫入節點自己的 scriptUrl；舊流程殘留的全域欄位要在任何一次
  // saveWorkflow 時清掉，否則設定頁仍會冒出一個不該存在、又很容易和 sheetUrl 填反的欄位。
  const byKey = new Map((wf.requiresSecrets ?? [])
    .filter((f) => f.key !== "sheetAppendUrl" && isStillReferenced(f.key))
    .map((f) => [f.key, f]));
  for (const node of wf.nodes) {
    const def = getNodeDef(node.type);
    for (const f of def?.secretFields?.(node.config ?? {}) ?? []) {
      if (!byKey.has(f.key)) byKey.set(f.key, f);
    }
  }
  return [...byKey.values()];
}

/**
 * 純函式：套用流程圖失敗要回滾時，判斷「這幾毫秒內有沒有人動過剛套用的內容」。
 * 只有 true(沒人動過)才可以安全地把 nodes/edges/triggerParams 蓋回套用前的快照——
 * 如果磁碟上最新版已經跟剛套用的不一樣了，代表這段極短視窗內有別的請求(拖位置/PATCH edits)
 * 真的改了東西，那才是使用者剛做的事，回滾不能悄悄蓋掉它(app/api/workflows/[id]/build/route.ts 用)。
 */
export function graphUntouchedSinceApply(
  latest: Pick<Workflow, "nodes" | "edges" | "triggerParams">,
  applied: Pick<Workflow, "nodes" | "edges" | "triggerParams">,
): boolean {
  return (
    JSON.stringify(latest.nodes) === JSON.stringify(applied.nodes) &&
    JSON.stringify(latest.edges) === JSON.stringify(applied.edges) &&
    JSON.stringify(latest.triggerParams ?? null) === JSON.stringify(applied.triggerParams ?? null)
  );
}

export function saveWorkflow(wf: Workflow): void {
  assertValidId(wf.id);
  ensureUserDir();
  const target = path.join(/*turbopackIgnore: true*/ USER_DIR, `${wf.id}.json`);
  withWorkflowFileLock(target, () => {
  let effective = wf;
  const base = (wf as VersionedWorkflow)[WORKFLOW_BASE];
  if (base?.id === wf.id && fs.existsSync(/* turbopackIgnore: true */ target)) {
    const latest = readWorkflowFile("user", `${wf.id}.json`);
    if (latest && !same(base, latest)) effective = mergeWorkflowWithLatest(base, wf, latest);
  }
  backupWorkflow(wf.id);
  // repeat-steps 的 steps 全系統的不變量是「JSON 字串」(lint/說明/截短/persistStepCode 都這樣讀)，
  // 但 AI 建圖常直接給真陣列——在唯一的存檔入口正規化成字串，下游全部不用各自防
  // (實測踩過：真陣列被 String() 成 "[object Object]"，節點直接炸，還得靠修復迴圈燒一輪 AI 救)。
  let nodes = effective.nodes.map((n) =>
    n.type === "repeat-steps" && Array.isArray(n.config?.steps)
      ? { ...n, config: { ...n.config, steps: JSON.stringify(n.config.steps) } }
      : n,
  );
  // 任何存檔來源（AI 套圖、匯入、插節點、版本還原）都必須遵守「畫布不重疊」。只在前端修不夠，
  // API／舊資料仍能繞過；放在唯一存檔入口才是全系統不變量。
  const separated = separateOverlappingNodes(nodes);
  if (separated.changed) nodes = nodes.map((node) => ({ ...node, position: separated.positions[node.id] }));
  const normalized: Workflow = { ...effective, nodes };
  const toSave: Workflow = { ...normalized, builtin: false, requiresSecrets: deriveRequiresSecrets(normalized) };
  // 原子寫入：先寫暫存檔再 rename(同一檔案系統內 rename 是原子的)。
  // 直接 writeFileSync 寫到一半程式崩潰/斷電，會留下半截 JSON，整個 workflow 檔就毀了。
  // 暫存檔名必須帶 pid+隨機值：同一顆資料目錄可能有兩個進程(daemon 常駐 + 使用者又開 dev)同時存
  // 同一個 workflow，固定檔名會讓兩邊寫進同一個 .tmp、交錯出半截 JSON 再 rename 上去(整檔損毀)。
  const tmp = `${target}.${process.pid}-${randomUUID().slice(0, 6)}.tmp`;
  fs.writeFileSync(/* turbopackIgnore: true */ tmp, JSON.stringify(toSave, null, 2));
  fs.renameSync(/* turbopackIgnore: true */ tmp, target);
  syncMeta(toSave);
  });
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

/**
 * 副本不該帶走完整聊天（含一次性檔案與已過期的嘗試），但「原本已講清楚什麼」不能消失。
 * 從已保存對話擷取使用者說過的目的與最近調整，做成小型交接；附件只留下名稱，明講要在副本重新附上。
 */
function copyHandoffDetails(src: Workflow): {
  summary: string;
  attachments: { assetId: string; name: string; kind: "file" | "image" }[];
  /** 對話超過 24 則使用者訊息、或附件超過 8 份時,交接摘要會截斷早期內容——這裡不能默默截斷卻不
   * 講,不然使用者以為 AI 完整承接了原流程的脈絡，實際上一段早期的重要例外規則可能已經消失。 */
  truncatedChat: boolean;
  truncatedAttachments: boolean;
} {
  const pieces: string[] = [];
  const overview = (src.longDescription || src.description || "").trim();
  if (overview) pieces.push(`流程目的：${overview.slice(0, 600)}`);

  const sourceNames = new Set<string>();
  const state = getWorkflowChatState(src.id);
  const allUserMessages = (state?.chat ?? [])
    .filter((message): message is { role?: unknown; parts?: unknown } => Boolean(message) && typeof message === "object")
    .filter((message) => message.role === "user");
  const userMessages = allUserMessages.slice(-24);
  const truncatedChat = allUserMessages.length > userMessages.length;
  const rules: string[] = [];
  const attachments: { assetId: string; name: string; kind: "file" | "image" }[] = [];
  for (const message of userMessages) {
    if (!Array.isArray(message.parts)) continue;
    const text = message.parts
      .filter((part): part is { kind?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
      .filter((part) => part.kind === "text" && typeof part.text === "string")
      .map((part) => String(part.text).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    if (text && !rules.includes(text)) rules.push(text.slice(0, 520));
    for (const part of message.parts) {
      const typed = part && typeof part === "object" ? part as { kind?: unknown; name?: unknown; assetId?: unknown } : null;
      const name = typed?.name;
      if (typed?.kind !== "text" && typeof name === "string" && name.trim()) sourceNames.add(name.trim().slice(0, 120));
      if ((typed?.kind === "file" || typed?.kind === "image") && typeof typed.assetId === "string" && typeof name === "string" && name.trim()) {
        attachments.push({ assetId: typed.assetId, name: name.trim().slice(0, 120), kind: typed.kind });
      }
    }
  }
  // 標籤刻意不寫「已確認的規則」——這些只是原流程(複製來源)聊天裡使用者說過的話，套用到
  // 副本的新用途上不一定還成立。真實踩過的事故：副本後來只要求「改成每月排程」，AI 卻連同
  // 這裡收錄的舊分頁名稱／輸出檔名規則一起套用，回報成「同步套用先前確認的設定」——但那份
  // 「先前確認」其實是來源流程的舊脈絡，不是這次對話裡使用者確認過的事。標籤與下面 builder.ts
  // 的注入處都要讓模型清楚知道：這是背景參考，這次對話明確講的才是優先權更高的規格。
  if (rules.length) pieces.push(`原流程(複製來源)的背景脈絡，僅供參考、不是這次對話裡確認過的事：${rules.map((rule) => `「${rule}」`).join("；")}`);
  if (sourceNames.size) pieces.push(`原流程曾參考的資料：${[...sourceNames].slice(0, 8).join("、")}。副本會帶著這些資料供 AI 延續理解。`);
  if (!pieces.length) pieces.push("這是從原流程複製的工作流程；請先確認資料來源、目標與寫入規則。");
  const truncatedAttachments = attachments.length > 8;
  return { summary: pieces.join("\n").slice(0, 7_000), attachments, truncatedChat, truncatedAttachments };
}

export function copyWorkflow(id: string): Workflow | null {
  const src = getWorkflow(id);
  if (!src) return null;
  const newId = `${id}-copy-${randomUUID().slice(0, 6)}`;
  const handoff = copyHandoffDetails(src);
  const copiedAttachments = copyChatAttachmentsForWorkflow(id, newId, handoff.attachments);
  const copy: Workflow = {
    ...src,
    id: newId,
    name: `${src.name}(複製)`,
    status: "draft",
    builtin: false,
    // 副本承接「已確認的目的／規則」和使用者提供來定義流程的原始資料；不帶冗長聊天、
    // 帳密或登入 cookie。這讓 AI 有足夠脈絡，但不把舊對話塞回新流程的畫面。
    copyHandoff: {
      sourceName: src.name,
      summary: handoff.summary,
      copiedAt: new Date().toISOString(),
      attachments: copiedAttachments.length ? copiedAttachments : undefined,
      truncatedChat: handoff.truncatedChat,
      truncatedAttachments: handoff.truncatedAttachments,
    },
  };
  try {
    saveWorkflow(copy);
    // 模型選擇存在 wf_model 表(不在 workflow JSON 裡)，複製時要一起帶過去，
    // 不然原本特意選了 minimax-m3/Claude Code 的流程，複製出來會悄悄退回預設模型
    setWorkflowModel(newId, getWorkflowModel(id, src.defaultModel));
    // 排程/Webhook/LINE 不在 workflow JSON 裡，以前按「複製」會無聲遺失這些細節。
    // 排程的啟用狀態也照原樣複製；新流程仍是草稿，scheduler 會硬性略過草稿，所以不會立刻重複執行，
    // 等使用者把副本設為正式後才依原本設定生效。這樣才是真正「所有細節完整複製」。
    // Webhook/LINE 若原本有啟用，產生「新」token：保留啟用狀態，但絕不共用原本的秘密網址。
    const db = getDb();
    const sourceMeta = db.prepare(`SELECT webhook_token, line_token FROM workflows_meta WHERE id = ?`).get(id) as
      | { webhook_token: string | null; line_token: string | null }
      | undefined;
    db.transaction(() => {
      const schedules = db.prepare(`SELECT enabled, cron, params_json FROM schedules WHERE workflow_id = ? ORDER BY created_at`).all(id) as
        { enabled: number; cron: string; params_json: string | null }[];
      const insert = db.prepare(
        `INSERT INTO schedules (id, workflow_id, enabled, cron, params_json, last_fired_minute, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, datetime('now'))`,
      );
      for (const schedule of schedules) insert.run(randomUUID(), newId, schedule.enabled ? 1 : 0, schedule.cron, schedule.params_json);
      db.prepare(`UPDATE workflows_meta SET webhook_token = ?, line_token = ? WHERE id = ?`).run(
        sourceMeta?.webhook_token ? randomBytes(24).toString("hex") : null,
        sourceMeta?.line_token ? randomBytes(24).toString("hex") : null,
        newId,
      );
    })();
    return copy;
  } catch (error) {
    // 複製是單一使用者動作：任何細節失敗都不能留下「看似成功但缺排程/模型」的半份副本。
    try { deleteWorkflow(newId); } catch { fs.rmSync(/* turbopackIgnore: true */ path.join(/*turbopackIgnore: true*/ USER_DIR, `${newId}.json`), { force: true }); }
    throw error;
  }
}

export function deleteWorkflow(id: string): void {
  assertValidId(id);
  const userFile = path.join(/*turbopackIgnore: true*/ USER_DIR, `${id}.json`);
  if (fs.existsSync(/* turbopackIgnore: true */ userFile)) fs.rmSync(/* turbopackIgnore: true */ userFile);
  fs.rmSync(/* turbopackIgnore: true */ historyDir(id), { recursive: true, force: true }); // 版本備份也一起清掉，不然刪了的 workflow 留著孤兒備份資料夾
  fs.rmSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ process.cwd(), "data", "browser-sessions", `${id}.json`), { force: true });
  deleteChatAttachmentsForWorkflow(id);
  deleteWorkflowChatState(id);
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
    fs.rmSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ process.cwd(), "data", "runs", runId), { recursive: true, force: true });
    fs.rmSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ process.cwd(), "data", "outputs", runId), { recursive: true, force: true });
  }
  db.prepare(`DELETE FROM runs WHERE workflow_id = ?`).run(id);
}

// 現在每一次 saveWorkflow() 都會呼叫這裡(不只是 AI 套用流程圖)，次數比以前多很多，
// 保留份數跟著拉高，不然頻繁的小改動(如拖節點位置)會把有意義的舊版本擠出 30 份的視窗。
const MAX_BACKUPS = 60;

function historyDir(id: string): string {
  return path.join(/*turbopackIgnore: true*/ USER_DIR, "history", id);
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
  fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
  const serialized = JSON.stringify(wf, null, 2);

  const existing = fs.existsSync(/* turbopackIgnore: true */ dir)
    ? fs.readdirSync(/* turbopackIgnore: true */ dir).filter((f) => f.endsWith(".json")).sort()
    : [];
  const latest = existing[existing.length - 1];
  if (latest) {
    const latestRaw = fs.readFileSync(/* turbopackIgnore: true */ path.join(/*turbopackIgnore: true*/ dir, latest), "utf-8");
    if (latestRaw === serialized) return;
    try {
      if (serializeWithoutPositions(JSON.parse(latestRaw) as Workflow) === serializeWithoutPositions(wf)) return;
    } catch {
      // 最新備份壞了就照常再存一份新的
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(/* turbopackIgnore: true */ path.join(/*turbopackIgnore: true*/ dir, `${ts}.json`), serialized);

  const files = fs.readdirSync(/* turbopackIgnore: true */ dir).filter((f) => f.endsWith(".json")).sort();
  const excess = files.length - MAX_BACKUPS;
  if (excess > 0) {
    for (const f of files.slice(0, excess)) fs.rmSync(/* turbopackIgnore: true */ path.join(/*turbopackIgnore: true*/ dir, f));
  }
}

export interface BackupInfo { filename: string; timestamp: string; name: string; nodeCount: number }

function hasExecutableCustomCode(code: unknown): code is string {
  const value = String(code ?? "").trim();
  return Boolean(value) && !/^return\s*\{\s*\.\.\.\s*ctx\.input\s*,?\s*\}\s*;?$/.test(value);
}

/**
 * 找回同一節點在本機版本歷史裡最近一份「真的可執行」的 custom-code。
 *
 * 這不是直接還原整張 workflow：AI 對話修改時可能只是不小心把 code 清空、但 intent 已更新。
 * 修復器應把這份已知可用的程式當底稿，再依目前 intent/真實檔案修到新需求，而不是憑空從零寫一遍。
 */
export function findLatestExecutableCustomCode(workflowId: string, nodeId: string): { code: string; intent: string; filename: string } | null {
  assertValidId(workflowId);
  const dir = historyDir(workflowId);
  if (!fs.existsSync(/* turbopackIgnore: true */ dir)) return null;
  const files = fs.readdirSync(/* turbopackIgnore: true */ dir).filter((file) => file.endsWith(".json")).sort().reverse();
  for (const filename of files) {
    try {
      const historical = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ dir, filename), "utf-8")) as Workflow;
      const node = historical.nodes?.find((candidate) => candidate.id === nodeId && candidate.type === "custom-code");
      const code = typeof node?.config?.code === "string" ? node.config.code : "";
      if (hasExecutableCustomCode(code)) {
        return { code, intent: typeof node?.config?.intent === "string" ? node.config.intent : "", filename };
      }
    } catch {
      // 單一舊備份損毀不該讓修復失去其他版本可用的底稿。
    }
  }
  return null;
}

/** 列出這個 workflow 所有版本備份(新到舊)，讓使用者看得到「AI 改了什麼、什麼時候改的」並可以還原 */
export function listBackups(id: string): BackupInfo[] {
  assertValidId(id);
  const dir = historyDir(id);
  if (!fs.existsSync(/* turbopackIgnore: true */ dir)) return [];
  return fs
    .readdirSync(/* turbopackIgnore: true */ dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .map((filename) => {
      try {
        const wf = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ path.join(/*turbopackIgnore: true*/ dir, filename), "utf-8")) as Workflow;
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

/**
 * 備份只存流程圖本身(節點/連線/參數/名稱)，排程、模型選擇、webhook/LINE token 這些「side-car」
 * 狀態都活在別的 DB 表、沒有版本化——還原不會、也沒辦法把它們還原成備份當下的樣子。真正的風險是
 * 使用者還原一張跟現在的排程/觸發設定用了不同觸發參數的舊圖，卻完全不知道自動觸發可能已經對不上
 * (真實顧慮：舊圖可能沒有現在排程在用的某個參數欄位)。這裡不做成靜默覆蓋(那本身也是一種意外的
 * 資料流失風險)，只在偵測到「有作用中的自動觸發、且觸發參數確實不一樣」時回一句警告，讓使用者
 * 自己決定要不要去排程/觸發設定頁確認。
 */
function activeTriggerMismatchWarning(id: string, restoredTriggerParams: Workflow["triggerParams"], currentTriggerParams: Workflow["triggerParams"]): string | undefined {
  const restoredKeys = JSON.stringify((restoredTriggerParams ?? []).map((p) => p.key).sort());
  const currentKeys = JSON.stringify((currentTriggerParams ?? []).map((p) => p.key).sort());
  if (restoredKeys === currentKeys) return undefined;
  const db = getDb();
  const hasSchedule = (db.prepare(`SELECT 1 FROM schedules WHERE workflow_id = ? AND enabled = 1 LIMIT 1`).get(id) as unknown) !== undefined;
  const meta = db.prepare(`SELECT webhook_token, line_token FROM workflows_meta WHERE id = ?`).get(id) as { webhook_token: string | null; line_token: string | null } | undefined;
  if (!hasSchedule && !meta?.webhook_token && !meta?.line_token) return undefined;
  return "還原的是流程圖本身，不含排程/Webhook/LINE 這類觸發設定——這次還原的版本用的執行參數跟現在不一樣，而這條流程目前有作用中的自動觸發，請到「排程」或流程頁確認觸發設定是否還跟這個版本相符。";
}

/** 還原到某個版本備份：先把「還原前的現況」也存一份備份(還原本身可逆)，再套用備份內容 */
export function restoreBackup(id: string, filename: string): { workflow: Workflow; warning?: string } | null {
  assertValidId(id);
  if (!/^[0-9T-]+Z\.json$/.test(filename)) throw new Error("不合法的備份檔名");
  const dir = historyDir(id);
  const backupPath = path.join(/*turbopackIgnore: true*/ dir, filename);
  if (!fs.existsSync(/* turbopackIgnore: true */ backupPath)) return null;
  const backup = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ backupPath, "utf-8")) as Workflow;
  const current = getWorkflow(id);
  const warning = activeTriggerMismatchWarning(id, backup.triggerParams, current?.triggerParams);
  backupWorkflow(id); // 現況也存一份，還原這個動作本身還能再復原
  // 只還原「內容」(節點/連線/參數/名稱)，不還原 status——不然還原一個當初是草稿時存的備份，
  // 會把現在已經是正式的流程偷偷變回草稿(連帶讓之後手動執行變成有頭瀏覽器)。status 維持現況。
  const restored: Workflow = { ...backup, id, builtin: false, status: current?.status ?? backup.status };
  saveWorkflow(restored);
  return { workflow: restored, warning };
}
