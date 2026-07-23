import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secretVault";

test("secret vault：SQLite 值不是明碼且可正確還原", () => {
  const value = "a-real-secret-value";
  const encrypted = encryptSecret(value);
  assert.notEqual(encrypted, value);
  assert.equal(encrypted.includes(value), false);
  assert.equal(isEncryptedSecret(encrypted), true);
  assert.equal(decryptSecret(encrypted), value);
});

test("secret vault：舊版明碼可讀，損毀密文不會被當成有效帳密", () => {
  assert.equal(decryptSecret("legacy-value"), "legacy-value");
  assert.equal(decryptSecret("agent-hub:v1:not-valid"), "");
});
