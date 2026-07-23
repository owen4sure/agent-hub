import { getDb, DEFAULT_BASE_URL, DEFAULT_API_KEY, DEFAULT_MODEL } from "./db";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secretVault";

export function getGlobalSettings(): { baseUrl: string; apiKey: string } {
  const db = getDb();
  const rows = db
    .prepare(`SELECT key, value FROM settings WHERE key IN ('baseUrl','apiKey')`)
    .all() as { key: string; value: string }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const storedApiKey = map.apiKey;
  const apiKey = storedApiKey ? decryptSecret(storedApiKey) : DEFAULT_API_KEY;
  // 舊版把模型 API Key 放在 settings 明碼欄位。第一次讀到時立即升級，使用者不用重新貼一次。
  if (storedApiKey && !isEncryptedSecret(storedApiKey) && apiKey) {
    db.prepare(`UPDATE settings SET value = ? WHERE key = 'apiKey' AND value = ?`).run(encryptSecret(apiKey), storedApiKey);
  }
  return {
    baseUrl: map.baseUrl ?? DEFAULT_BASE_URL,
    apiKey,
  };
}

export function setGlobalSettings(input: { baseUrl?: string; apiKey?: string }) {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  if (input.baseUrl !== undefined) stmt.run("baseUrl", input.baseUrl);
  if (input.apiKey !== undefined) stmt.run("apiKey", encryptSecret(input.apiKey));
}

/**
 * 同時可執行幾個 workflow：1 = 一次跑一個(依序排隊)，>1 = 併行。
 * 沒設定過就用 CPU 推算的預設(由呼叫端傳入)。控制排程同時觸發、以及「全部執行」的行為。
 */
