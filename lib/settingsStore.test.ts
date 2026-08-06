import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFolderPath } from "./settingsStore";

test("normalizeFolderPath：單層路徑去頭尾空白", () => {
  assert.equal(normalizeFolderPath("  工作專案  "), "工作專案");
});

test("normalizeFolderPath：巢狀路徑各段分別去空白，用 / 重組", () => {
  assert.equal(normalizeFolderPath(" 工作專案 / 子資料夾 "), "工作專案/子資料夾");
});

test("normalizeFolderPath：雙斜線/前導斜線/尾端斜線都會被收斂掉(空段被濾掉)", () => {
  assert.equal(normalizeFolderPath("//工作專案//子資料夾//"), "工作專案/子資料夾");
});

test("normalizeFolderPath：全空白或空字串回傳 null(代表沒有輸入)", () => {
  assert.equal(normalizeFolderPath(""), null);
  assert.equal(normalizeFolderPath("   "), null);
  assert.equal(normalizeFolderPath("///"), null);
});

test("normalizeFolderPath：單段超過 40 字會截斷成 40 字，不是整段濾掉", () => {
  // 踩過的真實 bug：濾掉整段會讓「公司/一個過長的子資料夾名稱」悄悄退化成已存在的「公司」，
  // 新增資料夾 API 回 {ok:true} 卻什麼都沒建立，使用者打的名稱整段消失也沒有任何錯誤提示。
  const long = "a".repeat(41);
  assert.equal(normalizeFolderPath(`工作專案/${long}/子資料夾`), `工作專案/${"a".repeat(40)}/子資料夾`);
});

test("normalizeFolderPath：只有一段且超過 40 字時，截斷後仍是合法路徑(不會誤判成空輸入)", () => {
  const long = "b".repeat(50);
  assert.equal(normalizeFolderPath(long), "b".repeat(40));
});

test("normalizeFolderPath：整條路徑超過 150 字時退回只取第一段(不产生對不上原意的截斷路徑)", () => {
  const seg = "測試段落".repeat(6); // 24 字/段
  const many = Array.from({ length: 8 }, () => seg).join("/"); // 遠超過 150 字
  const result = normalizeFolderPath(many);
  assert.ok(result !== null);
  assert.ok(result!.length <= 150);
  assert.equal(result, seg.slice(0, 150));
});

test("明碼帳密補加密：只動明碼、加密後讀取端無感、既有密文原封不動", async () => {
  const { getDb } = await import("./db");
  const { encryptLegacyPlaintextSecrets } = await import("./settingsStore");
  const { decryptSecret, isEncryptedSecret } = await import("./secretVault");
  const db = getDb();
  const WF = "zz-test-legacy-secrets";
  try {
    db.prepare(`INSERT OR REPLACE INTO secrets (workflow_id, key, value) VALUES (?, 'zzLegacyPlain', 'plain-value')`).run(WF);
    encryptLegacyPlaintextSecrets();
    const row = db.prepare(`SELECT value FROM secrets WHERE workflow_id = ? AND key = 'zzLegacyPlain'`).get(WF) as { value: string };
    assert.equal(isEncryptedSecret(row.value), true, "明碼要被補加密");
    assert.equal(decryptSecret(row.value), "plain-value", "讀取端拿到的值不能變");
    assert.equal(encryptLegacyPlaintextSecrets(), 0, "重跑一次不該再動任何東西");
  } finally {
    db.prepare(`DELETE FROM secrets WHERE workflow_id = ?`).run(WF);
  }
});
