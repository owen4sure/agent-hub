import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startWorkflowRun } from "./engine";
import {
  assertSafetyContract,
  clearSafetyContract,
  getSafetyContract,
  readOnlyParentsBlockedBy,
  recordReadOnlyContractFromUserText,
  relaxSafetyContract,
  SafetyContractViolationError,
} from "./safetyContract";
import { approveHttpReadOnly, clearHttpReadOnlyApprovals } from "./httpReadOnlyApproval";
import { getDb } from "../db";
import { deleteWorkflow, getWorkflow, listWorkflows, saveWorkflow } from "./store";
import type { Workflow, WorkflowNode } from "./types";

/**
 * 執行前的跨流程重驗閘門。
 *
 * 為什麼非有不可：`checkRequirements` 只在**建圖當下**成立。母流程通過「只讀／不要修改」驗收之後，
 * 被它呼叫的子流程或失敗備援流程可以在任何時候被改成會寫入——母流程一個字都沒動，正式執行照樣寫出去。
 *
 * 這支測試直接呼叫真正的 `startWorkflowRun()`(不是重新描述邏輯)，並用「runs 資料表有沒有多一列」
 * 這個外部可觀察的事實驗證「擋在建立 run 之前」。全程只驗閘門：被擋下的流程根本不會執行，
 * 所以不會真的寄信／寫檔／碰 Google；放行的案例一律用 `dryRun` 或不含任何外部節點的圖。
 */

const PREFIX = "test-safety-contract";
const created: string[] = [];

function makeWorkflow(suffix: string, nodes: WorkflowNode[], extra: Partial<Workflow> = {}): Workflow {
  const id = `${PREFIX}-${suffix}`;
  const wf: Workflow = {
    id,
    name: `安全契約測試-${suffix}`,
    status: "draft",
    builtin: false,
    description: "",
    defaultModel: "test-model",
    requiresSecrets: [],
    nodes,
    edges: nodes.length > 1 ? [{ from: nodes[0].id, to: nodes[1].id }] : [],
    ...extra,
  };
  saveWorkflow(wf);
  if (!created.includes(id)) created.push(id);
  return getWorkflow(id)!;
}
const N = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type, label: id, config, position: { x: 0, y: 0 } });
const CALC = N("calc", "custom-code", { intent: "計算加總", code: "return { total: 1 };" });

/** 換掉圖上的步驟時要一併重接線，不然 lintGraph 會先報「孤兒節點」，測不到安全閘門那一層。 */
function replaceNodes(workflowId: string, nodes: WorkflowNode[]): void {
  const wf = getWorkflow(workflowId)!;
  saveWorkflow({ ...wf, nodes, edges: nodes.length > 1 ? [{ from: nodes[0].id, to: nodes[1].id }] : [] });
}

