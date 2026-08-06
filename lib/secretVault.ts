import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, getDb } from "./db";
import { realKeychainStore, type KeychainStore } from "./keychain";

/**
 * 帳密保管庫。值以 AES-256-GCM 加密存進 SQLite；金鑰的家依序是：
 *
 *   ① AGENT_HUB_SECRET_KEY 環境變數(受管部署用)
 *   ② macOS Keychain(2026-08 起的預設——金鑰檔跟密文同住 data/ 等於鎖和鑰匙綁在一起，
 *      整包拷走 data/ 就全破；Keychain 讓離線拷走磁碟的人只拿得到密文)
 *   ③ data/.secret-vault-key 檔案(非 macOS、或 Keychain 寫不進去時的退路)
 *
 * 既有安裝的遷移是**惰性**的：新版程式第一次要用金鑰時，把檔案裡的金鑰搬進 Keychain、
 * **讀回驗證一致才刪檔**，並留下 location 標記。此後如果 Keychain 讀不到，一律大聲報錯——
 * 絕不能默默重新產生一把新金鑰，那會讓既有的所有密文變成永遠解不開的垃圾，
 * 而且症狀(每條流程的帳密都「格式不正確」)完全看不出根本原因。
 */
const PREFIX = "agent-hub:v1:";
const KEY_FILE = path.join(DATA_DIR, ".secret-vault-key");
/** 內容固定是 "keychain"——存在代表金鑰已搬家，檔案讀不到不代表可以重生金鑰。 */
const LOCATION_MARKER = path.join(DATA_DIR, ".secret-vault-key.location");
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

/**
 * 「檔案不存在」與「檔案存在但格式不對」是兩件完全不同的事：前者可以走全新安裝，
 * 後者代表這台機器**曾經有一把金鑰**(可能被截斷/污染)——這時默默產生新金鑰會讓
 * 既有密文永遠解不開,而且症狀看起來只是「每條流程的帳密都不對」(code review 抓到的回歸:
 * 舊版遇到格式不對是直接拋錯的,遷移改寫時不能把這個保護弄丟)。
 */
function readKeyFile(keyFile: string): { state: "missing" } | { state: "corrupt" } | { state: "ok"; key: Buffer } {
  let raw: string;
  try {
    raw = fs.readFileSync(keyFile, "utf8");
  } catch {
    return { state: "missing" };
  }
  const decoded = Buffer.from(raw.trim(), "base64");
  return decoded.length === 32 ? { state: "ok", key: decoded } : { state: "corrupt" };
}

export interface VaultKeyDeps {
  envKey?: string;
  keyFile: string;
  markerFile: string;
  keychain: KeychainStore;
}

/**
 * 金鑰解析與惰性遷移。獨立成純函式是為了讓測試能對著暫存目錄＋假 Keychain 驗證
 * 每一條分支，而不是在使用者真正的金鑰上做實驗。
 */
export function resolveVaultKey(deps: VaultKeyDeps): Buffer {
  const configured = deps.envKey?.trim();
  if (configured) return crypto.createHash("sha256").update(configured).digest();

  const fromKeychain = deps.keychain.get();
  const fileState = readKeyFile(deps.keyFile);
  if (fileState.state === "corrupt") {
    // 金鑰檔在但格式不對：這台機器曾有金鑰。絕不能走「全新安裝」重生一把——
    // 大聲停下來,原始金鑰或許還救得回來(備份、Keychain、密碼管理器)。
    if (fromKeychain) {
      console.warn("[secretVault] 金鑰檔格式不正確,但 Keychain 有金鑰——用 Keychain 那把;金鑰檔請自行刪除或修復。");
      return fromKeychain;
    }
    throw new Error(
      "本機帳密保管金鑰格式不正確(data/.secret-vault-key 內容不是合法的金鑰)。"
      + "**不會**自動產生新金鑰——那會讓已保存的所有帳密永遠解不開。"
      + "若你有用 npm run key:export 匯出過金鑰,用 npm run key:import 放回來;或從備份還原這個檔案。",
    );
  }
  const fromFile = fileState.state === "ok" ? fileState.key : null;

  if (fromKeychain && fromFile) {
    if (fromKeychain.equals(fromFile)) {
      // 遷移的收尾：兩邊一致，檔案可以功成身退
      try {
        fs.rmSync(deps.keyFile, { force: true });
        privateWriteMarker(deps.markerFile);
      } catch { /* 刪不掉就下次再刪；金鑰本身沒問題 */ }
      return fromKeychain;
    }
    // 兩邊不一致(例如從別台機器把 data/ 整包搬過來)：密文就睡在金鑰檔旁邊,
    // 用檔案那把才解得開。不動任何一邊,留給使用者處理。
    console.warn("[secretVault] Keychain 與 data/.secret-vault-key 的金鑰不一致，先用檔案裡那把(它跟資料是一起搬來的)。");
    return fromFile;
  }
  if (fromKeychain) return fromKeychain;

  if (fromFile) {
    // 惰性遷移：搬進 Keychain，讀回驗證一致才刪檔
    if (deps.keychain.set(fromFile)) {
      const readBack = deps.keychain.get();
      if (readBack && readBack.equals(fromFile)) {
        try {
          fs.rmSync(deps.keyFile, { force: true });
          privateWriteMarker(deps.markerFile);
        } catch { /* 同上 */ }
      }
    }
    return fromFile;
  }

  if (fs.existsSync(deps.markerFile)) {
    throw new Error(
      "帳密保管金鑰應該在 macOS Keychain 裡(服務名稱 agent-hub-secret-vault)，但現在讀不到。"
      + "多半是 Keychain 被鎖住或該筆被刪除。**不會**自動產生新金鑰——那會讓已保存的所有帳密永遠解不開。"
      + "如果你有用 npm run key:export 匯出過金鑰，用 npm run key:import 放回來即可。",
    );
  }

  // 全新安裝：先試 Keychain，寫得進去(且讀得回來)就不落地檔案
  const generated = crypto.randomBytes(32);
  if (deps.keychain.set(generated)) {
    const readBack = deps.keychain.get();
    if (readBack && readBack.equals(generated)) {
      privateWriteMarker(deps.markerFile);
      return generated;
    }
  }
  // 退路：非 macOS 或 Keychain 不可用 → 跟以前一樣用檔案
  try {
    privateWrite(deps.keyFile, generated.toString("base64"));
    return generated;
  } catch {
    // 兩個本機進程同時初始化：晚到的直接讀先到的那份
    const stored = readKeyFile(deps.keyFile);
    if (stored.state !== "ok") throw new Error("本機帳密保管金鑰格式不正確");
    return stored.key;
  }
}

