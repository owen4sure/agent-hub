import { test } from "node:test";
import assert from "node:assert/strict";
import {
  imapCredsFromSecrets,
  mailMatchesFilters,
  safeAttachmentName,
  pickBodyText,
  envelopeFromText,
  openImap,
  MAIL_BODY_MAX_CHARS,
} from "./mailClient";

test("openImap:呼叫前已取消就立即停止，不嘗試連線", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    openImap({ host: "192.0.2.1", port: 993, secure: true, user: "x", pass: "y" }, controller.signal),
    /已停止執行/,
  );
});

test("imapCredsFromSecrets:缺任一必填欄位回 null", () => {
  assert.equal(imapCredsFromSecrets({}), null);
  assert.equal(imapCredsFromSecrets({ imapHost: "imap.gmail.com", imapAccount: "a@b.c" }), null);
  assert.equal(imapCredsFromSecrets({ imapHost: " ", imapAccount: "a@b.c", imapPassword: "x" }), null);
});

test("imapCredsFromSecrets:993(含預設)直接 TLS;其他 port 明文起手(STARTTLS 自動升級)", () => {
  const def = imapCredsFromSecrets({ imapHost: "imap.gmail.com", imapAccount: "a@b.c", imapPassword: "x" });
  assert.deepEqual(def, { host: "imap.gmail.com", port: 993, secure: true, user: "a@b.c", pass: "x" });
  const plain = imapCredsFromSecrets({ imapHost: "mail.corp", imapPort: "143", imapAccount: "a", imapPassword: "x" });
  assert.equal(plain?.port, 143);
  assert.equal(plain?.secure, false);
  const custom = imapCredsFromSecrets({ imapHost: "mail.corp", imapPort: "1430", imapAccount: "a", imapPassword: "x" });
  assert.equal(custom?.port, 1430);
  assert.equal(custom?.secure, false);
});

test("mailMatchesFilters:留空=不限;比對不分大小寫;主旨+寄件人都要過", () => {
  const env = { fromText: "老闆 <Boss@Company.com>", subject: "每日庫存日報 7/12" };
  assert.equal(mailMatchesFilters(env, "", ""), true);
  assert.equal(mailMatchesFilters(env, "boss@", ""), true);
  assert.equal(mailMatchesFilters(env, "", "庫存日報"), true);
  assert.equal(mailMatchesFilters(env, "boss@", "庫存"), true);
  assert.equal(mailMatchesFilters(env, "alice@", ""), false);
  assert.equal(mailMatchesFilters(env, "boss@", "發票"), false);
});

test("safeAttachmentName:去路徑成分、擋穿越、空名給序號", () => {
  assert.equal(safeAttachmentName("報表.xlsx", 0), "報表.xlsx");
  assert.equal(safeAttachmentName("../../etc/passwd", 0), "passwd");
  assert.equal(safeAttachmentName("..", 2), "attachment-3");
  assert.equal(safeAttachmentName(undefined, 0), "attachment-1");
  assert.equal(safeAttachmentName("a/b\\c:d.txt", 0).includes("/"), false);
});

test("pickBodyText:text 優先;沒 text 用 html 去標籤;超長截斷", () => {
  assert.equal(pickBodyText({ text: "純文字內文", html: "<p>HTML</p>" }), "純文字內文");
  assert.equal(pickBodyText({ text: "", html: "<style>.a{}</style><p>哈囉&nbsp;世界</p><script>x()</script>" }), "哈囉 世界");
  assert.equal(pickBodyText({}), "");
  const long = pickBodyText({ text: "x".repeat(MAIL_BODY_MAX_CHARS + 500) });
  assert.equal(long.length, MAIL_BODY_MAX_CHARS);
});

test("envelopeFromText:名字+地址/只有地址/空信封", () => {
  assert.equal(envelopeFromText({ from: [{ name: "老闆", address: "boss@c.com" }] }), "老闆 <boss@c.com>");
  assert.equal(envelopeFromText({ from: [{ address: "boss@c.com" }] }), "boss@c.com");
  assert.equal(envelopeFromText(undefined), "");
});
