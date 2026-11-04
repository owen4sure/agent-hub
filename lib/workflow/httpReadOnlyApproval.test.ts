import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approveHttpReadOnly,
  approvedReadOnlyNodeIds,
  clearHttpReadOnlyApprovals,
  httpRequestFingerprint,
  isHttpReadOnlyApproved,
  revokeHttpReadOnly,
} from "./httpReadOnlyApproval";
import { dryRunSkipKind } from "./dryRun";
import type { WorkflowNode } from "./types";

/**
 * 這裡驗的是**信任邊界**：節點 config 上的 `readOnly` 只是 AI 的建議，真正讓一個 POST 在只讀試跑
 * 執行的，只能是使用者對「這一份精確請求」按下的確認。真實踩過的 P0：一開始把 config 的布林值當成
 * 放行條件，AI 只要寫一句 readOnly:true 就能讓真的會寫入的 POST 通過所有安全檢查。
 *
 * 直接用真的 DB(跟 waitApproval.test.ts 同一套作法)，用「換一個網址之後還過不過」這種外部可觀察
 * 的事實驗證，而不是讀程式碼推論。測試用的 workflow id 加前綴，跑完自己清乾淨。
 */

const WF = "test-wf-http-readonly-approval";
const NODE = "api";
const base = { method: "POST", url: "https://api.example.com/v1/query", headers: '{"Authorization":"Bearer x"}', body: '{"q":1}' };
const node = (config: Record<string, unknown>): WorkflowNode => ({ id: NODE, type: "http-request", label: "打 API", config, position: { x: 0, y: 0 } });

test("唯讀確認：AI 寫的 readOnly:true 本身不算確認，仍然被只讀試跑攔下", () => {
  clearHttpReadOnlyApprovals(WF);
  const aiClaims = { ...base, readOnly: true };
  assert.equal(isHttpReadOnlyApproved(WF, NODE, aiClaims), false, "AI 自己說了不算");
  // 沒有把「已確認節點」傳進去 = 一律未確認，dry-run 照樣攔
  assert.equal(dryRunSkipKind(node(aiClaims), false), "write");
  assert.equal(dryRunSkipKind(node(aiClaims), false, { readOnlyApprovedNodeIds: approvedReadOnlyNodeIds(WF, [node(aiClaims)]) }), "write");
  clearHttpReadOnlyApprovals(WF);
});

test("唯讀確認：使用者確認後，同一份精確請求可以在只讀試跑真的執行", () => {
  clearHttpReadOnlyApprovals(WF);
  approveHttpReadOnly(WF, NODE, base);
  assert.equal(isHttpReadOnlyApproved(WF, NODE, base), true);
  const approved = approvedReadOnlyNodeIds(WF, [node(base)]);
  assert.deepEqual([...approved], [NODE]);
  assert.equal(dryRunSkipKind(node(base), false, { readOnlyApprovedNodeIds: approved }), null, "確認過的請求不該被略過");
  clearHttpReadOnlyApprovals(WF);
});

test("唯讀確認：method/url/headers/body 任何一項被改掉，確認立刻失效", () => {
  for (const [field, changed] of [
    ["url", { ...base, url: "https://api.example.com/v1/pages" }],
    ["method", { ...base, method: "PUT" }],
    ["body", { ...base, body: '{"q":2}' }],
    ["headers", { ...base, headers: '{"Authorization":"Bearer attacker"}' }],
  ] as const) {
    clearHttpReadOnlyApprovals(WF);
    approveHttpReadOnly(WF, NODE, base);
    assert.equal(isHttpReadOnlyApproved(WF, NODE, base), true, "先確認原本那份");
    assert.equal(isHttpReadOnlyApproved(WF, NODE, changed), false, `${field} 被改掉之後不該沿用舊的確認`);
    assert.equal(
      dryRunSkipKind(node(changed), false, { readOnlyApprovedNodeIds: approvedReadOnlyNodeIds(WF, [node(changed)]) }),
      "write",
      `${field} 被改掉之後只讀試跑要重新攔住`,
    );
  }
  clearHttpReadOnlyApprovals(WF);
});

test("唯讀確認：headers 只是欄位順序/大小寫不同不該讓確認失效(同一份請求)", () => {
  clearHttpReadOnlyApprovals(WF);
  approveHttpReadOnly(WF, NODE, { ...base, headers: '{"Authorization":"Bearer x","Accept":"application/json"}' });
  assert.equal(
    isHttpReadOnlyApproved(WF, NODE, { ...base, headers: '{"accept":"application/json","authorization":"Bearer x"}' }),
    true,
    "同一組 header 只是順序/大小寫不同，不該逼使用者重按一次",
  );
  clearHttpReadOnlyApprovals(WF);
});

