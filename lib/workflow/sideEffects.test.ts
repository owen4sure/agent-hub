import { test } from "node:test";
import assert from "node:assert/strict";
import { NODE_SIDE_EFFECTS, configuredSideEffects, nodeTypesWithSideEffect } from "./sideEffects";
import { DRYRUN_WRITE_TYPES, dryRunSkipKind } from "./dryRun";
import { listNodeDefs } from "./registry";
import type { WorkflowNode } from "./types";

/**
 * 這支測試是「兩份手寫清單漸漸漂移」的防線。分類集中在 sideEffects.ts，而且**必須涵蓋 registry 的
 * 每一個型別**：新增節點卻沒有分類，第一條測試就會失敗，作者被迫做一次明確決定(純讀取寫 `[]`)。
 *
 * ⚠️ 這裡刻意**不寫**「推導結果必須跟重構前的清單完全一致」那種斷言。上一版就是那樣寫的，結果把
 * 「遠端寫入不算資料變更」這個安全缺口永久釘成預期行為——`google-sheet-append` 被排除在需求驗收的
 * 寫入型別之外，使用者說「只讀取資料、不要修改」時完全放行(P0)。凍結清單保護的是實作細節，
 * 不是安全性質；要盯的是**行為**：該擋的有沒有擋、不該擋的有沒有誤擋。
 */

const node = (type: string, config: Record<string, unknown> = {}): WorkflowNode =>
  ({ id: "n", type, label: type, config, position: { x: 0, y: 0 } });

test("副作用分類必須涵蓋 registry 的每一個節點型別(新增節點沒分類就直接失敗)", () => {
  const registryTypes = listNodeDefs().map((def) => def.type).sort();
  const classified = Object.keys(NODE_SIDE_EFFECTS).sort();
  const missing = registryTypes.filter((type) => !(type in NODE_SIDE_EFFECTS));
  const stale = classified.filter((type) => !registryTypes.includes(type));
  assert.deepEqual(missing, [], `這些節點型別還沒在 sideEffects.ts 分類副作用：${missing.join("、")}`);
  assert.deepEqual(stale, [], `這些型別已經不在 registry 裡，分類要一起移除：${stale.join("、")}`);
});

// 分類表描述的是「節點實際會做什麼」，不是「dry-run 怎麼處理它」。這兩件事一旦混為一談，就會為了
// 配合 dry-run 的實作策略而謊報能力——這正是遠端寫入被需求驗收放行的成因。
test("會改動外部服務資料的節點一律標成 remote-write，不因 dry-run 的處理方式不同而漏標", () => {
  const remote = nodeTypesWithSideEffect("remote-write");
  for (const type of ["google-sheet-append", "google-sheet-update", "google-slides-create", "google-slides-refresh"]) {
    assert.equal(remote.has(type), true, `${type} 會改動使用者 Google 帳號裡的資料，必須標成 remote-write`);
  }
});

test("只寫本次執行工作區的節點(抓輸入用)不得被當成使用者資料變更", () => {
  const changes = nodeTypesWithSideEffect("file-write", "file-modify", "remote-write");
  for (const type of ["download-attachment", "unzip", "browser-login"]) {
    assert.equal(changes.has(type), false, `${type} 只是把輸入抓進工作區，擋掉它會讓「只讀取信件附件來分析」這種正常需求無法建圖`);
  }
});

// dry-run 的既有安全保證不可放寬：以前一律整步略過的型別，現在必須仍然一律整步略過。
// 用「涵蓋」而不是「完全相等」斷言——完全相等會連「未來要多擋一種」都擋掉，那又是另一種凍結。
test("dry-run：原本一律整步略過的寫出型節點，一個都不能少", () => {
  for (const type of ["send-email", "telegram-notify", "line-notify", "slack-notify", "desktop-notify", "write-file", "google-sheet-append", "google-sheet-update"]) {
    assert.equal(DRYRUN_WRITE_TYPES.has(type), true, `${type} 在只讀試跑必須整步略過`);
    assert.equal(dryRunSkipKind(node(type), false), "write");
  }
});

