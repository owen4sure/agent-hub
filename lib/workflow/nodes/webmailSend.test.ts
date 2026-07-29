import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { describeOutgoingMail, resolveAttachmentPaths, splitRecipients, webmailSendNode } from "./webmailSend";
import { nodeTypesWithSideEffect, dryRunSkipTypes } from "../sideEffects";
import { getNodeDef } from "../registry";

test("收件人怎麼分隔都接得住(逗號/分號/頓號/換行)", () => {
  assert.deepEqual(splitRecipients("a@x.com, b@x.com;c@x.com、d@x.com\ne@x.com"),
    ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);
  assert.deepEqual(splitRecipients("  "), []);
});

test("附件相對路徑以流程產出資料夾為基準(上一步做好的檔案通常在那裡)", () => {
  assert.deepEqual(resolveAttachmentPaths("報表.xlsx, /tmp/絕對.pdf", "/out"),
    [path.join("/out", "報表.xlsx"), "/tmp/絕對.pdf"]);
});

// 安全排練的重點不是「跳過」，是讓使用者在寄出去之前看到收件人對不對、{{欄位}} 有沒有換成值。
test("安全排練的預覽要是人看得懂的整封信，不是欄位傾印", () => {
  const text = describeOutgoingMail({
    to: ["a@example.com"], cc: [], bcc: ["secret@example.com"],
    subject: "7/22-7/28 週報", body: "各位好，\n數字如下。", attachments: ["/out/週報.xlsx"], signature: "業務用",
  });
  assert.match(text, /沒有真的寄出去/);
  assert.match(text, /a@example\.com/);
  assert.match(text, /secret@example\.com/, "密件副本也要列出來——它最不容易被發現，更要讓人看到");
  assert.match(text, /7\/22-7\/28 週報/);
  assert.match(text, /週報\.xlsx/);
  assert.match(text, /各位好/);
  assert.doesNotMatch(text, /\{\{/, "預覽裡不該還有大括號——那正是使用者要確認的事");
});

// 寄信是不可逆的：已送出但確認那一步失敗時若重跑，收件人會收到兩封。
test("這個節點不准自動重試", () => {
  assert.equal(webmailSendNode.retryable, false);
  assert.equal(webmailSendNode.maxAttempts, 1);
});

test("必須被登記成「會外送」，否則所有寄信防線都繞過它", () => {
  assert.ok(nodeTypesWithSideEffect("email").has("webmail-send"), "沒登記的話：只讀契約擋不住、需求驗收不會發現 AI 自作主張加了寄信");
  assert.ok(getNodeDef("webmail-send"), "節點要真的註冊進去，AI 才畫得出來");
});

// self-guard 而不是 skip：引擎整步跳過的話，使用者在安全排練時看不到「寄出去會長什麼樣」。
test("安全排練由節點自己守門，但一定不會真的寄出去", () => {
  assert.ok(!dryRunSkipTypes().has("webmail-send"));
  const source = String(webmailSendNode.execute);
  assert.match(source, /ctx\.dryRun/, "execute 裡必須自己檢查 dryRun");
});

test("設定欄位要用白話，而且看得出 {{欄位}} 可以用", () => {
  const keys = webmailSendNode.configSchema.map((f) => f.key);
  for (const key of ["to", "cc", "bcc", "subject", "body", "bodyFormat", "signature", "attachPaths", "verifySent"]) {
    assert.ok(keys.includes(key), `少了 ${key}`);
  }
  const labels = webmailSendNode.configSchema.map((f) => f.label).join("\n");
  assert.match(labels, /\{\{欄位\}\}/, "要在標籤裡告訴使用者可以帶上游資料");
  // 進階欄位要標明「進階」，小白掃過去就知道不用碰
  for (const key of ["mailSystem", "composeUrl"]) {
    const field = webmailSendNode.configSchema.find((f) => f.key === key)!;
    assert.match(field.label, /進階/, `${key} 要標成進階`);
  }
});
