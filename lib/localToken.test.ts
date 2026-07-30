import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isPublicApiPath, localTokenMatches, readLocalToken } from "./localToken";

/**
 * 本機存取權杖是安全邊界，所以每一條「擋什麼、放行什麼」的規則都要有測試釘住。
 * 特別是白名單——那是唯一可以不帶權杖的入口，任何人(或任何 AI 工具)哪天順手多加一條路徑進去，
 * 這裡就要立刻紅燈。
 */

test("權杖：產生後存進 data/local-token，權限是 0600(同機其他 OS 帳號讀不到)", () => {
  const token = readLocalToken();
  assert.ok(token && token.length >= 32, "權杖要有足夠長度");
  const file = path.join(process.cwd(), "data", "local-token");
  assert.ok(fs.existsSync(file));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test("權杖比對：只有完全相同才通過，空值/錯值/長度不同一律不通過", () => {
  const token = readLocalToken()!;
  assert.equal(localTokenMatches(token), true);
  assert.equal(localTokenMatches(null), false);
  assert.equal(localTokenMatches(""), false);
  assert.equal(localTokenMatches("x"), false);
  assert.equal(localTokenMatches(`${token}x`), false);
  assert.equal(localTokenMatches(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")), false);
});

test("環境變數可以覆寫權杖(給常駐/腳本用)", () => {
  const original = process.env.AGENT_HUB_LOCAL_TOKEN;
  process.env.AGENT_HUB_LOCAL_TOKEN = "env-token-value-that-is-long-enough-0123456789";
  try {
    assert.equal(localTokenMatches("env-token-value-that-is-long-enough-0123456789"), true);
    assert.equal(localTokenMatches("something-else"), false);
  } finally {
    if (original === undefined) delete process.env.AGENT_HUB_LOCAL_TOKEN;
    else process.env.AGENT_HUB_LOCAL_TOKEN = original;
  }
});

test("公開路徑白名單：只有 webhook / Google 導回 / 健康檢查免權杖", () => {
  // 這幾條必須放行，否則對應功能會整個壞掉(外部服務不可能知道本機權杖)
  assert.equal(isPublicApiPath("/api/hooks/abc/def"), true);
  assert.equal(isPublicApiPath("/api/line-hooks/abc/def"), true);
  assert.equal(isPublicApiPath("/api/oauth/google/callback"), true);
  assert.equal(isPublicApiPath("/api/health"), true);

  // 這些絕對不能被放行——每一條都等於「能執行任意程式碼」或「能讀明碼帳密」
  for (const guarded of [
    "/api/workflows",
    "/api/workflows/wf-1/run",
    "/api/workflows/import",
    "/api/secrets",
    "/api/secrets/reveal",
    "/api/settings/reveal",
    "/api/user-steps",
    "/api/fetch-url",
    "/api/oauth/google/start",
    "/api/oauth/google/status",
  ]) {
    assert.equal(isPublicApiPath(guarded), false, `${guarded} 不該免權杖`);
  }
});
