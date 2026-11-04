/**
 * 「我的步驟」——讓使用者把**自己調通的東西**變成可以重複套用的積木。
 *
 * 為什麼要有這個(使用者原話)：「我只是要多一個功能你就要跑那麼久，那使用者想在我的 agent-hub
 * 上客製化一個這種功能不就永遠做不出來？」他說得對。平台原本只有兩種狀態：
 *   ①用現成的步驟組流程 → 講一句話就有
 *   ②現成的沒有你要的 → 要改程式、要發版本，一般使用者永遠到不了
 * 中間缺的正是「我自己弄出來的東西，可以存起來、下次直接用」。
 *
 * **關鍵設計：這是「範本」，不是新的節點型別。**
 * 加進流程時它會展開成一個普通的自訂程式碼節點(程式碼已經填好、參數變成設定欄位)。
 * 這樣做的理由不是省事，是安全：新增節點型別會繞過一整排以型別為鍵的防線
 * (結構檢查、只讀契約、匯入時清空程式碼、副作用分類、安全排練略過…)，
 * 而展開成既有型別的話，那些防線**一條都不用改就自動適用**。
 * 使用者自己存的程式碼，跟 AI 產的程式碼受到完全相同的對待——這是刻意的。
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
// 欄位宣告住在沒有相依的葉模組：節點面板(瀏覽器端)也要用 parseUserFields，
// 從這裡 import 會把 better-sqlite3 拉進瀏覽器打包(踩過，整個 build 直接失敗)。
import { parseUserFields, USER_STEP_KEY_RE as KEY_RE, type UserStepParam } from "./userStepFields";

export { parseUserFields };
export type { UserStepParam };

export interface UserStep {
  id: string;
  name: string;
  description: string;
  /** 參數化之後的程式碼：原本寫死的值換成讀 ctx.config.<key> */
  code: string;
  /** 這個步驟在做什麼(給重新產碼與 AI 修復看的規格) */
  intent: string;
  params: UserStepParam[];
  createdAt: string;
  /** 從哪條流程的哪一步存下來的——出問題時找得回源頭 */
  sourceWorkflowId?: string;
  sourceNodeId?: string;
}

const MAX_STEPS = 200;

/** 建立/更新前的把關。壞資料存進去，之後每次展開都會壞，而且使用者看不出是哪裡的問題。 */
export function validateUserStep(input: Partial<UserStep>): string[] {
  const problems: string[] = [];
  const name = String(input.name ?? "").trim();
  if (!name) problems.push("步驟需要一個名稱（之後你會在「加步驟」裡看到它）");
  if (name.length > 60) problems.push("名稱最多 60 個字");
  if (!String(input.code ?? "").trim()) problems.push("沒有程式碼內容可以存");
  const params = input.params ?? [];
  if (params.length > 30) problems.push("設定欄位最多 30 個");
  const seen = new Set<string>();
  for (const param of params) {
    if (!KEY_RE.test(param.key ?? "")) { problems.push(`欄位代號「${param.key}」不合法（只能用英文、數字、底線，且開頭是英文）`); continue; }
    if (seen.has(param.key)) problems.push(`欄位代號「${param.key}」重複了`);
    seen.add(param.key);
    if (!String(param.label ?? "").trim()) problems.push(`欄位「${param.key}」少了看得懂的名稱`);
  }
  // 參數宣告了卻沒被程式碼用到 = 使用者填了也不會有任何效果，是最難查的那種「設定沒作用」。
  const code = String(input.code ?? "");
  for (const param of params) {
    if (KEY_RE.test(param.key ?? "") && !code.includes(`ctx.config.${param.key}`)) {
      problems.push(`欄位「${param.label || param.key}」在程式碼裡沒有被用到——填了不會有任何效果`);
    }
  }
  return problems;
}

export function listUserSteps(): UserStep[] {
  const rows = getDb().prepare(`SELECT data FROM user_steps ORDER BY created_at DESC`).all() as { data: string }[];
  return rows.flatMap((row) => {
    try { return [JSON.parse(row.data) as UserStep]; } catch { return []; }
  });
}

export function getUserStep(id: string): UserStep | null {
  const row = getDb().prepare(`SELECT data FROM user_steps WHERE id = ?`).get(id) as { data: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.data) as UserStep; } catch { return null; }
}

export function saveUserStep(input: Omit<UserStep, "id" | "createdAt"> & { id?: string }): UserStep {
  const problems = validateUserStep(input);
  if (problems.length > 0) throw new Error(problems.join("；"));
  const db = getDb();
  if (!input.id && (db.prepare(`SELECT COUNT(*) AS n FROM user_steps`).get() as { n: number }).n >= MAX_STEPS) {
    throw new Error(`「我的步驟」最多 ${MAX_STEPS} 個，請先刪掉用不到的`);
  }
  const step: UserStep = {
    ...input,
    id: input.id ?? randomUUID().slice(0, 8),
    name: input.name.trim().slice(0, 60),
    description: String(input.description ?? "").trim().slice(0, 500),
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO user_steps (id, name, data, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data`,
  ).run(step.id, step.name, JSON.stringify(step), step.createdAt);
  return step;
}

export function deleteUserStep(id: string): boolean {
  return getDb().prepare(`DELETE FROM user_steps WHERE id = ?`).run(id).changes > 0;
}

/**
 * 把「我的步驟」展開成一個真正的節點設定。
 *
 * 展開後就是一個**普通的自訂程式碼節點**——刻意如此。使用者存的程式碼不會因為「是他自己存的」
 * 就得到任何特權：安全排練照樣依內容判斷要不要略過、匯入時照樣清空、只讀契約照樣擋。
 */
export function expandUserStep(step: UserStep): { type: string; label: string; config: Record<string, unknown> } {
  const config: Record<string, unknown> = {
    intent: step.intent || step.description || step.name,
    code: step.code,
    // 使用者自訂的設定欄位。節點面板會把它們當一般欄位渲染(見 NodePanel 的 userFields)，
    // 程式碼則用 ctx.config.<key> 讀到值。
    userFields: JSON.stringify(step.params),
    userStepId: step.id,
  };
  for (const param of step.params) config[param.key] = param.default ?? "";
  return { type: "custom-code", label: step.name, config };
}
