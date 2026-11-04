import { test } from "node:test";
import assert from "node:assert/strict";
import { AppsScriptDeployError, buildManifest, deployWebApp, friendlyApiError } from "./appsScriptDeploy";

/**
 * 自動部署這條路上，**每一種失敗都對應一件只有使用者本人能做的事**。
 * 講不清楚是哪一件，這個「自動化」就等於沒省到事——他還是得回來問。
 */

test("清單檔一定要有 webapp 區段，否則部署會成功卻拿不到 /exec 網址", () => {
  const manifest = JSON.parse(buildManifest(["https://www.googleapis.com/auth/presentations"]));
  assert.deepEqual(manifest.webapp, { executeAs: "USER_DEPLOYING", access: "ANYONE_ANONYMOUS" },
    "對應手動部署精靈的「執行身分＝我自己」「誰可以存取＝任何人」");
  assert.deepEqual(manifest.oauthScopes, ["https://www.googleapis.com/auth/presentations"]);
  assert.equal(manifest.runtimeVersion, "V8");
});

test("「Apps Script API 沒開」的兩種要分清楚——指錯地方比不指還糟", () => {
  // 真實踩過：使用者照訊息去把帳號層開關打開了，再按一次還是同一句話，等於卡死。
  // 因為真正擋住他的是 Cloud 專案層那個，是完全不同的畫面。
  const project = friendlyApiError(403, JSON.stringify({ error: { message:
    "Apps Script API has not been used in project 123456789 before or it is disabled. "
    + "Enable it by visiting https://console.developers.google.com/apis/api/script.googleapis.com/overview?project=123456789 then retry." } }));
  assert.match(project.message, /Cloud 專案/);
  assert.equal(project.actionUrl, "https://console.developers.google.com/apis/api/script.googleapis.com/overview?project=123456789",
    "一定要用 Google 自己給的那個網址——它帶著使用者的專案編號，我們組不出來");

  const personal = friendlyApiError(403, '{"error":{"message":"User has not enabled the Apps Script API"}}');
  assert.match(personal.message, /個人開關/);
  assert.equal(personal.actionUrl, "https://script.google.com/home/usersettings");
  assert.doesNotMatch(personal.message, /Cloud 專案/, "不能跟另一種混在一起");

  assert.match(friendlyApiError(403, "Request had insufficient authentication scopes.").message, /重新授權/);
  assert.match(friendlyApiError(429, "quota").message, /過一下再試/);
  assert.match(friendlyApiError(500, "boom").message, /HTTP 500/);
  // 原始訊息永遠保留：判斷式分類錯的時候，這是唯一能對照的東西
  assert.equal(friendlyApiError(500, "boom").raw, "boom");
});

function fakeFetch(steps: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://script.googleapis.com/v1", "");
    calls.push({ method: init.method as string, path, body: init.body ? JSON.parse(String(init.body)) : null });
    const key = `${init.method} ${path.replace(/\/projects\/[^/]+/, "/projects/{id}")}`;
    const value = steps[key];
    if (value === undefined) return new Response(JSON.stringify({ error: { message: "unexpected " + key } }), { status: 500 });
    return new Response(JSON.stringify(value));
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const OK_STEPS = {
  "POST /projects": { scriptId: "SID" },
  "PUT /projects/{id}/content": {},
  "POST /projects/{id}/versions": { versionNumber: 1 },
  "POST /projects/{id}/deployments": {
    deploymentId: "DID",
    entryPoints: [{ entryPointType: "WEB_APP", webApp: { url: "https://script.google.com/macros/s/AAA/exec" } }],
  },
};

test("第一次部署：建專案 → 寫檔 → 建版本 → 部署，並回傳 /exec 網址", async () => {
  const original = globalThis.fetch;
  const { fn, calls } = fakeFetch(OK_STEPS);
  globalThis.fetch = fn;
  try {
    const result = await deployWebApp({ accessToken: "t", title: "T", code: "function doPost(){}", oauthScopes: ["s"] });
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path.replace("SID", "{id}")}`),
      ["POST /projects", "PUT /projects/{id}/content", "POST /projects/{id}/versions", "POST /projects/{id}/deployments"],
    );
    assert.equal(result.webAppUrl, "https://script.google.com/macros/s/AAA/exec");
    assert.equal(result.created, true);
    // 清單檔一定要跟程式碼一起送上去，否則部署出來的不是網頁應用程式
    const content = calls[1].body as { files: { name: string }[] };
    assert.deepEqual(content.files.map((f) => f.name).sort(), ["Code", "appsscript"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("已經部署過就更新同一個部署，不能再建一個新網址", async () => {
  const original = globalThis.fetch;
  const { fn, calls } = fakeFetch({
    "PUT /projects/{id}/content": {},
    "POST /projects/{id}/versions": { versionNumber: 7 },
    "PUT /projects/{id}/deployments/DID": {
      deploymentId: "DID",
      entryPoints: [{ webApp: { url: "https://script.google.com/macros/s/AAA/exec" } }],
    },
  });
  globalThis.fetch = fn;
  try {
    const result = await deployWebApp({
      accessToken: "t", title: "T", code: "x", oauthScopes: ["s"],
      existingScriptId: "SID", existingDeploymentId: "DID",
    });
    assert.equal(result.created, false);
    assert.ok(!calls.some((c) => c.method === "POST" && c.path === "/projects"), "不能再建一個新專案");
    assert.ok(calls.some((c) => c.method === "PUT" && c.path.endsWith("/deployments/DID")), "要更新既有部署");
    assert.equal(result.webAppUrl, "https://script.google.com/macros/s/AAA/exec",
      "網址不變，使用者流程裡填的設定才不用改");
  } finally {
    globalThis.fetch = original;
  }
});

test("部署了卻沒拿到網頁應用程式網址，要老實報錯並指路到手動步驟", async () => {
  const original = globalThis.fetch;
  const { fn } = fakeFetch({ ...OK_STEPS, "POST /projects/{id}/deployments": { deploymentId: "DID", entryPoints: [] } });
  globalThis.fetch = fn;
  try {
    await assert.rejects(
      () => deployWebApp({ accessToken: "t", title: "T", code: "x", oauthScopes: ["s"] }),
      (err: unknown) => err instanceof AppsScriptDeployError && /手動步驟/.test(err.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});