test("唯讀確認：readOnly 這個 AI 建議欄位本身不進指紋(它不是請求內容)", () => {
  assert.equal(httpRequestFingerprint(base), httpRequestFingerprint({ ...base, readOnly: true }));
  assert.notEqual(httpRequestFingerprint(base), httpRequestFingerprint({ ...base, url: "https://other" }));
});

test("唯讀確認：確認綁在「這條流程的這個節點」上，別條流程/別的節點不會沾光", () => {
  clearHttpReadOnlyApprovals(WF);
  clearHttpReadOnlyApprovals(`${WF}-other`);
  approveHttpReadOnly(WF, NODE, base);
  assert.equal(isHttpReadOnlyApproved(`${WF}-other`, NODE, base), false, "匯入/複製會產生新的流程 id，確認不得跟著跑過去");
  assert.equal(isHttpReadOnlyApproved(WF, "another-node", base), false);
  clearHttpReadOnlyApprovals(WF);
});

test("唯讀確認：匯入時清空(即使新流程剛好沿用到同一個 id 也不會留下舊批准)、使用者也能自己取消", () => {
  clearHttpReadOnlyApprovals(WF);
  approveHttpReadOnly(WF, NODE, base);
  clearHttpReadOnlyApprovals(WF); // 匯入路由在存好新流程後會呼叫這一支
  assert.equal(isHttpReadOnlyApproved(WF, NODE, base), false);

  approveHttpReadOnly(WF, NODE, base);
  revokeHttpReadOnly(WF, NODE);
  assert.equal(isHttpReadOnlyApproved(WF, NODE, base), false);
  clearHttpReadOnlyApprovals(WF);
});

test("唯讀確認：approvedReadOnlyNodeIds 只認 http-request，且指紋對不上就不列入", () => {
  clearHttpReadOnlyApprovals(WF);
  approveHttpReadOnly(WF, NODE, base);
  const wrongType: WorkflowNode = { id: NODE, type: "google-sheet-append", label: "x", config: base, position: { x: 0, y: 0 } };
  assert.deepEqual([...approvedReadOnlyNodeIds(WF, [wrongType])], []);
  assert.deepEqual([...approvedReadOnlyNodeIds(WF, [node({ ...base, url: "https://changed" })])], []);
  assert.deepEqual([...approvedReadOnlyNodeIds(WF, [node(base)])], [NODE]);
  clearHttpReadOnlyApprovals(WF);
});

// 一條被多處重用的純讀子流程，只要它的擁有者確認過那個查詢端點，重用它的父流程就不該被重複擋下
// (過度保守會逼使用者把共用流程拆散)。但確認絕不跨流程沿用——這一組驗的就是那條界線。
test("唯讀確認：子流程重用——確認綁在「這條流程的這個節點的這一份請求」，改動內容或換一條流程都要重新 fail closed", () => {
  const CHILD = `${WF}-child`;
  clearHttpReadOnlyApprovals(CHILD);
  clearHttpReadOnlyApprovals(WF);
  const childNodes = [node(base)];

  // ① 子流程擁有者還沒確認 → 空集合(父流程分析會據此把它當成會寫)
  assert.deepEqual([...approvedReadOnlyNodeIds(CHILD, childNodes)], []);

  // ② 子流程擁有者確認過 → 子流程本人的確認集合帶得出來，重用它的父流程可以放行
  approveHttpReadOnly(CHILD, NODE, base);
  assert.deepEqual([...approvedReadOnlyNodeIds(CHILD, childNodes)], [NODE]);

  // ③ 父流程自己確認過同名節點，不能讓子流程沾光(查的是子流程自己的 id)
  approveHttpReadOnly(WF, NODE, base);
  clearHttpReadOnlyApprovals(CHILD);
  assert.deepEqual([...approvedReadOnlyNodeIds(CHILD, childNodes)], [], "父流程的確認不得替子流程背書");

  // ④ 子流程被改動(等同匯入/複製後內容不同、或被 AI 改過)→ 指紋不符，重新 fail closed
  approveHttpReadOnly(CHILD, NODE, base);
  assert.deepEqual([...approvedReadOnlyNodeIds(CHILD, [node({ ...base, url: "https://api.example.com/v1/create" })])], []);

  // ⑤ 撤銷確認 → 立刻回到未確認
  revokeHttpReadOnly(CHILD, NODE);
  assert.deepEqual([...approvedReadOnlyNodeIds(CHILD, childNodes)], []);
  clearHttpReadOnlyApprovals(CHILD);
  clearHttpReadOnlyApprovals(WF);
});
