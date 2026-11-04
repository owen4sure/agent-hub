import { getDb } from "../db";
import { contractEffectsFor } from "./dataChangePolicy";
import { scanDirectDataChanges } from "./dataChangeScan";
import { scanDelegatedWrites, type DelegatedFinding } from "./subflowEffects";
import { storeSubflowResolver } from "./subflowResolver";
import { approvedReadOnlyNodeIds } from "./httpReadOnlyApproval";
import type { SideEffectTag } from "./sideEffects";
import type { Workflow } from "./types";

/**
 * workflow 層級的「不准變更資料」安全契約 + 執行前的跨流程重驗。
 *
 * 為什麼需要：`checkRequirements` 只在**建圖當下**成立。母流程通過「只讀／不要修改」驗收之後，
 * 被它呼叫的子流程或失敗備援流程可以在任何時候被改成 `google-sheet-append`／`send-email`／
 * 未確認的 POST——母流程自己一個字都沒動，`startWorkflowRun()` 也不會重掃委派鏈，正式執行照樣寫出去。
 * 建圖當下的驗收是「這張圖現在看起來安全」，不是「這條流程永遠不會變更資料」；後者必須是一份
 * 持久化的契約 + 每次執行前重驗。
 *
 * 契約存在 DB 而不是 workflow JSON：JSON 是 AI 建圖／修復／匯入都能改寫的地方，把安全契約放在那裡
 * 等於讓 AI 自己解除自己的限制(跟 http-request 的 readOnly 是同一個踩過的坑)。
 */

export interface SafetyContract {
  workflowId: string;
  /** 禁止的副作用分類。空陣列 = 使用者已明確解除(這一列仍保留當稽核軌跡)。 */
  bannedEffects: SideEffectTag[];
  /** 建立這份契約時使用者說的原話——稽核用，不存模型的摘要或推論。 */
  sourceText: string;
  createdAt: string;
  updatedAt?: string;
  updatedNote?: string;
}

const KNOWN_TAGS: SideEffectTag[] = ["email", "notify", "file-write", "file-modify", "remote-write", "workspace-file", "approval-request", "delegated"];

function parseTags(json: string): SideEffectTag[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is SideEffectTag => typeof t === "string" && (KNOWN_TAGS as string[]).includes(t));
  } catch { return []; }
}

export function getSafetyContract(workflowId: string): SafetyContract | null {
  let row: { banned_effects: string; source_text: string; created_at: string; updated_at: string | null; updated_note: string | null } | undefined;
  try {
    row = getDb()
      .prepare(`SELECT banned_effects, source_text, created_at, updated_at, updated_note FROM workflow_safety_contracts WHERE workflow_id = ?`)
      .get(workflowId) as typeof row;
  } catch { return null; /* 沒有 DB(測試環境)一律當作沒有契約——既有流程不能被回溯誤鎖 */ }
  if (!row) return null;
  return {
    workflowId,
    bannedEffects: parseTags(row.banned_effects),
    sourceText: row.source_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
    updatedNote: row.updated_note ?? undefined,
  };
}

/**
 * 依**使用者自己說的話**建立/擴充只讀契約。只有 `statesReadOnlyIntent` 成立(只讀／只分析／只計算／
 * 不要修改／不要寫入這類最明確的語句)才會建立——不准由模型的摘要、假設或「圖上看起來沒有寫入」推導。
 *
 * 已經有契約時只會**取聯集**(使用者又講了一次更嚴格的限制就更嚴)，永遠不會在這裡放寬：
 * 放寬只能走 relaxSafetyContract，也就是使用者本人的明確動作。回傳是否真的寫入了新的契約。
 */
export function recordReadOnlyContractFromUserText(workflowId: string, userText: string): boolean {
  const text = userText.trim();
  if (!text) return false;
  const stated = contractEffectsFor(text);
  if (stated.size === 0) return false;
  const existing = getSafetyContract(workflowId);
  const merged = new Set<SideEffectTag>([...(existing?.bannedEffects ?? []), ...stated]);
  const db = getDb();
  db.prepare(
    `INSERT INTO workflow_safety_contracts (workflow_id, banned_effects, source_text, created_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(workflow_id) DO UPDATE SET banned_effects=excluded.banned_effects, source_text=excluded.source_text, updated_at=datetime('now'), updated_note='使用者再次表達了只讀需求'`,
  ).run(workflowId, JSON.stringify([...merged]), text.slice(0, 2_000));
  return true;
}

