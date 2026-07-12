import { test } from "node:test";
import assert from "node:assert/strict";
import { mailClaimKey, mailSeedKey, mailTriggerConfig } from "./mailWatcher";

test("mailClaimKey:綁資料夾+UIDVALIDITY+uid;空資料夾名補 INBOX", () => {
  assert.equal(mailClaimKey("INBOX", "17", 42), "#mail#:INBOX:17:42");
  assert.equal(mailClaimKey("", "17", 42), "#mail#:INBOX:17:42");
});

test("mailSeedKey:以 #seeded#: 開頭(30 天清理會保留哨兵);UIDVALIDITY 變了=新哨兵", () => {
  const k = mailSeedKey("INBOX", "17");
  assert.ok(k.startsWith("#seeded#:"));
  assert.notEqual(k, mailSeedKey("INBOX", "18"));
  assert.notEqual(k, mailSeedKey("Archive", "17"));
});

test("mailTriggerConfig:沒開啟回 null;開啟時給預設資料夾+修剪空白", () => {
  assert.equal(mailTriggerConfig(undefined), null);
  assert.equal(mailTriggerConfig({}), null);
  assert.equal(mailTriggerConfig({ mailWatch: "off" }), null);
  assert.deepEqual(mailTriggerConfig({ mailWatch: "on" }), { folder: "INBOX", fromFilter: "", subjectFilter: "" });
  assert.deepEqual(
    mailTriggerConfig({ mailWatch: "on", mailFolder: " Archive ", mailFromFilter: " boss ", mailSubjectFilter: " 日報 " }),
    { folder: "Archive", fromFilter: "boss", subjectFilter: "日報" },
  );
});