test("dry-run：自己在動手前 return 的節點不能改成整步略過(會讓讀取/驗證輸出消失、下游假成功)", () => {
  for (const type of ["excel-process", "google-slides-create", "google-slides-refresh", "wait-approval"]) {
    assert.equal(DRYRUN_WRITE_TYPES.has(type), false, `${type} 由節點自己在寫入前 return，整步略過會讓下游拿不到驗證結果`);
  }
});

test("configuredSideEffects：http-request 預設不信任 POST/PUT/PATCH/DELETE，GET/HEAD 才是明確的讀取", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.deepEqual(configuredSideEffects("http-request", { method }).effects, ["remote-write"], `${method} 預設要當成會寫`);
    assert.equal(dryRunSkipKind(node("http-request", { method }), false), "write", `${method} 在只讀試跑必須被攔`);
  }
  for (const method of ["GET", "HEAD", "get"]) {
    assert.deepEqual(configuredSideEffects("http-request", { method }).effects, []);
    assert.equal(dryRunSkipKind(node("http-request", { method }), false), null);
  }
});

// 信任邊界：節點 config 的 readOnly 是 AI 建圖/修復/匯入都能直接寫進去的欄位。真實踩過的 P0——
// 一開始把它當成放行條件，AI 只要誤判或幻覺，就能把真的會寫入的 POST 標成唯讀並通過所有安全檢查。
// 它只能是「AI 的建議」；真正的放行條件是使用者對這一份精確請求按下的確認(見 httpReadOnlyApproval)。
test("configuredSideEffects：AI 自己寫的 readOnly 只是建議，不構成放行", () => {
  for (const claim of [true, "true", "yes", 1]) {
    const result = configuredSideEffects("http-request", { method: "POST", readOnly: claim });
    assert.deepEqual(result.effects, ["remote-write"], `readOnly:${JSON.stringify(claim)} 不該讓 POST 被放行`);
  }
  // 但「AI 建議唯讀」這個訊號要保留下來，UI 才講得出「AI 建議這是查詢，但需要你確認」
  assert.equal(configuredSideEffects("http-request", { method: "POST", readOnly: true }).awaitingUserConfirmation, true);
  assert.equal(configuredSideEffects("http-request", { method: "POST" }).awaitingUserConfirmation, false, "AI 沒建議就不是在等確認，是單純的寫入呼叫");
  assert.deepEqual(
    configuredSideEffects("http-request", { method: "POST", url: "https://api.notion.com/v1/databases/x/query" }).effects,
    ["remote-write"],
    "網址看起來像查詢一樣不算數",
  );
  // 只有呼叫端查到「使用者確認過」才放行
  assert.deepEqual(configuredSideEffects("http-request", { method: "POST" }, { readOnlyApproved: true }).effects, []);
});

test("configuredSideEffects：custom-code 依實際程式碼判斷，空殼退回看 intent，兩者皆無則判定不出", () => {
  assert.deepEqual(configuredSideEffects("custom-code", { code: "await fs.promises.writeFile(p, x);" }).effects.length > 0, true);
  assert.deepEqual(configuredSideEffects("custom-code", { code: "const n = rows.reduce((a, b) => a + b.amount, 0); return { total: n };" }).effects, []);
  // 有 code 時不掃 intent：純讀取程式碼裡的中文防呆(「不把猜測數字填回去」)不該被當成寫入
  assert.deepEqual(configuredSideEffects("custom-code", { code: "return { total: 1 };", intent: "對不上就停止，不要把猜測數字填回去" }).effects, []);
  assert.deepEqual(configuredSideEffects("custom-code", { intent: "把結果寫入 Google 試算表" }).effects.length > 0, true);
  assert.deepEqual(configuredSideEffects("custom-code", { intent: "計算加總與平均" }).effects, []);
  // 既沒有 code 也沒有 intent = 靜態完全判斷不出來，只讀需求下必須 fail closed
  assert.equal(configuredSideEffects("custom-code", {}).undetermined, true);
  assert.equal(configuredSideEffects("custom-code", { intent: "計算加總" }).undetermined, false);
});

test("configuredSideEffects：只認得 http-request／custom-code 這兩種設定決定副作用的型別", () => {
  assert.deepEqual(configuredSideEffects("google-sheet-append", {}), { effects: [], undetermined: false });
  assert.deepEqual(configuredSideEffects("read-file", {}), { effects: [], undetermined: false });
});
