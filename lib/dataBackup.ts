import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import { DATA_DIR, getDb } from "./db";
import { decryptBytes, encryptBytes } from "./secretVault";
import { getSetting } from "./settingsStore";

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

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

/** 備份包裡的固定版面。建立與還原共用這一份定義，兩邊才不會各自漂移(格式不合的備份還原不回來)。 */
export const BACKUP_ENTRY = {
  db: "agent-hub.db",
  workflows: "workflows",
  sessions: "browser-sessions",
  /** 2026-08 起登入狀態(cookies)改加密後才進備份包；舊名稱保留是為了還原舊備份。 */
  sessionsEnc: "browser-sessions.enc",
  env: ".env",
} as const;

/**
 * 把指定的來源檔案打包成一個備份 zip。
 *
 * 刻意接受「明確的路徑」而不是直接讀模組層常數：這樣自動化的還原演練測試才能對著暫存目錄
 * 產生**跟正式備份完全同一個格式**的備份包(格式若靠測試自己另外拼一份，兩邊遲早漂移，
 * 而漂移的結果正是「備份看起來有、真的要還原時打不開」)。
 */
export function writeBackupZip(
  src: { dbFile: string; workflowDir?: string; sessionDir?: string; envFile?: string },
  target: string,
): void {
  const zip = new AdmZip();
  zip.addLocalFile(src.dbFile, "", BACKUP_ENTRY.db);
  if (src.workflowDir && fs.existsSync(src.workflowDir)) zip.addLocalFolder(src.workflowDir, BACKUP_ENTRY.workflows);
  // 登入狀態(cookies)等同帳密，加密後才進包——備份檔被拷去別的地方時，拿到的只有密文。
  // 解密用的金鑰跟 DB 帳密同一把，還原本來就需要它，所以不增加還原的前置條件。
  if (src.sessionDir && fs.existsSync(src.sessionDir)) {
    for (const file of walkFiles(src.sessionDir)) {
      const relative = path.relative(src.sessionDir, file).split(path.sep).join("/");
      zip.addFile(`${BACKUP_ENTRY.sessionsEnc}/${relative}`, encryptBytes(fs.readFileSync(file)));
    }
  }
  if (src.envFile && fs.existsSync(src.envFile)) zip.addLocalFile(src.envFile, "", BACKUP_ENTRY.env);
  zip.addFile("RESTORE.txt", Buffer.from(
    "此備份含 Agent Hub 的流程、版本、設定、帳密(加密)與網站登入狀態(加密)。\n"
    + "還原方式(建議)：先停止 Agent Hub，再執行 npm run restore:backup -- <這個檔案的路徑>。\n"
    + "換了一台電腦？帳密與登入狀態要靠金鑰才解得開：先在舊電腦執行 npm run key:export 把金鑰\n"
    + "抄下來(存進密碼管理器)，新電腦上先 npm run key:import -- <金鑰> 再還原。\n"
    + "手動還原：把 agent-hub.db 與 workflows/ 放回 data/(記得同時刪掉舊的 agent-hub.db-wal 與\n"
    + "agent-hub.db-shm，否則舊的日誌檔會蓋掉剛還原的資料庫內容)；browser-sessions.enc/ 是加密\n"
    + "內容，手動放回去沒有用，要用 npm run restore:backup 才會解密。.env 放回專案根目錄。\n",
    "utf8",
  ));
  zip.writeZip(target);
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
    writeBackupZip({
      dbFile: tempDb,
      workflowDir: WORKFLOW_DIR,
      sessionDir: BROWSER_SESSION_DIR,
      envFile: path.join(/* turbopackIgnore: true */ process.cwd(), ".env"),
    }, tempZip);
    chmodPrivate(tempZip, 0o600);
    // 多進程同時產生同一天備份也沒關係：內容都是一致快照，最後一個原子 rename 覆蓋即可。
    fs.renameSync(tempZip, target);
    chmodPrivate(target, 0o600);
    mirrorBackup(target);

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

/**
 * 把當日備份多抄一份到使用者指定的第二個地方(設定 key：backupMirrorDir，例如外接硬碟或
 * iCloud 資料夾)。沒設定就安靜跳過。
 *
 * 為什麼：data/backups/ 跟正本在同一顆硬碟上——硬碟一死，資料跟 14 天的備份一起消失，
 * 那不是備份，只是副本。抄寫失敗(外接碟沒插)只記 log 不讓每日備份失敗：本機那份仍然要成功。
 */
function mirrorBackup(zipFile: string): void {
  let mirrorDir: string | null = null;
  try {
    mirrorDir = getSetting("backupMirrorDir")?.trim() || null;
  } catch { /* DB 還沒好(極早期啟動)：這一輪先不抄 */ }
  if (!mirrorDir) return;
  try {
    fs.mkdirSync(mirrorDir, { recursive: true });
    fs.copyFileSync(zipFile, path.join(mirrorDir, path.basename(zipFile)));
    const mirrored = fs.readdirSync(mirrorDir)
      .filter((name) => /^agent-hub-\d{4}-\d{2}-\d{2}\.zip$/.test(name))
      .sort()
      .reverse();
    for (const old of mirrored.slice(MAX_BACKUPS)) fs.rmSync(path.join(mirrorDir, old), { force: true });
  } catch (err) {
    console.error(`[backup] 第二份備份抄不進 ${mirrorDir}(外接碟沒插？)：${err instanceof Error ? err.message : err}`);
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

export interface RestoreResult {
  /** 這次真的放回去的東西 */
  restored: string[];
  /** 原本存在、被改名保留下來的舊檔(不刪除，還原錯了還救得回來) */
  movedAside: string[];
  /** 還原後對資料庫做的驗證結果 */
  verified: { integrity: string; workflowRows: number; settingRows: number };
  /** .env 沒有直接覆蓋，另存成這個檔名(值可能比備份新，不能無聲蓋掉) */
  envSavedAs?: string;
}

/**
 * 從備份 zip 還原。
 *
 * 為什麼一定要有這個函式(稽核指出的 P1)：原本只有「建立備份」，還原全靠 RESTORE.txt 的
 * 手動說明。**未經演練的備份等於沒有備份**——而且手動還原有一個幾乎所有人都會踩的坑：
 * 只把 agent-hub.db 放回去、忘了刪掉舊的 `-wal`/`-shm`，SQLite 會把舊日誌套在新資料庫上，
 * 結果是「還原完看起來成功，資料卻是舊的或壞的」。這裡把那一步變成程式碼的一部分。
 *
 * 三個安全原則：
 * ①**不刪任何現有資料**：已存在的目標一律改名成 `<名稱>.before-restore-<時間>` 留著。
 * ②**還原後立刻驗證**：跑 PRAGMA integrity_check 並讀出關鍵表的列數，壞的話老實拋錯
 *   (此時舊資料還在，改名回去就救回來了)。
 * ③**.env 不覆蓋**：另存成 .env.from-backup。現在的 .env 可能有比備份更新的金鑰，
 *   靜默蓋掉會讓使用者的模型 API 突然失效卻找不到原因。
 */
export function restoreDataBackup(
  zipFile: string,
  opts: { dataDir?: string; projectRoot?: string } = {},
): RestoreResult {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const projectRoot = opts.projectRoot ?? path.join(/* turbopackIgnore: true */ process.cwd());
  if (!fs.existsSync(zipFile)) throw new Error(`找不到備份檔：${zipFile}`);

  const zip = new AdmZip(zipFile);
  const names = new Set(zip.getEntries().map((entry) => entry.entryName));
  if (![...names].some((name) => name === BACKUP_ENTRY.db)) {
    throw new Error(`這個檔案裡沒有 ${BACKUP_ENTRY.db}，不是 Agent Hub 的備份包`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const result: RestoreResult = { restored: [], movedAside: [], verified: { integrity: "", workflowRows: 0, settingRows: 0 } };

  const moveAside = (target: string) => {
    if (!fs.existsSync(target)) return;
    const kept = `${target}.before-restore-${stamp}`;
    fs.renameSync(target, kept);
    result.movedAside.push(path.basename(kept));
  };

  fs.mkdirSync(dataDir, { recursive: true });

  // ① 資料庫。舊的 -wal/-shm 一定要一起移開，否則 SQLite 會把舊日誌套用到還原後的檔案上。
  const dbTarget = path.join(dataDir, BACKUP_ENTRY.db);
  moveAside(dbTarget);
  moveAside(`${dbTarget}-wal`);
  moveAside(`${dbTarget}-shm`);
  zip.extractEntryTo(BACKUP_ENTRY.db, dataDir, false, true);
  chmodPrivate(dbTarget, 0o600);
  result.restored.push(BACKUP_ENTRY.db);

  // ② 流程 JSON 與已保存的登入狀態(有備到才還原)。登入狀態有兩種格式：
  //    舊備份是明文的 browser-sessions/，新備份是加密的 browser-sessions.enc/(還原時解密放回原名)。
  const sessionSources = [
    { prefix: BACKUP_ENTRY.workflows, target: BACKUP_ENTRY.workflows, encrypted: false },
    { prefix: BACKUP_ENTRY.sessions, target: BACKUP_ENTRY.sessions, encrypted: false },
    { prefix: BACKUP_ENTRY.sessionsEnc, target: BACKUP_ENTRY.sessions, encrypted: true },
  ] as const;
  for (const { prefix, target: targetName, encrypted } of sessionSources) {
    const hasFolder = [...names].some((name) => name.startsWith(`${prefix}/`));
    if (!hasFolder) continue;
    const target = path.join(dataDir, targetName);
    moveAside(target);
    fs.mkdirSync(target, { recursive: true });
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !entry.entryName.startsWith(`${prefix}/`)) continue;
      const relative = entry.entryName.slice(prefix.length + 1);
      // zip 內的路徑一律當成不可信：`../` 會寫到目錄外面(Zip Slip)。
      const dest = path.resolve(target, relative);
      if (dest !== target && !dest.startsWith(target + path.sep)) continue;
      let data = entry.getData();
      if (encrypted) {
        const opened = decryptBytes(data);
        if (!opened) {
          // 解不開幾乎都是金鑰不對(換機器沒先 key:import)。不能靜默跳過——
          // 「還原成功但登入全失效」的除錯成本遠高於在這裡直接把話說清楚。
          throw new Error(
            `備份裡的登入狀態(${entry.entryName})用這台機器的金鑰解不開。`
            + "如果是換了電腦：先在舊電腦 npm run key:export，在這台 npm run key:import -- <金鑰>，再還原一次。",
          );
        }
        data = opened;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      chmodPrivate(dest, 0o600);
    }
    result.restored.push(`${targetName}/`);
  }

  // ③ .env 只另存，不覆蓋。
  if (names.has(BACKUP_ENTRY.env)) {
    const savedAs = ".env.from-backup";
    fs.writeFileSync(path.join(projectRoot, savedAs), zip.getEntry(BACKUP_ENTRY.env)!.getData());
    result.envSavedAs = savedAs;
  }

  // ④ 驗證：還原完立刻確認這個資料庫真的打得開、內容是完整的。
  const verifyDb = new Database(dbTarget, { readonly: true });
  try {
    const integrity = verifyDb.pragma("integrity_check") as { integrity_check: string }[];
    result.verified.integrity = integrity[0]?.integrity_check ?? "unknown";
    if (result.verified.integrity !== "ok") throw new Error(`還原後的資料庫沒有通過完整性檢查：${result.verified.integrity}`);
    const table = (name: string) =>
      (verifyDb.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { n: number }).n > 0;
    if (!table("settings") || !table("workflows_meta")) throw new Error("還原後的資料庫缺少必要的表(settings / workflows_meta)");
    result.verified.workflowRows = (verifyDb.prepare(`SELECT COUNT(*) AS n FROM workflows_meta`).get() as { n: number }).n;
    result.verified.settingRows = (verifyDb.prepare(`SELECT COUNT(*) AS n FROM settings`).get() as { n: number }).n;
  } finally {
    verifyDb.close();
  }

  return result;
}

export function latestDataBackup(): { file: string; createdAt: string } | null {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR).filter((name) => /^agent-hub-\d{4}-\d{2}-\d{2}\.zip$/.test(name)).sort();
  const name = files.at(-1);
  if (!name) return null;
  const stat = fs.statSync(path.join(BACKUP_DIR, name));
  return { file: name, createdAt: stat.mtime.toISOString() };
}