export function getMaxConcurrent(fallback: number): number {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'maxConcurrent'`).get() as { value: string } | undefined;
  const n = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : fallback;
}

export function setMaxConcurrent(n: number) {
  const db = getDb();
  const v = String(Math.max(1, Math.min(8, Math.floor(n))));
  db.prepare(`INSERT INTO settings (key, value) VALUES ('maxConcurrent', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(v);
}

/**
 * 「AI 建流程偏好」：使用者用白話寫的固定習慣(檔名格式/報表慣例/慣用通知管道…)，
 * builder 每次建圖注入 system prompt 當高優先指示——同一句話不用每條流程重講一次。
 */
export function getBuilderPrefs(): string {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = 'builderPrefs'`).get() as { value: string } | undefined;
  return row?.value ?? "";
}

export function setBuilderPrefs(text: string) {
  // 上限防止整篇文章塞進來吃光 prompt 預算(2000 字的偏好已經非常多)
  const v = text.slice(0, 2000);
  getDb().prepare(`INSERT INTO settings (key, value) VALUES ('builderPrefs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(v);
}

/** 首頁「我的流程」的手動排序：使用者拖曳決定的 workflow id 順序(存整份有序 id 清單)。
 * 不在清單裡的 id(之後新建的流程)排在已排序者後面、維持原本相對順序——新流程不會插隊也不會消失。 */
export function getWorkflowSortOrder(): string[] {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = 'workflowSortOrder'`).get() as { value: string } | undefined;
  try {
    const parsed: unknown = JSON.parse(row?.value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setWorkflowSortOrder(ids: string[]) {
  // 上限防呆：這只是首頁排序偏好，正常量級是幾十條；就算被塞爆也不能吃掉整個 settings 表
  const v = JSON.stringify(ids.slice(0, 500));
  getDb().prepare(`INSERT INTO settings (key, value) VALUES ('workflowSortOrder', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(v);
}

export type BuilderEffort = "low" | "medium" | "high";
const BUILDER_EFFORT_VALUES: readonly BuilderEffort[] = ["low", "medium", "high"];

/**
 * 建圖/修圖/產程式碼呼叫本機 Claude Code 時用的推理力度。以前寫死 "low"（建圖）或依情境猜
 * "low"/"medium"（產程式碼），理由是「反正有確定性檢查攔著，犧牲一點推理力度換速度不會出事」——
 * 但確定性檢查只攔得住寫進規則裡的情況，攔不住的還是要靠模型自己想清楚，寫死低推理力度等於
 * 從一開始就限制了它能想多深。使用者明確要求「不能為了速度讓 AI 建不了工作流」，且今天實測
 * 全程本來就被免費 gateway 的不穩定拖慢，多花的推理時間相對於此可忽略——預設值改成 "high"，
 * 並開放使用者自己在設定頁調整(仍保留 low/medium 給真的在意單輪回應速度的人)。
 */
export function getBuilderEffort(): BuilderEffort {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = 'builderEffort'`).get() as { value: string } | undefined;
  return (BUILDER_EFFORT_VALUES as readonly string[]).includes(row?.value ?? "") ? (row!.value as BuilderEffort) : "high";
}

export function setBuilderEffort(effort: BuilderEffort) {
  if (!BUILDER_EFFORT_VALUES.includes(effort)) return;
  getDb().prepare(`INSERT INTO settings (key, value) VALUES ('builderEffort', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(effort);
}

/** 取 workflow 選用的模型；沒設定過就用 workflow 自己的 defaultModel(由呼叫端傳入) */
export function getWorkflowModel(workflowId: string, fallback = DEFAULT_MODEL): string {
  const db = getDb();
  const row = db
    .prepare(`SELECT model FROM wf_model WHERE workflow_id = ?`)
    .get(workflowId) as { model: string } | undefined;
  return row?.model ?? fallback;
}

export function setWorkflowModel(workflowId: string, model: string) {
  const db = getDb();
  db.prepare(
    `INSERT INTO wf_model (workflow_id, model, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(workflow_id) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at`,
  ).run(workflowId, model);
}

// 帳密改成「依欄位名稱全域共用」：同一個 key(如 webmailAccount)只存一份，
// 所有需要這個 key 的 workflow 都共用，設一次到處通。要用不同帳密的 workflow
// 就在 requiresSecrets 宣告不同的 key 名稱(自然分開，不會互相蓋)。
const SHARED = "__shared__";

/** 讀某個 workflow 需要的帳密：實際上是讀全域共用值(依 key)。 */
export function getWorkflowSecrets(_workflowId: string): Record<string, string> {
  void _workflowId;
  return getSharedSecrets();
}

/**
 * A workflow only receives the credentials its current graph explicitly asks
 * for.  Shared storage is a convenience for the person using the app, not a
 * capability grant to every custom-code node in every workflow.
 */
export function getWorkflowSecretsForKeys(workflowId: string, keys: Iterable<string>): Record<string, string> {
  const all = getWorkflowSecrets(workflowId);
  const selected: Record<string, string> = {};
  for (const key of keys) {
    if (typeof all[key] === "string") selected[key] = all[key];
  }
  return selected;
}

/** 存帳密：寫進全域共用(依 key)，任何 workflow 存的都彼此看得到。 */
export function setWorkflowSecrets(_workflowId: string, secrets: Record<string, string>) {
  void _workflowId;
  setSharedSecrets(secrets);
}

export function getSharedSecrets(): Record<string, string> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT key, value FROM secrets WHERE workflow_id = ?`)
    .all(SHARED) as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, decryptSecret(r.value)]));
}

export function setSharedSecrets(secrets: Record<string, string>) {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO secrets (workflow_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(workflow_id, key) DO UPDATE SET value = excluded.value`,
  );
  const tx = db.transaction((entries: [string, string][]) => {
    for (const [key, value] of entries) stmt.run(SHARED, key, value);
  });
  tx(Object.entries(secrets).map(([key, value]) => [key, encryptSecret(value)]));
}

/** 明確撤銷已保存的帳密。空字串仍代表「不修改」，刪除必須走獨立操作，避免誤清。 */
export function deleteSharedSecrets(keys: string[]) {
  const clean = [...new Set(keys.filter((k) => /^[A-Za-z0-9_.-]{1,100}$/.test(k)))];
  if (clean.length === 0) return;
  const stmt = getDb().prepare(`DELETE FROM secrets WHERE workflow_id = ? AND key = ?`);
  getDb().transaction((items: string[]) => {
    for (const key of items) stmt.run(SHARED, key);
  })(clean);
}
