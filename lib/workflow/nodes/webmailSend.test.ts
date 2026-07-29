import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
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

// 真實踩過、而且是最難發現的那一種：三行 log 都寫著「已填」，畫面上卻是收件人欄裡塞著
// 一整段內文、內文區空白。原因是這套信箱的收件人欄本身就是 textarea(要能填多個地址)，
// 而內文填寫在找不到富文字編輯器時會退回找 textarea，就抓到它了。
test("內文絕不能寫進已經填過的欄位——收件人本身也是 textarea", () => {
  // execute 內部呼叫 fillBody，函式本體不在 execute 的字串裡；直接讀原始碼確認這條防線還在
  const source = readFileSync(new URL("./webmailSend.ts", import.meta.url), "utf-8");
  assert.match(source, /textarea:not\(\[data-agenthub-field\]\)/,
    "退回 textarea 時必須排除已經用過的欄位，否則會把內文覆蓋到收件人上");
  assert.match(source, /waitComposeClosed/, "「表單有沒有收起來」是判斷信箱收下了沒的唯一可靠訊號");
});
