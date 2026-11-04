import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileSourceEvidence, mailSourceEvidence, urlSourceEvidence } from "./runtimeEvidence";

test("執行期來源證據：檔案只回傳檔名與內容指紋，不回傳完整路徑", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-runtime-evidence-"));
  const file = path.join(dir, "資料.pdf");
  fs.writeFileSync(file, "sample");
  try {
    const evidence = fileSourceEvidence(file, { numPages: 1, textChars: 6 });
    assert.equal(evidence.reference, "資料.pdf");
    assert.equal(evidence.sha256?.length, 64);
    assert.equal(evidence.size, 6);
    assert.equal(evidence.observed?.textChars, 6);
    assert.ok(!JSON.stringify(evidence).includes(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("執行期來源證據：網址只回傳網域，信件只回傳信箱摘要", () => {
  const url = urlSourceEvidence("https://example.com/private?token=secret", { observed: { status: 200 } });
  const mail = mailSourceEvidence("INBOX:uid:secret-subject", "IMAP 信箱（INBOX）", { attachmentCount: 1 });
  assert.equal(url.reference, "example.com");
  assert.equal(url.sha256, null);
  assert.equal(mail.reference, "IMAP 信箱（INBOX）");
  assert.equal(mail.observed?.attachmentCount, 1);
  assert.ok(!JSON.stringify(url).includes("token=secret"));
  assert.ok(!JSON.stringify(mail).includes("secret-subject"));
});
