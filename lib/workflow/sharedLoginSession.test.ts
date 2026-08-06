import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedSessionKeyFor, resolveSharedSessionKeyForGraph, sharedSessionFileName } from "./sharedLoginSession";

function loginNode(config: Record<string, unknown>) {
  return { type: "browser-login" as const, config };
}

test("sharedSessionKeyFor：預設是開的——完全沒設定這個欄位的節點(以後新增的節點)也要當作已開共用", () => {
  assert.ok(sharedSessionKeyFor(loginNode({})));
});

test("sharedSessionKeyFor：明確關掉開關才回 null，使用者要各自獨立登入時仍然做得到", () => {
  assert.equal(sharedSessionKeyFor(loginNode({ shareLoginAcrossWorkflows: false })), null);
  assert.equal(sharedSessionKeyFor(loginNode({ shareLoginAcrossWorkflows: "false" })), null);
});

test("sharedSessionKeyFor：設定頁存回來的開關值是字串 \"true\" 也要當作有開(跟 cfgBool 同一套判斷準則)", () => {
  const a = sharedSessionKeyFor(loginNode({ shareLoginAcrossWorkflows: true }));
  const b = sharedSessionKeyFor(loginNode({ shareLoginAcrossWorkflows: "true" }));
  assert.ok(a);
  assert.equal(a, b);
});

test("sharedSessionKeyFor：不是 browser-login 節點一律回 null", () => {
  assert.equal(sharedSessionKeyFor({ type: "webmail-send", config: { shareLoginAcrossWorkflows: true } }), null);
});

test("sharedSessionKeyFor：同樣網址主機＋同樣帳密欄位名稱，兩個節點要算出同一把共用代號", () => {
  const a = sharedSessionKeyFor(loginNode({
    shareLoginAcrossWorkflows: true, url: "{{webmailUrl}}", accountSecret: "webmailAccount", passwordSecret: "webmailPassword",
  }));
  const b = sharedSessionKeyFor(loginNode({
    shareLoginAcrossWorkflows: true, url: "{{webmailUrl}}", accountSecret: "webmailAccount", passwordSecret: "webmailPassword",
  }));
  assert.ok(a);
  assert.equal(a, b);
});

test("sharedSessionKeyFor：帳密欄位名稱不同(代表不是同一個帳號)要算出不同的代號", () => {
  const a = sharedSessionKeyFor(loginNode({ shareLoginAcrossWorkflows: true, accountSecret: "webmailAccount", passwordSecret: "webmailPassword" }));
  const b = sharedSessionKeyFor(loginNode({ shareLoginAcrossWorkflows: true, accountSecret: "otherAccount", passwordSecret: "otherPassword" }));
  assert.notEqual(a, b);
});

test("sharedSessionKeyFor：欄位留空要退回跟節點預設值一樣的推導結果(舊資料/尚未展開設定過的節點也能正確共用)", () => {
  const explicit = sharedSessionKeyFor(loginNode({
    shareLoginAcrossWorkflows: true, url: "{{webmailUrl}}", accountSecret: "webmailAccount", passwordSecret: "webmailPassword",
  }));
  const usingDefaults = sharedSessionKeyFor(loginNode({ shareLoginAcrossWorkflows: true }));
  assert.equal(explicit, usingDefaults);
});

test("resolveSharedSessionKeyForGraph：整張圖只要有一個節點開了共用，就回那把代號", () => {
  const nodes = [
    { type: "trigger", config: {} },
    loginNode({ shareLoginAcrossWorkflows: true, accountSecret: "webmailAccount", passwordSecret: "webmailPassword" }),
  ];
  assert.equal(resolveSharedSessionKeyForGraph(nodes), sharedSessionKeyFor(loginNode({ shareLoginAcrossWorkflows: true, accountSecret: "webmailAccount", passwordSecret: "webmailPassword" })));
});

test("resolveSharedSessionKeyForGraph：圖裡沒有 browser-login 節點就回 null", () => {
  const nodes = [{ type: "trigger", config: {} }];
  assert.equal(resolveSharedSessionKeyForGraph(nodes), null);
});

test("resolveSharedSessionKeyForGraph：全部節點都明確關掉共用開關才回 null，需要各自獨立登入時仍然做得到", () => {
  const nodes = [{ type: "trigger", config: {} }, loginNode({ shareLoginAcrossWorkflows: false })];
  assert.equal(resolveSharedSessionKeyForGraph(nodes), null);
});

test("sharedSessionFileName：跟一般每條流程各自一份的檔名格式要能明顯分辨開來", () => {
  const name = sharedSessionFileName("abc123");
  assert.equal(name, "shared-abc123.json");
});
