import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyLineSignature, extractLineTextEvents } from "./lineHook";

test("verifyLineSignature:正確簽章過;錯簽章/缺秘密/缺 header 都擋", () => {
  const secret = "test-channel-secret";
  const body = JSON.stringify({ events: [] });
  const good = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(verifyLineSignature(secret, body, good), true);
  assert.equal(verifyLineSignature(secret, body, "AAAA" + good.slice(4)), false);
  assert.equal(verifyLineSignature(secret, body + " ", good), false); // body 被動過=簽章失效
  assert.equal(verifyLineSignature("", body, good), false);
  assert.equal(verifyLineSignature(secret, body, null), false);
});

test("extractLineTextEvents:只收文字訊息事件;貼圖/加好友/驗證空包都略過;壞 payload 回空", () => {
  const payload = {
    events: [
      { type: "message", replyToken: "r1", source: { userId: "U1" }, message: { type: "text", text: "請假明天" } },
      { type: "message", replyToken: "r2", source: { userId: "U1" }, message: { type: "sticker" } },
      { type: "follow", replyToken: "r3", source: { userId: "U2" } },
      { type: "message", replyToken: "r4", source: {}, message: { type: "text", text: "第二句" } },
    ],
  };
  const events = extractLineTextEvents(payload);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { message: "請假明天", userId: "U1", replyToken: "r1" });
  assert.deepEqual(events[1], { message: "第二句", userId: "", replyToken: "r4" });
  assert.deepEqual(extractLineTextEvents({ events: [] }), []); // LINE 的 webhook 驗證空包
  assert.deepEqual(extractLineTextEvents(null), []);
  assert.deepEqual(extractLineTextEvents({ events: "junk" }), []);
});
