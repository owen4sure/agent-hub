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

test("錯誤訊息要指到「只有你本人能做」的那件事", () => {
  assert.match(
    friendlyApiError(403, '{"error":{"message":"User has not enabled the Apps Script API"}}'),
    /usersettings/,
    "API 總開關沒開時要直接給他那個網址",
  );
  assert.match(friendlyApiError(403, "Request had insufficient authentication scopes."), /重新授權/);
  assert.match(friendlyApiError(429, "quota"), /過一下再試/);
  assert.match(friendlyApiError(500, "boom"), /HTTP 500/);
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
      (err: unknown) => err instanceof AppsScriptDeployError && /手動步驟/.test((err as Error).message),
    );
  } finally {
    globalThis.fetch = original;
  }
});