/**
 * 使用者明確授權寫入時的對稱動作：解除整份契約(allowEffects 省略)或只放寬其中幾項(縮小契約)。
 * 一律留下 updated_at / updated_note 當稽核軌跡，不刪除這一列。
 * **只能由使用者操作的 API 呼叫**——不得因為 AI 產出的圖含寫入節點就自動走這裡。
 */
export function relaxSafetyContract(workflowId: string, note: string, allowEffects?: SideEffectTag[]): SafetyContract | null {
  const existing = getSafetyContract(workflowId);
  if (!existing) return null;
  const remaining = allowEffects?.length
    ? existing.bannedEffects.filter((tag) => !allowEffects.includes(tag))
    : [];
  getDb()
    .prepare(`UPDATE workflow_safety_contracts SET banned_effects = ?, updated_at = datetime('now'), updated_note = ? WHERE workflow_id = ?`)
    .run(JSON.stringify(remaining), note.slice(0, 500), workflowId);
  return getSafetyContract(workflowId);
}

/** 匯入／複製產生的新流程不得沿用別人的契約紀錄(新 id 本來就查不到，這裡是 id 重用的保險)。 */
export function clearSafetyContract(workflowId: string): void {
  try { getDb().prepare(`DELETE FROM workflow_safety_contracts WHERE workflow_id = ?`).run(workflowId); } catch { /* 沒 DB 就沒東西要清 */ }
}

export interface SafetyViolation {
  /** 完整路徑：本流程節點 id、迴圈內 `n[步驟0]`、或委派鏈 `onFailureWorkflow → fallback.writeSheet` */
  path: string;
  detail: string;
}

/**
 * 依契約重新掃這條流程「現在」會不會變更資料——本圖(含 repeat-steps)+ 委派鏈(run-workflow、
 * onFailureWorkflow、子流程自己的 onFailureWorkflow)。全部走既有的 scanDirectDataChanges /
 * scanDelegatedWrites / storeSubflowResolver / 指紋確認，不另外造一份副作用判定。
 */
export function findSafetyContractViolations(wf: Workflow, contract: SafetyContract): SafetyViolation[] {
  const banned = new Set<SideEffectTag>(contract.bannedEffects);
  if (banned.size === 0) return [];
  const out: SafetyViolation[] = [];
  const approved = (() => {
    try { return approvedReadOnlyNodeIds(wf.id, wf.nodes); } catch { return new Set<string>(); }
  })();
  // 「判斷不出來的 custom-code 也要 fail closed」只在全面只讀契約下才需要——單項契約(例如只說
  // 「不要寄信」)沒有理由把每個還沒產碼的計算步驟都擋掉。
  const forbidsAllChanges = banned.has("file-write") && banned.has("file-modify") && banned.has("remote-write");
  const direct = scanDirectDataChanges(wf.nodes, {
    bannedEffects: banned,
    readOnlyApprovedNodeIds: approved,
    includeUndetermined: forbidsAllChanges,
  });
  for (const node of direct.writes) out.push({ path: node.path, detail: node.type });
  // 「AI 說是查詢但沒人確認過」在執行期一樣不能放行——建圖時它是「等使用者確認」，
  // 但真的要按下執行時，沒確認就是沒授權。
  for (const node of direct.awaitingConfirmation) {
    out.push({ path: node.path, detail: `${node.type}（AI 說這是查詢，但還沒有人確認過這個端點）` });
  }
  for (const node of direct.undetermined) out.push({ path: node.path, detail: `${node.type}（還看不出來會不會寫入）` });
  for (const path of direct.overLimitPaths) out.push({ path, detail: "迴圈巢狀超過上限，裡面有系統看不到的區域" });
  for (const path of direct.unreadablePaths) out.push({ path, detail: "迴圈的 steps 讀不出來，裡面有系統看不到的區域" });

  // ⚠️ 委派鏈用的是**跟上面 direct 完全同一份 banned**。真實踩過的不一致：這裡曾經自己額外加上
  // email/notify，而契約只存了三個資料變更分類——同一句「只讀取資料，不要修改」，寄信藏在子流程
  // 會被擋、直接畫在本圖反而放行。同一份使用者承諾不能因為動作在本圖還是子流程就有不同結果；
  // 承諾的範圍寫在契約本身(見 dataChangePolicy 的 contractEffects)，掃描端一律照它執行、不得加碼。
  const delegated: DelegatedFinding[] = scanDelegatedWrites(
    { nodes: wf.nodes, onFailureWorkflow: wf.onFailureWorkflow },
    { resolveSubflow: storeSubflowResolver, bannedEffects: banned },
  );
  for (const finding of delegated) out.push({ path: finding.path, detail: finding.detail });
  return out;
}

