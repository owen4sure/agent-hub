import { test } from "node:test";
import assert from "node:assert/strict";
import { queryTokens } from "./communityIndex";

test("queryTokens:中文需求詞對映到英文服務 token", () => {
  const t = queryTokens("每天早上抓網頁重點寄 email 給我");
  assert.ok(t.has("cron") || t.has("schedule"));
  assert.ok(t.has("gmail") || t.has("email"));
  assert.ok(t.has("http"));
});

test("queryTokens:英文字直接保留、太短的丟掉", () => {
  const t = queryTokens("用 telegram 通知我 GitHub 的 pr");
  assert.ok(t.has("telegram"));
  assert.ok(t.has("github"));
  assert.ok(t.has("pr"));
  assert.ok(!t.has("a"));
});

test("queryTokens:沒有可比對內容回空集合", () => {
  assert.equal(queryTokens("嗨").size, 0);
});
