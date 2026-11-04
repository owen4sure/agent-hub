import assert from "node:assert/strict";
import test from "node:test";
import { parseResponseContract, parseStatusSpec, statusMatches, validateResponseContract } from "./httpContract";

test("HTTP 狀態合約支援範圍與列舉，且拒絕壞格式", () => {
  const spec = parseStatusSpec("200-201,204");
  assert.equal(statusMatches(200, spec), true);
  assert.equal(statusMatches(204, spec), true);
  assert.equal(statusMatches(404, spec), false);
  assert.throws(() => parseStatusSpec("200-"), /格式不正確/);
});

test("回應欄位合約驗證巢狀欄位與型別", () => {
  const contract = parseResponseContract('{"id":"string","data.items":"array","data.total":"number"}');
  assert.deepEqual(validateResponseContract({ id: "x", data: { items: [], total: 2 } }, contract), []);
  assert.deepEqual(validateResponseContract({ id: 1, data: { items: "bad" } }, contract), ["id 應該是 string", "data.items 應該是 array", "缺少欄位 data.total"]);
});

test("空白合約不限制回應，未知型別拒絕保存", () => {
  assert.equal(parseResponseContract(""), null);
  assert.throws(() => parseResponseContract('{"id":"date"}'), /格式不正確/);
});
