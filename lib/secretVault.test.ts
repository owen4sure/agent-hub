import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  decryptBytes,
  decryptSecret,
  encryptBytes,
  encryptSecret,
  isEncryptedBytes,
  isEncryptedSecret,
  resolveVaultKey,
  type VaultKeyDeps,
} from "./secretVault";
import { keychainDelete, keychainGet, keychainSet, type KeychainStore } from "./keychain";

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

test("二進位加密：備份裡的登入狀態解得回來，毀損的回 null 不裝沒事", () => {
  const data = Buffer.from(JSON.stringify({ cookies: [{ name: "session", value: "很機密" }] }));
  const sealed = encryptBytes(data);
  assert.equal(isEncryptedBytes(sealed), true);
  assert.equal(sealed.includes("很機密"), false, "密文裡不能看得到內容");
  assert.ok(decryptBytes(sealed)?.equals(data));
  const corrupted = Buffer.from(sealed);
  corrupted[corrupted.length - 1] ^= 0xff;
  assert.equal(decryptBytes(corrupted), null);
});

/**
 * 釘住的承諾：金鑰搬進 Keychain 的過程**絕不能有任何一條路弄丟既有金鑰**——
 * 金鑰一丟，使用者存的所有帳密就是永遠解不開的垃圾。
 * 所有分支都對著暫存目錄＋假 Keychain 測，不碰使用者真正的金鑰。
 */

function fakeKeychain(initial?: Buffer): KeychainStore & { stored: Buffer | null } {
  const box: KeychainStore & { stored: Buffer | null } = {
    stored: initial ?? null,
    get: () => box.stored,
    set: (key) => { box.stored = Buffer.from(key); return true; },
  };
  return box;
}

function brokenKeychain(): KeychainStore {
  return { get: () => null, set: () => false };
}

function tempDeps(keychain: KeychainStore): VaultKeyDeps & { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  return { dir, keyFile: path.join(dir, "key"), markerFile: path.join(dir, "key.location"), keychain };
}

test("遷移：檔案金鑰搬進 Keychain，讀回一致才刪檔並留下標記", () => {
  const kc = fakeKeychain();
  const deps = tempDeps(kc);
  try {
    const original = crypto.randomBytes(32);
    fs.writeFileSync(deps.keyFile, original.toString("base64"));
    const resolved = resolveVaultKey(deps);
    assert.ok(resolved.equals(original), "遷移後拿到的必須是同一把金鑰");
    assert.ok(kc.stored?.equals(original), "Keychain 裡要是原本那把");
    assert.equal(fs.existsSync(deps.keyFile), false, "驗證過才刪檔");
    assert.equal(fs.readFileSync(deps.markerFile, "utf8"), "keychain");
  } finally {
    fs.rmSync(deps.dir, { recursive: true, force: true });
  }
});

test("Keychain 寫不進去(非 macOS/被鎖)：金鑰檔原地不動，一切照舊", () => {
  const deps = tempDeps(brokenKeychain());
  try {
    const original = crypto.randomBytes(32);
    fs.writeFileSync(deps.keyFile, original.toString("base64"));
    const resolved = resolveVaultKey(deps);
    assert.ok(resolved.equals(original));
    assert.equal(fs.existsSync(deps.keyFile), true, "搬不動就不能刪檔");
  } finally {
    fs.rmSync(deps.dir, { recursive: true, force: true });
  }
});

test("標記說金鑰在 Keychain 但讀不到：大聲報錯，絕不重生一把新的", () => {
  const deps = tempDeps(brokenKeychain());
  try {
    fs.writeFileSync(deps.markerFile, "keychain");
    assert.throws(() => resolveVaultKey(deps), /不會.*自動產生|key:import/);
    assert.equal(fs.existsSync(deps.keyFile), false, "更不能順手寫一個新金鑰檔出來");
  } finally {
    fs.rmSync(deps.dir, { recursive: true, force: true });
  }
});

test("Keychain 與檔案不一致(data/ 從別台機器搬來)：用檔案那把，兩邊都不動", () => {
  const kcKey = crypto.randomBytes(32);
  const fileKey = crypto.randomBytes(32);
  const kc = fakeKeychain(kcKey);
  const deps = tempDeps(kc);
  try {
    fs.writeFileSync(deps.keyFile, fileKey.toString("base64"));
    const resolved = resolveVaultKey(deps);
    assert.ok(resolved.equals(fileKey), "密文跟檔案金鑰是一起搬來的，只有它解得開");
    assert.equal(fs.existsSync(deps.keyFile), true);
    assert.ok(kc.stored?.equals(kcKey), "Keychain 那把也不能覆蓋——它可能還保護著這台機器的舊備份");
  } finally {
    fs.rmSync(deps.dir, { recursive: true, force: true });
  }
});

test("全新安裝＋Keychain 可用：金鑰只進 Keychain，不落地檔案", () => {
  const kc = fakeKeychain();
  const deps = tempDeps(kc);
  try {
    const resolved = resolveVaultKey(deps);
    assert.equal(resolved.length, 32);
    assert.ok(kc.stored?.equals(resolved));
    assert.equal(fs.existsSync(deps.keyFile), false);
  } finally {
    fs.rmSync(deps.dir, { recursive: true, force: true });
  }
});

test("全新安裝＋Keychain 不可用：跟以前一樣用檔案(非 macOS 的正常路)", () => {
  const deps = tempDeps(brokenKeychain());
  try {
    const resolved = resolveVaultKey(deps);
    const onDisk = Buffer.from(fs.readFileSync(deps.keyFile, "utf8").trim(), "base64");
    assert.ok(resolved.equals(onDisk));
  } finally {
    fs.rmSync(deps.dir, { recursive: true, force: true });
  }
});

test("環境變數金鑰永遠優先，什麼都不遷移", () => {
  const kc = fakeKeychain();
  const deps = { ...tempDeps(kc), envKey: "managed-deploy-key" };
  try {
    fs.writeFileSync(deps.keyFile, crypto.randomBytes(32).toString("base64"));
    resolveVaultKey(deps);
    assert.equal(fs.existsSync(deps.keyFile), true, "有環境變數時不該動本機金鑰檔");
    assert.equal(kc.stored, null);
  } finally {
    fs.rmSync(deps.dir, { recursive: true, force: true });
  }
});

/* ── 真 Keychain 整合測試(只在 macOS 跑；用測試專用的 service 名稱並清乾淨) ── */

test("macOS Keychain 真的存得進去、讀得回來、內容一致", { skip: process.platform !== "darwin" }, () => {
  const SERVICE = "zz-agent-hub-vault-test";
  const ACCOUNT = "zz-test";
  try {
    const key = crypto.randomBytes(32);
    assert.equal(keychainSet(key, SERVICE, ACCOUNT), true);
    assert.ok(keychainGet(SERVICE, ACCOUNT)?.equals(key));
    // -U 更新既有那筆也要能用(遷移重跑不該失敗)
    const rotated = crypto.randomBytes(32);
    assert.equal(keychainSet(rotated, SERVICE, ACCOUNT), true);
    assert.ok(keychainGet(SERVICE, ACCOUNT)?.equals(rotated));
  } finally {
    keychainDelete(SERVICE, ACCOUNT);
  }
});