function runCount(workflowId: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM runs WHERE workflow_id = ?`).get(workflowId) as { n: number }).n;
}

/** 每個案例自己收乾淨：測試流程、契約、唯讀確認、runs 一併清掉，不留東西給使用者看到。 */
function cleanupAll() {
  for (const id of [...created]) {
    clearSafetyContract(id);
    clearHttpReadOnlyApprovals(id);
    try { getDb().prepare(`DELETE FROM runs WHERE workflow_id = ?`).run(id); } catch { /* 沒 runs 就算了 */ }
    try { deleteWorkflow(id); } catch { /* 已經不在就算了 */ }
  }
  created.length = 0;
  // saveWorkflow 會留下版本備份目錄，一併清掉
  const backupDir = path.join(process.cwd(), "data", "workflows", "history");
  if (fs.existsSync(backupDir)) {
    for (const name of fs.readdirSync(backupDir)) {
      if (name.startsWith(PREFIX)) fs.rmSync(path.join(backupDir, name), { recursive: true, force: true });
    }
  }
}

/** 閘門放行的檢查刻意**不呼叫 startWorkflowRun**：那會真的把 run 排進佇列去執行(即使 dryRun，
 * google-sheet-read 這類讀取節點仍會真的連外)。被擋下的案例本來就不會執行任何東西，用它證明閘門
 * 確實接在 startWorkflowRun 上；放行的案例只驗閘門本身不誤擋。 */
function expectAllowed(workflowId: string, why: string): void {
  assert.doesNotThrow(() => assertSafetyContract(getWorkflow(workflowId)!), why);
}

function expectBlocked(workflowId: string, expectPath: RegExp, trigger: "manual" | "schedule" = "manual"): SafetyContractViolationError {
  const before = runCount(workflowId);
  let caught: unknown;
  try { startWorkflowRun(workflowId, {}, { trigger }); } catch (err) { caught = err; }
  assert.ok(caught instanceof SafetyContractViolationError, `應該被安全契約擋下，實際：${caught}`);
  assert.equal(runCount(workflowId), before, "必須擋在建立 run 之前——runs 資料表不該多一列");
  assert.match((caught as Error).message, expectPath);
  return caught as SafetyContractViolationError;
}

test("只讀契約：只從使用者原話建立，模型的摘要或一般敘述不會建立契約", () => {
  cleanupAll();
  const wf = makeWorkflow("record", [N("t", "trigger"), CALC]);
  assert.equal(recordReadOnlyContractFromUserText(wf.id, "幫我讀這份表，整理成報告寄給我"), false, "沒有只讀語句就不建立");
  assert.equal(getSafetyContract(wf.id), null);
  assert.equal(recordReadOnlyContractFromUserText(wf.id, "只讀取資料，不要修改"), true);
  const contract = getSafetyContract(wf.id)!;
  assert.deepEqual([...contract.bannedEffects].sort(), ["email", "file-modify", "file-write", "notify", "remote-write"],
    "「只讀」對使用者的意思本來就包含不會擅自寄信/通知——契約範圍必須寫在契約裡，不能由各掃描端各加各的");
  assert.equal(contract.sourceText, "只讀取資料，不要修改", "要存使用者原話當稽核依據，不是模型的摘要");
  assert.ok(contract.createdAt);
  cleanupAll();
});

test("執行前閘門：建圖時安全，子流程之後被改成寫 Google 試算表 → 在任何節點執行前拒絕整次 run", () => {
  cleanupAll();
  const child = makeWorkflow("child-safe", [N("t", "trigger"), N("read", "google-sheet-read", { sheetUrl: "https://docs.google.com/spreadsheets/d/x/edit" })]);
  const parent = makeWorkflow("parent", [N("t", "trigger"), N("runChild", "run-workflow", { target: child.id })]);
  recordReadOnlyContractFromUserText(parent.id, "只讀取資料，不要修改");

  // 建圖當下：子流程純讀 → 閘門放行(用 dryRun 確認閘門本身不會誤擋；不會有任何外部操作)
  expectAllowed(parent.id, "子流程還是純讀時不該被擋");

  // 使用者確認之後，別人把子流程改成會寫進 Google 試算表
  replaceNodes(child.id, [N("t", "trigger"), N("writeSheet", "google-sheet-append", { scriptUrl: "https://script.google.com/macros/x/exec", cells: "1" })]);

  const err = expectBlocked(parent.id, new RegExp(`runChild → ${child.id}\\.writeSheet`));
  assert.match(err.message, /已阻止這次執行/);
  assert.match(err.message, /只讀取資料，不要修改/, "錯誤要帶得出當初的原始要求，使用者才知道這個限制哪來的");
  cleanupAll();
});

test("執行前閘門：子流程改成未確認 POST、失敗備援改成寄信、交錯委派鏈改壞，逐一拒絕", () => {
  cleanupAll();
  // ① 子流程改成未確認的 POST
  const child = makeWorkflow("child-post", [N("t", "trigger"), CALC]);
  const p1 = makeWorkflow("p-post", [N("t", "trigger"), N("runChild", "run-workflow", { target: child.id })]);
  recordReadOnlyContractFromUserText(p1.id, "只讀取資料，不要修改");
  replaceNodes(child.id, [N("t", "trigger"), N("api", "http-request", { method: "POST", url: "https://api.example.com/x", readOnly: true })]);
  expectBlocked(p1.id, new RegExp(`runChild → ${child.id}\\.api`));

  // ② 失敗備援流程改成寄信
  const fb = makeWorkflow("fb", [N("t", "trigger"), CALC]);
  const p2 = makeWorkflow("p-fb", [N("t", "trigger"), CALC], { onFailureWorkflow: `${PREFIX}-fb` });
  recordReadOnlyContractFromUserText(p2.id, "只讀取資料，不要修改");
  expectAllowed(p2.id, "備援還乾淨時不該被擋");
  replaceNodes(fb.id, [N("t", "trigger"), N("mail", "send-email", { to: "x@example.com", subject: "s", body: "b" })]);
  expectBlocked(p2.id, new RegExp(`onFailureWorkflow → ${fb.id}\\.mail`));

  // ③ 交錯委派鏈：run-workflow 呼叫的子流程，它自己的失敗備援被改壞
  const deepFb = makeWorkflow("deep-fb", [N("t", "trigger"), CALC]);
  const mid = makeWorkflow("mid", [N("t", "trigger"), CALC], { onFailureWorkflow: `${PREFIX}-deep-fb` });
  const p3 = makeWorkflow("p-chain", [N("t", "trigger"), N("runChild", "run-workflow", { target: mid.id })]);
  recordReadOnlyContractFromUserText(p3.id, "只讀取資料，不要修改");
  expectAllowed(p3.id, "整條委派鏈都乾淨時不該被擋");
  replaceNodes(deepFb.id, [N("t", "trigger"), N("save", "write-file", { fileName: "x.txt", content: "x" })]);
  expectBlocked(p3.id, new RegExp(`runChild → ${mid.id}\\.onFailureWorkflow → ${deepFb.id}\\.save`));
  cleanupAll();
});

test("執行前閘門：子流程本人已確認且指紋相符的查詢可以跑；請求內容一變就再次拒絕", () => {
  cleanupAll();
  const query = { method: "POST", url: "https://api.example.com/v1/query", headers: "{}", body: '{"q":1}', readOnly: true };
  const child = makeWorkflow("child-approved", [N("t", "trigger"), N("api", "http-request", query)]);
  const parent = makeWorkflow("p-approved", [N("t", "trigger"), N("runChild", "run-workflow", { target: child.id })]);
  recordReadOnlyContractFromUserText(parent.id, "只讀取資料，不要修改");

  // 還沒確認 → 擋
  expectBlocked(parent.id, new RegExp(`runChild → ${child.id}\\.api`));

  // 子流程擁有者確認過這一份精確請求 → 放行(重用共用的純讀子流程不該被逼著拆掉)
  approveHttpReadOnly(child.id, "api", query);
  expectAllowed(parent.id, "子流程本人確認過就不該再被擋");

  // 子流程的請求內容被改動(等同 AI 改寫/匯入/修復) → 指紋不符，重新 fail closed
  replaceNodes(child.id, [N("t", "trigger"), N("api", "http-request", { ...query, url: "https://api.example.com/v1/create" })]);
  expectBlocked(parent.id, new RegExp(`runChild → ${child.id}\\.api`));
  cleanupAll();
});

test("執行前閘門：使用者明確解除或縮小契約後，預期的寫入流程可以正常執行", () => {
  cleanupAll();
  const wf = makeWorkflow("relax", [N("t", "trigger"), N("save", "write-file", { fileName: "x.txt", content: "x" })]);
  recordReadOnlyContractFromUserText(wf.id, "只讀取資料，不要修改");
  expectBlocked(wf.id, /save/);

  // 縮小：只放寬「產生本機檔」，遠端寫入仍然禁止
  relaxSafetyContract(wf.id, "使用者說要存一份報告檔", ["file-write"]);
  expectAllowed(wf.id, "放寬後預期的寫檔流程要能跑");
  const narrowed = getSafetyContract(wf.id)!;
  assert.equal(narrowed.bannedEffects.includes("file-write"), false);
  assert.equal(narrowed.bannedEffects.includes("remote-write"), true, "沒被放寬的項目要保留");
  assert.ok(narrowed.updatedAt && narrowed.updatedNote, "解除/縮小一定要留稽核軌跡");

  // 遠端寫入仍被擋
  replaceNodes(wf.id, [N("t", "trigger"), N("push", "google-sheet-append", { scriptUrl: "https://script.google.com/macros/x/exec", cells: "1" })]);
  expectBlocked(wf.id, /push/);

  // 全部解除
  relaxSafetyContract(wf.id, "使用者明確授權寫入");
  expectAllowed(wf.id, "全部解除後不該再被擋");
  assert.deepEqual(getSafetyContract(wf.id)!.bannedEffects, [], "全部解除後禁止清單清空，但這一列保留當稽核軌跡");
  cleanupAll();
});

test("執行前閘門：AI 產出含寫入節點的圖不會自動解除契約(只有使用者能解除)", () => {
  cleanupAll();
  const wf = makeWorkflow("no-auto-release", [N("t", "trigger"), CALC]);
  recordReadOnlyContractFromUserText(wf.id, "只讀取資料，不要修改");
  // 模擬 AI 之後把圖改成含寫入步驟並存檔——契約必須原封不動，執行照樣被擋
  replaceNodes(wf.id, [N("t", "trigger"), N("save", "write-file", { fileName: "x.txt", content: "x" })]);
  assert.deepEqual([...getSafetyContract(wf.id)!.bannedEffects].sort(), ["email", "file-modify", "file-write", "notify", "remote-write"]);
  expectBlocked(wf.id, /save/);
  cleanupAll();
});

test("執行前閘門：沒有契約的既有流程不受影響(不能被回溯誤鎖)", () => {
  cleanupAll();
  const wf = makeWorkflow("no-contract", [N("t", "trigger"), N("save", "write-file", { fileName: "x.txt", content: "x" })]);
  assert.equal(getSafetyContract(wf.id), null);
  expectAllowed(wf.id, "沒有契約就維持原行為");
  cleanupAll();
});

test("執行前閘門：非 manual 觸發同樣被擋，而且擋在建立 run 之前", () => {
  cleanupAll();
  const fb = makeWorkflow("sched-fb", [N("t", "trigger"), N("mail", "send-email", { to: "x@example.com", subject: "s", body: "b" })]);
  const wf = makeWorkflow("sched", [N("t", "trigger"), CALC], { onFailureWorkflow: fb.id });
  recordReadOnlyContractFromUserText(wf.id, "只讀取資料，不要修改");
  // 排程觸發沒有人在看畫面：一樣要擋、一樣不建立 run(通知走 notifyDesktop，這裡驗的是不執行)
  expectBlocked(wf.id, new RegExp(`onFailureWorkflow → ${fb.id}\\.mail`), "schedule");
  cleanupAll();
});

test("反向索引警示：找得出「哪些只讀母流程會因為這條流程被改動而在下次執行被擋」", () => {
  cleanupAll();
  const child = makeWorkflow("idx-child", [N("t", "trigger"), N("writeSheet", "google-sheet-append", { scriptUrl: "https://script.google.com/macros/x/exec", cells: "1" })]);
  const parent = makeWorkflow("idx-parent", [N("t", "trigger"), N("runChild", "run-workflow", { target: child.id })]);
  recordReadOnlyContractFromUserText(parent.id, "只讀取資料，不要修改");
  const blocked = readOnlyParentsBlockedBy(child.id, listWorkflows);
  assert.equal(blocked.some((b) => b.workflowId === parent.id), true, JSON.stringify(blocked));
  // 沒有契約的母流程不該被列進來(警示不能變成噪音)
  makeWorkflow("idx-parent-free", [N("t", "trigger"), N("runChild", "run-workflow", { target: child.id })]);
  assert.equal(readOnlyParentsBlockedBy(child.id, listWorkflows).some((b) => b.workflowId === `${PREFIX}-idx-parent-free`), false);
  cleanupAll();
});

test("反向索引警示：回報內容可直接給 UI 顯示，而且只保留與被改流程有關的違規", () => {
  cleanupAll();
  const child = makeWorkflow("idx-ui-child", [N("t", "trigger"), N("write", "write-file", { fileName: "x.txt", content: "x" })]);
  const parent = makeWorkflow("idx-ui-parent", [N("t", "trigger"), N("run", "run-workflow", { target: child.id })]);
  recordReadOnlyContractFromUserText(parent.id, "只讀取資料，不要修改");
  const impact = readOnlyParentsBlockedBy(child.id, listWorkflows);
  const match = impact.find((item) => item.workflowId === parent.id);
  assert.ok(match);
  assert.equal(match.workflowName, parent.name);
  assert.ok(match.violations.length > 0);
  assert.ok(match.violations.every((violation) => violation.path.includes(child.id)));
  cleanupAll();
});

test("只讀契約：匯入/複製產生的新流程不得沿用別人的契約", () => {
  cleanupAll();
  const wf = makeWorkflow("clear", [N("t", "trigger"), CALC]);
  recordReadOnlyContractFromUserText(wf.id, "只讀取資料，不要修改");
  assert.ok(getSafetyContract(wf.id));
  clearSafetyContract(wf.id); // 匯入路由在存好新流程後會呼叫這一支
  assert.equal(getSafetyContract(wf.id), null);
  cleanupAll();
});

// ── 副作用範圍一致性(使用者回報) ───────────────────────────────────────────────
// 契約只存了三個資料變更分類，執行前閘門的 delegated 那一側卻自己額外加上 email/notify。
// 結果同一句「只讀取資料，不要修改」，寄信藏在子流程會被擋、直接畫在本圖反而放行——
// 同一份使用者承諾不能因為動作在本圖還是子流程就有不同的安全結果。
const OUTBOUND: [string, WorkflowNode][] = [
  ["send-email", N("mail", "send-email", { to: "x@example.com", subject: "s", body: "b" })],
  ["telegram-notify", N("ping", "telegram-notify", { text: "x" })],
];

test("範圍一致性：只讀契約下，本圖直接新增的寄信/通知也要在建立 run 前被擋", () => {
  cleanupAll();
  for (const [name, node] of OUTBOUND) {
    const wf = makeWorkflow(`direct-${name}`, [N("t", "trigger"), CALC]);
    recordReadOnlyContractFromUserText(wf.id, "只讀取資料，不要修改");
    expectAllowed(wf.id, "還沒加外送步驟時不該被擋");
    replaceNodes(wf.id, [N("t", "trigger"), node]);
    expectBlocked(wf.id, new RegExp(`${node.id}：${name}`));
  }
  cleanupAll();
});

test("範圍一致性：迴圈內嵌的通知也要被擋(容器不是安全的藏身處)", () => {
  cleanupAll();
  const wf = makeWorkflow("loop-notify", [N("t", "trigger"), CALC]);
  recordReadOnlyContractFromUserText(wf.id, "只讀取資料，不要修改");
  replaceNodes(wf.id, [
    N("t", "trigger"),
    N("loop", "repeat-steps", { items: "{{list}}", steps: JSON.stringify([{ type: "telegram-notify", config: { text: "x" } }]) }),
  ]);
  expectBlocked(wf.id, /loop\[步驟0\]：telegram-notify/);
  cleanupAll();
});

test("範圍一致性：同樣的外送動作放在本圖、run-workflow、onFailureWorkflow 的結果必須一致", () => {
  cleanupAll();
  const mailNodes = [N("t", "trigger"), N("mail", "send-email", { to: "x@example.com", subject: "s", body: "b" })];
  // ① 本圖
  const direct = makeWorkflow("same-direct", mailNodes);
  recordReadOnlyContractFromUserText(direct.id, "只讀取資料，不要修改");
  expectBlocked(direct.id, /mail：send-email/);
  // ② 藏在子流程
  const child = makeWorkflow("same-child", mailNodes);
  const viaSub = makeWorkflow("same-via-sub", [N("t", "trigger"), N("runChild", "run-workflow", { target: child.id })]);
  recordReadOnlyContractFromUserText(viaSub.id, "只讀取資料，不要修改");
  expectBlocked(viaSub.id, new RegExp(`runChild → ${child.id}\\.mail`));
  // ③ 藏在失敗備援
  const fb = makeWorkflow("same-fb", mailNodes);
  const viaFb = makeWorkflow("same-via-fb", [N("t", "trigger"), CALC], { onFailureWorkflow: fb.id });
  recordReadOnlyContractFromUserText(viaFb.id, "只讀取資料，不要修改");
  expectBlocked(viaFb.id, new RegExp(`onFailureWorkflow → ${fb.id}\\.mail`));
  cleanupAll();
});

test("精確的單項契約：「不要寄信」只擋 email、「不要通知」只擋 notify，不互相波及", () => {
  cleanupAll();
  const mailOnly = makeWorkflow("only-email", [N("t", "trigger"), CALC]);
  recordReadOnlyContractFromUserText(mailOnly.id, "整理完給我看就好，不要寄信");
  assert.deepEqual(getSafetyContract(mailOnly.id)!.bannedEffects, ["email"], "不要順便升級成全面禁令");
  replaceNodes(mailOnly.id, [N("t", "trigger"), N("ping", "telegram-notify", { text: "x" })]);
  expectAllowed(mailOnly.id, "只說不要寄信時，通知不該被擋");
  replaceNodes(mailOnly.id, [N("t", "trigger"), N("mail", "send-email", { to: "x@example.com", subject: "s", body: "b" })]);
  expectBlocked(mailOnly.id, /mail：send-email/);

  const notifyOnly = makeWorkflow("only-notify", [N("t", "trigger"), CALC]);
  recordReadOnlyContractFromUserText(notifyOnly.id, "跑完不要通知我");
  assert.deepEqual(getSafetyContract(notifyOnly.id)!.bannedEffects, ["notify"]);
  replaceNodes(notifyOnly.id, [N("t", "trigger"), N("save", "write-file", { fileName: "x.txt", content: "x" })]);
  expectAllowed(notifyOnly.id, "只說不要通知時，寫檔不該被擋");
  replaceNodes(notifyOnly.id, [N("t", "trigger"), N("ping", "telegram-notify", { text: "x" })]);
  expectBlocked(notifyOnly.id, /ping：telegram-notify/);
  cleanupAll();
});

test("精確的單項契約：「不要產出檔案」只擋本機新檔，不誤升級成外送禁令、也不擋遠端讀取", () => {
  cleanupAll();
  const wf = makeWorkflow("no-file", [N("t", "trigger"), CALC]);
  recordReadOnlyContractFromUserText(wf.id, "整理一下就好，不要產出檔案");
  assert.deepEqual(getSafetyContract(wf.id)!.bannedEffects, ["file-write"], "不能升級成全面外送禁令");
  replaceNodes(wf.id, [N("t", "trigger"), N("mail", "send-email", { to: "x@example.com", subject: "s", body: "b" })]);
  expectAllowed(wf.id, "「不要產出檔案」不該擋掉寄信");
  replaceNodes(wf.id, [N("t", "trigger"), N("read", "google-sheet-read", { sheetUrl: "https://docs.google.com/spreadsheets/d/x/edit" })]);
  expectAllowed(wf.id, "遠端讀取更不該被擋");
  replaceNodes(wf.id, [N("t", "trigger"), N("save", "write-file", { fileName: "x.txt", content: "x" })]);
  expectBlocked(wf.id, /save：write-file/);
  cleanupAll();
});

test("部分解除：放寬 remote-write 之後仍擋 email/notify；放寬 email 之後仍擋資料寫入", () => {
  cleanupAll();
  const a = makeWorkflow("relax-remote", [N("t", "trigger"), CALC]);
  recordReadOnlyContractFromUserText(a.id, "只讀取資料，不要修改");
  relaxSafetyContract(a.id, "使用者授權寫回試算表", ["remote-write"]);
  replaceNodes(a.id, [N("t", "trigger"), N("push", "google-sheet-append", { scriptUrl: "https://script.google.com/macros/x/exec", cells: "1" })]);
  expectAllowed(a.id, "放寬的那一項要真的能跑");
  replaceNodes(a.id, [N("t", "trigger"), N("mail", "send-email", { to: "x@example.com", subject: "s", body: "b" })]);
  expectBlocked(a.id, /mail：send-email/);

  const b = makeWorkflow("relax-email", [N("t", "trigger"), CALC]);
  recordReadOnlyContractFromUserText(b.id, "只讀取資料，不要修改");
  relaxSafetyContract(b.id, "使用者授權寄結果給自己", ["email"]);
  replaceNodes(b.id, [N("t", "trigger"), N("mail", "send-email", { to: "x@example.com", subject: "s", body: "b" })]);
  expectAllowed(b.id, "放寬 email 後寄信可以跑");
  replaceNodes(b.id, [N("t", "trigger"), N("save", "write-file", { fileName: "x.txt", content: "x" })]);
  expectBlocked(b.id, /save：write-file/);
  const remaining = getSafetyContract(b.id)!;
  assert.equal(remaining.bannedEffects.includes("email"), false);
  assert.deepEqual([...remaining.bannedEffects].sort(), ["file-modify", "file-write", "notify", "remote-write"]);
  assert.ok(remaining.updatedAt && remaining.updatedNote, "部分解除一樣要留稽核軌跡");
  cleanupAll();
});