function privateWriteMarker(markerFile: string) {
  try {
    fs.rmSync(markerFile, { force: true });
    privateWrite(markerFile, "keychain");
  } catch { /* 標記寫不進去只影響「讀不到時的錯誤訊息品質」，不影響金鑰 */ }
}

function vaultKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = resolveVaultKey({
    envKey: process.env.AGENT_HUB_SECRET_KEY,
    keyFile: KEY_FILE,
    markerFile: LOCATION_MARKER,
    keychain: realKeychainStore(),
  });
  return cachedKey;
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

/* ── 二進位加密(備份包裡的登入狀態用) ─────────────────────────────
 * 備份 zip 過去把 browser-sessions/(等同已登入的 cookies)原封不動塞進去——備份一旦被
 * 拷去別的地方，登入狀態就跟著明文外流。這裡用同一把金鑰加密；還原本來就需要金鑰
 * 才能解 DB 裡的帳密，所以不增加任何額外的還原前置條件。 */

const BYTES_MAGIC = Buffer.from("AHENC1");

export function encryptBytes(data: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", vaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([BYTES_MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

/** 解不開(金鑰不對/內容毀損)回 null，呼叫端要把這個當成明確的失敗回報，不能靜默跳過。 */
export function decryptBytes(data: Buffer): Buffer | null {
  if (data.length < BYTES_MAGIC.length + 12 + 16 || !data.subarray(0, BYTES_MAGIC.length).equals(BYTES_MAGIC)) return null;
  try {
    const iv = data.subarray(BYTES_MAGIC.length, BYTES_MAGIC.length + 12);
    const tag = data.subarray(BYTES_MAGIC.length + 12, BYTES_MAGIC.length + 28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", vaultKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(BYTES_MAGIC.length + 28)), decipher.final()]);
  } catch {
    return null;
  }
}

export function isEncryptedBytes(data: Buffer): boolean {
  return data.length >= BYTES_MAGIC.length && data.subarray(0, BYTES_MAGIC.length).equals(BYTES_MAGIC);
}

/* ── 金鑰匯出/匯入(跨機還原的唯一正路) ───────────────────────────
 * 備份 zip 刻意**不**放金鑰：放了就回到「鎖和鑰匙綁在一起」。跨機還原 = 備份包(密文)
 * ＋這裡匯出的金鑰(另外保管)，兩樣分開帶。 */

export function exportVaultKeyBase64(): string {
  return vaultKey().toString("base64");
}

/** 這把金鑰是否真的在保護資料——secrets 表裡有沒有任何密文用它解得開。 */
function keyProtectsExistingData(key: Buffer): boolean {
  try {
    const rows = getDb().prepare(`SELECT value FROM secrets WHERE value LIKE ?`).all(`${PREFIX}%`) as { value: string }[];
    const apiKey = getDb().prepare(`SELECT value FROM settings WHERE key = 'apiKey'`).get() as { value: string } | undefined;
    if (apiKey?.value.startsWith(PREFIX)) rows.push(apiKey);
    return rows.some((row) => decryptWithKey(row.value, key).length > 0);
  } catch {
    return true; // DB 讀不到就往安全的方向假設(要 --force 才能換)
  }
}

function decryptWithKey(value: string, key: Buffer): string {
  if (!value.startsWith(PREFIX)) return "";
  const pieces = value.slice(PREFIX.length).split(":");
  if (pieces.length !== 3) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(pieces[0], "base64url"));
    decipher.setAuthTag(Buffer.from(pieces[1], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(pieces[2], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export function importVaultKeyBase64(base64: string, opts: { force?: boolean } = {}): void {
  const key = Buffer.from(base64.trim(), "base64");
  if (key.length !== 32) throw new Error("金鑰格式不正確：應該是 npm run key:export 印出來的那一整串");
  const kc = realKeychainStore();
  const fileState = readKeyFile(KEY_FILE);
  const existing = kc.get() ?? (fileState.state === "ok" ? fileState.key : null);
  // 新機器第一次啟動會自動產生一把金鑰,但那把還沒保護任何資料——這種情況直接換掉,
  // 不用 --force(code review 抓到:照文件走「新電腦先 key:import」會被自己剛產生的空金鑰卡死)。
  if (existing && !existing.equals(key) && !opts.force && keyProtectsExistingData(existing)) {
    throw new Error("這台機器已經有一把不同的金鑰,而且它保護著已保存的帳密。確定要換掉的話加 --force(換掉後用舊金鑰加密的資料會解不開)。");
  }
  if (kc.set(key) && kc.get()?.equals(key)) {
    privateWriteMarker(LOCATION_MARKER);
    fs.rmSync(KEY_FILE, { force: true });
  } else {
    fs.rmSync(KEY_FILE, { force: true });
    privateWrite(KEY_FILE, key.toString("base64"));
  }
  cachedKey = key;
}
