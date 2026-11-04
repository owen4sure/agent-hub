import { execFileSync } from "node:child_process";

/**
 * macOS Keychain 存取(帳密保管金鑰專用)。
 *
 * 為什麼：金鑰檔 `.secret-vault-key` 跟密文(SQLite)住在同一個 data/ 目錄——
 * 誰能整包拷走 data/，誰就同時拿到鎖和鑰匙，加密等於沒加。搬進 Keychain 之後，
 * 離線拷走磁碟拿到的只有密文；金鑰要登入這個 mac 使用者的工作階段才讀得到。
 *
 * 用 /usr/bin/security 而不是原生綁定：零相依、而且 launchd 使用者代理跑在同一個
 * Aqua 工作階段裡，login keychain 已解鎖，非互動讀取不會跳授權視窗(建立與讀取
 * 都經由同一個 security 執行檔，ACL 信任它)。
 */

const SERVICE = "agent-hub-secret-vault";
const ACCOUNT = "vault-key";

export interface KeychainStore {
  get(): Buffer | null;
  set(key: Buffer): boolean;
}

export function keychainGet(service = SERVICE, account = ACCOUNT): Buffer | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const decoded = Buffer.from(out, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null; // 沒這筆、keychain 鎖住、或非 macOS——呼叫端自己決定退路
  }
}

export function keychainSet(key: Buffer, service = SERVICE, account = ACCOUNT): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync(
      "/usr/bin/security",
      [
        "add-generic-password", "-s", service, "-a", account,
        "-w", key.toString("base64"),
        "-U", // 已存在就更新,不要因為重跑而失敗
        "-j", "Agent Hub 帳密保管金鑰。刪掉這筆會讓平台裡保存的所有帳密無法解讀。",
      ],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

/** 測試清理用；正式碼沒有任何路徑會刪金鑰。 */
export function keychainDelete(service = SERVICE, account = ACCOUNT): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account], { stdio: "ignore" });
  } catch { /* 本來就不存在 */ }
}

export function realKeychainStore(): KeychainStore {
  return { get: () => keychainGet(), set: (key) => keychainSet(key) };
}
