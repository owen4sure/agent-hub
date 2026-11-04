import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramMessageMatches, telegramChatAllowed, telegramTriggerParams } from "./telegramPoller";

test("telegramMessageMatches:留空=任何訊息;包含比對不分大小寫", () => {
  assert.equal(telegramMessageMatches("早餐 65", ""), true);
  assert.equal(telegramMessageMatches("記帳 早餐 65", "記帳"), true);
  assert.equal(telegramMessageMatches("REPORT today", "report"), true);
  assert.equal(telegramMessageMatches("早餐 65", "記帳"), false);
});

test("telegramChatAllowed:沒綁定 Chat ID 一律不觸發(安全預設);綁了只認那一個", () => {
  assert.equal(telegramChatAllowed("123", ""), false);
  assert.equal(telegramChatAllowed("123", "  "), false);
  assert.equal(telegramChatAllowed("123", "123"), true);
  assert.equal(telegramChatAllowed("999", "123"), false);
});

test("telegramTriggerParams:名字組合/username 備援/欄位齊全", () => {
  const p = telegramTriggerParams({ message_id: 7, text: "記帳 早餐 65", chat: { id: 123 }, from: { first_name: "Owen", last_name: "C" } });
  assert.deepEqual(p, { message: "記帳 早餐 65", chatId: "123", fromName: "Owen C", messageId: 7 });
  const u = telegramTriggerParams({ text: "hi", chat: { id: 5 }, from: { username: "owen4sure" } });
  assert.equal(u.fromName, "owen4sure");
  const empty = telegramTriggerParams({});
  assert.deepEqual(empty, { message: "", chatId: "", fromName: "", messageId: 0 });
});
