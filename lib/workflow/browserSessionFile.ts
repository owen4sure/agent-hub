import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserContextOptions } from "playwright";

/**
 * 讀寫 Playwright storageState(登入 cookies)的通用邏輯——`data/browser-sessions/*.json` 這份
 * 格式被三個地方共用(正式執行的 engine.ts、手動登入 manualLogin.ts、續命背景工作
 * webmailKeepAlive.ts)。原本三邊各自維護一份幾乎一模一樣的原子寫入邏輯(mkdir 0700 + 暫存檔用
 * pid+隨機值命名 + rename + chmod 0600、讀檔驗證 cookies/origins 陣列)，2026-08 code review
 * 抓到：這種重複遲早會有一邊修了 bug(例如寫入時的 race condition)、另外兩邊忘記跟著改，
 * 抽成這裡的單一函式，三邊都改成呼叫它，之後只要改一處。
 *
 * 刻意只收「怎麼讀寫一份已知路徑的檔案」，不收「這個路徑該怎麼算出來」——三邊算路徑的規則不同
 * (依 workflowId、依共用代號、或兩者擇一)，硬塞進來只會讓這個共用函式背上不屬於它的職責。
 */

export function loadSessionState(filePath: string): BrowserContextOptions["storageState"] | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { cookies?: unknown; origins?: unknown };
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) return undefined;
    return parsed as BrowserContextOptions["storageState"];
  } catch {
    return undefined;
  }
}

export function saveSessionState(filePath: string, state: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  const temp = `${filePath}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
