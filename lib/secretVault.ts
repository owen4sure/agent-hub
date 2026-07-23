import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db";

/**
 * Values in SQLite backups must not be directly readable.  A caller may supply
 * AGENT_HUB_SECRET_KEY for managed deployments; a local install gets a private
 * per-machine key file instead.  This is deliberately a small dependency-free
 * vault so a fresh clone remains usable for non-technical users.
 */
const PREFIX = "agent-hub:v1:";
const KEY_FILE = path.join(DATA_DIR, ".secret-vault-key");
let cachedKey: Buffer | undefined;

function privateWrite(file: string, value: string) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, value, { encoding: "utf8" });
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform !== "win32") {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on unusual filesystems */ }
  }
}

function vaultKey(): Buffer {
  if (cachedKey) return cachedKey;
  const configured = process.env.AGENT_HUB_SECRET_KEY?.trim();
  if (configured) {
    cachedKey = crypto.createHash("sha256").update(configured).digest();
    return cachedKey;
  }
  try {
    const stored = fs.readFileSync(KEY_FILE, "utf8").trim();
    const decoded = Buffer.from(stored, "base64");
    if (decoded.length === 32) {
      cachedKey = decoded;
      return cachedKey;
    }
  } catch { /* first run creates the local key below */ }
  const generated = crypto.randomBytes(32);
  try {
    privateWrite(KEY_FILE, generated.toString("base64"));
    cachedKey = generated;
    return cachedKey;
  } catch {
    // A second local process may have created it between our read and write.
    const stored = fs.readFileSync(KEY_FILE, "utf8").trim();
    const decoded = Buffer.from(stored, "base64");
    if (decoded.length !== 32) throw new Error("本機帳密保管金鑰格式不正確");
    cachedKey = decoded;
    return cachedKey;
  }
}

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", vaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

/** Legacy plaintext values remain readable once, then become encrypted on their next save. */
export function decryptSecret(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const pieces = value.slice(PREFIX.length).split(":");
  if (pieces.length !== 3) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", vaultKey(), Buffer.from(pieces[0], "base64url"));
    decipher.setAuthTag(Buffer.from(pieces[1], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(pieces[2], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Never pass a corrupt encrypted blob to a workflow as if it were a credential.
    return "";
  }
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}
