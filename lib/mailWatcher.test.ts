import { test } from "node:test";
import assert from "node:assert/strict";
import { mailClaimKey, mailSeedKey, mailTriggerConfig, uniqueAttachmentName } from "./mailWatcher";

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

test("uniqueAttachmentName:第一次撞名加 -2,再撞加 -3;沒撞名原樣返回", () => {
  const used = new Set<string>();
  assert.equal(uniqueAttachmentName(used, "報表.xlsx"), "報表.xlsx");
  used.add("報表.xlsx");
  assert.equal(uniqueAttachmentName(used, "報表.xlsx"), "報表-2.xlsx");
  used.add("報表-2.xlsx");
  assert.equal(uniqueAttachmentName(used, "報表.xlsx"), "報表-3.xlsx");
});

test("uniqueAttachmentName:比對不分大小寫(避免同一天信在不同檔案系統上撞名)", () => {
  const used = new Set<string>(["report.xlsx"]);
  assert.equal(uniqueAttachmentName(used, "REPORT.XLSX"), "REPORT-2.XLSX");
});

test("uniqueAttachmentName:沒副檔名的檔名也能正確加序號", () => {
  const used = new Set<string>(["readme"]);
  assert.equal(uniqueAttachmentName(used, "readme"), "readme-2");
});
