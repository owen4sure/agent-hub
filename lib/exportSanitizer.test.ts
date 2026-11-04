import test from "node:test";
import assert from "node:assert/strict";
import { redactKnownSecrets } from "./exportSanitizer";

test("安全匯出：說明、header、網址與 custom-code 內嵌的已知帳密全部替換成引用", () => {
  const source = {
    description: "token=very-secret-token",
    nodes: [{ config: { headers: '{"Authorization":"Bearer very-secret-token"}', url: "https://x.test/?key=api-key-1234", code: "send('very-secret-token')" } }],
  };
  const out = redactKnownSecrets(source, { githubToken: "very-secret-token", MODEL_API_KEY: "api-key-1234" });
  assert.equal(JSON.stringify(out).includes("very-secret-token"), false);
  assert.equal(JSON.stringify(out).includes("api-key-1234"), false);
  assert.match(JSON.stringify(out), /githubToken/);
  assert.match(JSON.stringify(out), /MODEL_API_KEY/);
  assert.equal(source.description, "token=very-secret-token", "不能修改記憶體裡的原 workflow");
});

test("安全匯出：節點內的 Apps Script 寫入網址即使不在帳密表也會清空", () => {
  const source = { nodes: [{ config: { scriptUrl: "https://script.google.com/macros/s/deployment-id/exec", sheetUrl: "https://docs.google.com/spreadsheets/d/public/edit" } }] };
  const out = redactKnownSecrets(source, {});
  assert.equal(out.nodes[0].config.scriptUrl, "");
  assert.equal(out.nodes[0].config.sheetUrl, source.nodes[0].config.sheetUrl, "一般讀取網址要保留");
});