/** 執行前閘門擋下這次執行時丟的錯。獨立型別讓呼叫端(UI/排程/通知)可以分辨這不是一般執行失敗。 */
export class SafetyContractViolationError extends Error {
  constructor(public readonly violations: SafetyViolation[], message: string) {
    super(message);
    this.name = "SafetyContractViolationError";
  }
}

/**
 * 執行前閘門。**必須在建立 run、執行任何節點之前呼叫**——這是「子流程在母流程通過驗收之後被改壞」
 * 唯一擋得住的地方(反向索引警示會漏掃，多進程競態也擋不住，所以警示只能是加分，不能是防線)。
 */
export function assertSafetyContract(wf: Workflow): void {
  const contract = getSafetyContract(wf.id);
  if (!contract || contract.bannedEffects.length === 0) return; // 沒有契約的既有流程維持原行為
  const violations = findSafetyContractViolations(wf, contract);
  if (violations.length === 0) return;
  const list = violations.slice(0, 8).map((v) => `- ${v.path}：${v.detail}`).join("\n");
  throw new SafetyContractViolationError(
    violations,
    `已阻止這次執行：這條流程曾經由你明確要求「不變更任何資料」，但現在的內容(或它呼叫的子流程／失敗備援流程，可能在你確認之後才被改動)會寫出資料或對外發送。\n` +
      `${list}${violations.length > 8 ? `\n…等共 ${violations.length} 項` : ""}\n` +
      `路徑讀法：「呼叫端 → 被呼叫流程id.那條流程裡的節點」；開頭是 onFailureWorkflow 代表問題出在失敗備援設定。\n` +
      `原始要求：「${contract.sourceText.slice(0, 80)}」(${contract.createdAt})。\n` +
      `若這些寫入現在是你要的，請到流程頁的「只讀保護」把它解除或縮小範圍，再重新執行。`,
  );
}

/**
 * 反向索引：找出「有只讀契約、而且會因為這條流程被改動而在下次執行被擋下」的母流程。
 *
 * ⚠️ 這只是**加分的提早警示**，不是防線。它會漏(例如 target 寫成執行期模板時根本查不出誰引用誰)，
 * 也擋不住多進程競態(另一個進程正好在掃描空窗期改了子流程)。真正不可省略的是
 * `assertSafetyContract` 那道執行前閘門——警示可以沒有，閘門不能沒有。
 */
export function readOnlyParentsBlockedBy(
  changedWorkflowId: string,
  listAllWorkflows: () => Workflow[],
): { workflowId: string; workflowName: string; violations: SafetyViolation[] }[] {
  const out: { workflowId: string; workflowName: string; violations: SafetyViolation[] }[] = [];
  let all: Workflow[];
  try { all = listAllWorkflows(); } catch { return out; }
  for (const wf of all) {
    if (wf.id === changedWorkflowId) continue;
    const contract = getSafetyContract(wf.id);
    if (!contract || contract.bannedEffects.length === 0) continue;
    const violations = findSafetyContractViolations(wf, contract);
    // 只回報「跟這條被改動的流程有關」的違規，避免把母流程本來就有的其他問題混進來
    const related = violations.filter((v) => v.path.includes(changedWorkflowId));
    if (related.length > 0) out.push({ workflowId: wf.id, workflowName: wf.name, violations: related });
  }
  return out;
}
