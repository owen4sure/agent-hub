import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import { DATA_DIR, getDb } from "./db";

const BACKUP_DIR = path.join(DATA_DIR, "backups");
const WORKFLOW_DIR = path.join(DATA_DIR, "workflows");
const BROWSER_SESSION_DIR = path.join(DATA_DIR, "browser-sessions");
const MAX_BACKUPS = 14;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

declare global {
  var __agentHubBackupTimer: ReturnType<typeof setInterval> | undefined;
}

function taipeiDay(): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function chmodPrivate(file: string, mode: number) {
  if (process.platform === "win32" || !fs.existsSync(file)) return;
  try { fs.chmodSync(file, mode); } catch { /* /api/health 會把備份失敗顯示出來 */ }
}

/**
 * 每日可還原快照：SQLite 用官方 online backup 取得一致狀態，再連同 workflow JSON／版本與 .env
 * 打包。備份含帳密，目錄 0700、檔案 0600，只保留最近 14 份。
 */
export async function createDailyDataBackup(): Promise<string> {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  chmodPrivate(BACKUP_DIR, 0o700);
  const target = path.join(BACKUP_DIR, `agent-hub-${taipeiDay()}.zip`);
  if (fs.existsSync(target)) return target;

  const token = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const tempDb = path.join(BACKUP_DIR, `.backup-${token}.db`);
  const tempZip = path.join(BACKUP_DIR, `.backup-${token}.zip`);
  try {
    await getDb().backup(tempDb);
    chmodPrivate(tempDb, 0o600);
    const zip = new AdmZip();
    zip.addLocalFile(tempDb, "", "agent-hub.db");
    if (fs.existsSync(WORKFLOW_DIR)) zip.addLocalFolder(WORKFLOW_DIR, "workflows");
    if (fs.existsSync(BROWSER_SESSION_DIR)) zip.addLocalFolder(BROWSER_SESSION_DIR, "browser-sessions");
    const envFile = path.join(/* turbopackIgnore: true */ process.cwd(), ".env");
    if (fs.existsSync(envFile)) zip.addLocalFile(envFile, "", ".env");
    zip.addFile("RESTORE.txt", Buffer.from(
      "此備份含 Agent Hub 的流程、版本、設定、帳密與已保存的網站登入狀態。還原前先停止 Agent Hub，再把 agent-hub.db、workflows/ 與 browser-sessions/ 放回 data/；.env 放回專案根目錄。\n",
      "utf8",
    ));
    zip.writeZip(tempZip);
    chmodPrivate(tempZip, 0o600);
    // 多進程同時產生同一天備份也沒關係：內容都是一致快照，最後一個原子 rename 覆蓋即可。
    fs.renameSync(tempZip, target);
    chmodPrivate(target, 0o600);

    const backups = fs.readdirSync(BACKUP_DIR)
      .filter((name) => /^agent-hub-\d{4}-\d{2}-\d{2}\.zip$/.test(name))
      .sort()
      .reverse();
    for (const old of backups.slice(MAX_BACKUPS)) fs.rmSync(path.join(BACKUP_DIR, old), { force: true });
    return target;
  } finally {
    fs.rmSync(tempDb, { force: true });
    fs.rmSync(tempZip, { force: true });
  }
}

/** 啟動時先備份一次，長期常駐時每 6 小時檢查是否跨日；重複呼叫不會開第二個 timer。 */
export async function startDataBackups(): Promise<void> {
  await createDailyDataBackup();
  if (global.__agentHubBackupTimer) return;
  global.__agentHubBackupTimer = setInterval(() => {
    void createDailyDataBackup().catch((error) => console.error("[backup] 每日備份失敗:", error));
  }, CHECK_INTERVAL_MS);
  global.__agentHubBackupTimer.unref?.();
}

export function latestDataBackup(): { file: string; createdAt: string } | null {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR).filter((name) => /^agent-hub-\d{4}-\d{2}-\d{2}\.zip$/.test(name)).sort();
  const name = files.at(-1);
  if (!name) return null;
  const stat = fs.statSync(path.join(BACKUP_DIR, name));
  return { file: name, createdAt: stat.mtime.toISOString() };
}
