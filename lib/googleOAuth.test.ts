import test from "node:test";
import assert from "node:assert/strict";
import { GOOGLE_SCOPES, buildGoogleAuthUrl, claimOAuthState, googleAuthErrorMessage, googleRedirectUri, googleScopesForNodes, issueOAuthState } from "./googleOAuth";
import type { WorkflowNode } from "./workflow/types";

const node = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type, label: id, config, position: { x: 0, y: 0 } });

// 舊流程要使用者自己到 OAuth Playground 挑權限範圍。挑漏一個的代價是「幾天後執行時 403」，
// 而那時候沒有人會聯想到是當初少勾了一項——真實踩過(少了試算表唯讀，刷新連結圖表就失敗)。
test("權限範圍由節點型別推導", () => {
  const scopes = googleScopesForNodes([
    node("t", "trigger"),
    node("read", "google-sheet-read"),
    node("slides", "google-slides-refresh"),
  ]);
  assert.deepEqual(scopes.sort(), [GOOGLE_SCOPES.slides, GOOGLE_SCOPES.sheetsRead].sort());
});

// 這台機器上真正在打 Google API 的是 custom-code(型別只是 "custom-code")。
// 只看節點型別會一個都認不出來，使用者就會拿到一組少了權限的授權。
test("custom-code 裡真的打了哪個 API 也要算進去", () => {
  const code = "await fetch(`https://slides.googleapis.com/v1/presentations/${id}:batchUpdate`)\n"
    + "await fetch('https://sheets.googleapis.com/v4/spreadsheets/x')";
  const scopes = googleScopesForNodes([node("t", "trigger"), node("api", "custom-code", { code })]);
  assert.ok(scopes.includes(GOOGLE_SCOPES.slides));
  assert.ok(scopes.includes(GOOGLE_SCOPES.sheetsRead));
});

test("迴圈內嵌步驟的 API 呼叫一樣要算到（漏算＝少要權限＝幾天後才炸）", () => {
  const steps = JSON.stringify([{ type: "custom-code", label: "每項", config: { code: "fetch('https://slides.googleapis.com/v1/x')" } }]);
  assert.ok(googleScopesForNodes([node("loop", "repeat-steps", { steps })]).includes(GOOGLE_SCOPES.slides));
});

test("有 Apps Script 網頁應用程式時要一併要指令碼權限，之後平台才能自己更新部署", () => {
  const scopes = googleScopesForNodes([node("w", "google-sheet-update", { scriptUrl: "https://script.google.com/macros/s/AKfy.../exec" })]);
  assert.ok(scopes.includes(GOOGLE_SCOPES.scriptProjects));
  assert.ok(scopes.includes(GOOGLE_SCOPES.scriptDeployments));
});

test("有完整試算表權限就不再重複要唯讀（少一個要使用者看懂的項目）", () => {
  const scopes = googleScopesForNodes([node("r", "google-sheet-read"), node("w", "google-sheet-append")]);
  assert.ok(scopes.includes(GOOGLE_SCOPES.sheetsWrite));
  assert.ok(!scopes.includes(GOOGLE_SCOPES.sheetsRead));
});

// access_type=offline 少了就拿不到 refresh token；prompt=consent 少了的話，使用者先前同意過時
// Google 只會回 access token——畫面看起來成功、實際什麼都沒存到，是這個流程最容易的假成功。
test("授權網址一定要帶 offline + consent，否則會是假成功", () => {
  const url = buildGoogleAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:3000/cb", scopes: [GOOGLE_SCOPES.slides], state: "abc" });
  const params = new URL(url).searchParams;
  assert.equal(params.get("access_type"), "offline");
  assert.equal(params.get("prompt"), "consent");
  assert.equal(params.get("state"), "abc");
  assert.equal(params.get("redirect_uri"), "http://127.0.0.1:3000/cb");
});

test("重新導向網址一律正規化成 127.0.0.1，使用者在 Google 那邊只要註冊一行", () => {
  assert.equal(googleRedirectUri("http://localhost:3000/api/oauth/google/start"), "http://127.0.0.1:3000/api/oauth/google/callback");
  assert.equal(googleRedirectUri("http://127.0.0.1:3001/api/oauth/google/start"), "http://127.0.0.1:3001/api/oauth/google/callback");
});

test("state 是一次性的：用過就作廢，偽造或過期一律不認", () => {
  const state = issueOAuthState("http://127.0.0.1:3000/cb", [GOOGLE_SCOPES.slides]);
  assert.deepEqual(claimOAuthState(state)?.scopes, [GOOGLE_SCOPES.slides]);
  assert.equal(claimOAuthState(state), null, "第二次就不該再認");
  assert.equal(claimOAuthState("不是我發的"), null);
  assert.equal(claimOAuthState(""), null);
});

// 只說「授權失效」等於把問題丟回給看不懂的人。每一句都要指出具體那顆按鈕或那個欄位。
test("Google 的錯誤代碼要翻成看得懂的下一步", () => {
  assert.match(googleAuthErrorMessage("invalid_grant"), /重新連結/);
  assert.match(googleAuthErrorMessage("invalid_client"), /googleOAuthClientId/);
  assert.match(googleAuthErrorMessage("redirect_uri_mismatch"), /已授權的重新導向 URI/);
  assert.match(googleAuthErrorMessage("access_denied"), /取消/);
});
