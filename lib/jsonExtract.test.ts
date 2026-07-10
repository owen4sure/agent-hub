import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject, stripCodeFences } from "./jsonExtract";

test("extractJsonObject：純 JSON 直接解出來", () => {
  const r = extractJsonObject('{"phase":"ready","message":"ok"}');
  assert.deepEqual(r, { phase: "ready", message: "ok" });
});

test("extractJsonObject：JSON 包在 ```json 程式碼框裡優先抓框內的", () => {
  const raw = '這是我的想法：\n```json\n{"phase":"edits","edits":[]}\n```\n希望有幫助';
  const r = extractJsonObject(raw);
  assert.deepEqual(r, { phase: "edits", edits: [] });
});

// 這是踩過的真實 bug：貪婪 regex 會被使用者訊息裡的 {{變數}} 模板字樣騙走，從錯的位置開始配對
test("extractJsonObject：文字裡混著 {{模板}} 字樣不能干擾抓取", () => {
  const raw = '使用者說要用 {{month1SearchDate}} 當日期。\n\n{"phase":"clarify","message":"請問日期格式？"}';
  const r = extractJsonObject(raw, (o) => typeof o.phase === "string");
  assert.deepEqual(r, { phase: "clarify", message: "請問日期格式？" });
});

test("extractJsonObject：predicate 跳過不符合的候選物件，找下一個", () => {
  const raw = '模型內心獨白 {"foo":1} 然後真正答案 {"phase":"ready","nodes":[],"edges":[]}';
  const r = extractJsonObject(raw, (o) => typeof o.phase === "string");
  assert.deepEqual(r, { phase: "ready", nodes: [], edges: [] });
});

test("extractJsonObject：巢狀物件與字串裡的跳脫大括號不會打亂配對", () => {
  const raw = '{"phase":"edits","edits":[{"nodeId":"n1","config":{"code":"return {a:1}"}}]}';
  const r = extractJsonObject(raw);
  assert.equal((r?.edits as unknown[])?.length, 1);
});

test("extractJsonObject：完全沒有合法 JSON 就回 null", () => {
  assert.equal(extractJsonObject("這只是一段純文字回覆，沒有 JSON"), null);
});

test("stripCodeFences：拿掉程式碼框，保留其餘文字", () => {
  const raw = "說明文字\n```js\nconst x = 1;\n```\n結尾文字";
  const stripped = stripCodeFences(raw);
  assert.ok(!stripped.includes("const x"));
  assert.ok(stripped.includes("說明文字"));
  assert.ok(stripped.includes("結尾文字"));
});
