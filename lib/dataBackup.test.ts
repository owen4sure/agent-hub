import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { BACKUP_ENTRY, restoreDataBackup, writeBackupZip } from "./dataBackup";

/**
 * 備份還原演練。
 *
 * 為什麼一定要有這個測試(而不是只有 restore 函式)：稽核的原話是「未經演練的備份等於沒有備份」，
 * 這是災難復原稽核的標準結論。備份程式碼會被改、格式會漂移，而「還原不回來」這件事**只有在
 * 真的需要還原的那一天**才會發現——那天才發現就已經太晚了。所以這裡做完整的一輪：
 * 建立備份 → 把原始資料破壞掉 → 還原 → 逐項比對內容真的一致。
 *
 * 全程在暫存目錄裡，不碰專案的 data/。
 */

function makeSourceData(dir: string) {
  fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(dir, "browser-sessions"), { recursive: true });

  const dbFile = path.join(dir, "agent-hub.db");
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE workflows_meta (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
  `);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('baseUrl', 'https://example.invalid/v1')`).run();
  db.prepare(`INSERT INTO workflows_meta (id, name, status, updated_at) VALUES ('wf-drill', '演練用流程', 'draft', '2026-07-30T00:00:00Z')`).run();
  db.close();

  fs.writeFileSync(path.join(dir, "workflows", "wf-drill.json"), JSON.stringify({ id: "wf-drill", name: "演練用流程", nodes: [] }));
  fs.writeFileSync(
    path.join(dir, "browser-sessions", "wf-drill.json"),
    JSON.stringify({ cookies: [{ name: "session", value: "drill-cookie-value" }] }),
  );
  return dbFile;
}

test("備份還原演練：建立備份 → 破壞資料 → 還原 → 內容與還原前一致", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-drill-"));
  try {
    const dataDir = path.join(work, "data");
    const projectRoot = path.join(work, "project");
    fs.mkdirSync(projectRoot, { recursive: true });
    const dbFile = makeSourceData(dataDir);
    fs.writeFileSync(path.join(projectRoot, ".env"), "AGENT_HUB_API_KEY=from-backup\n");

    const zipFile = path.join(work, "backup.zip");
    writeBackupZip({
      dbFile,
      workflowDir: path.join(dataDir, "workflows"),
      sessionDir: path.join(dataDir, "browser-sessions"),
      envFile: path.join(projectRoot, ".env"),
    }, zipFile);
    assert.ok(fs.existsSync(zipFile), "備份檔要真的被寫出來");

    // 登入狀態(cookies)在備份包裡必須是密文——備份檔被拷去別處時不能等於登入外流
    const AdmZipCheck = (await import("adm-zip")).default;
    const zipRaw = new AdmZipCheck(zipFile);
    const sessionEntry = zipRaw.getEntries().find((e) => e.entryName.startsWith(`${BACKUP_ENTRY.sessionsEnc}/`));
    assert.ok(sessionEntry, "登入狀態要以加密形式進備份包");
    assert.equal(sessionEntry.getData().includes("drill-cookie-value"), false, "cookie 值不能以明文出現在備份包裡");
    assert.equal(
      zipRaw.getEntries().some((e) => e.entryName.startsWith(`${BACKUP_ENTRY.sessions}/`)),
      false,
      "不能同時留一份明文的登入狀態",
    );

    // 破壞：資料庫內容被清掉、流程 JSON 被刪掉，而且留下一份「舊的 WAL」——
    // 這正是手動還原最常踩的坑(忘了刪 -wal，SQLite 會把舊日誌套在還原後的檔案上)。
    const broken = new Database(dbFile);
    broken.exec(`DELETE FROM workflows_meta; DELETE FROM settings;`);
    broken.close();
    fs.writeFileSync(`${dbFile}-wal`, "stale-wal-content");
    fs.rmSync(path.join(dataDir, "workflows", "wf-drill.json"), { force: true });

    const result = restoreDataBackup(zipFile, { dataDir, projectRoot });

    assert.equal(result.verified.integrity, "ok");
    assert.equal(result.verified.workflowRows, 1, "還原後流程紀錄要回來");
    assert.equal(result.verified.settingRows, 1, "還原後設定要回來");
    assert.ok(result.restored.includes(BACKUP_ENTRY.db));
    assert.ok(result.restored.includes(`${BACKUP_ENTRY.workflows}/`));

    // 資料真的讀得回來(不只是「檔案存在」)
    const restored = new Database(dbFile, { readonly: true });
    const wf = restored.prepare(`SELECT name FROM workflows_meta WHERE id='wf-drill'`).get() as { name: string } | undefined;
    const setting = restored.prepare(`SELECT value FROM settings WHERE key='baseUrl'`).get() as { value: string } | undefined;
    restored.close();
    assert.equal(wf?.name, "演練用流程");
    assert.equal(setting?.value, "https://example.invalid/v1");

    const json = JSON.parse(fs.readFileSync(path.join(dataDir, "workflows", "wf-drill.json"), "utf8")) as { id: string };
    assert.equal(json.id, "wf-drill");

    // 加密的登入狀態要解密放回原位、內容一致
    const session = JSON.parse(fs.readFileSync(path.join(dataDir, "browser-sessions", "wf-drill.json"), "utf8")) as
      { cookies: { value: string }[] };
    assert.equal(session.cookies[0]?.value, "drill-cookie-value", "還原後的登入狀態要跟備份前一致");

    // 舊的 WAL 不能留在原地(否則還原完的資料庫可能被舊日誌蓋掉)
    assert.equal(fs.existsSync(`${dbFile}-wal`), false, "舊的 -wal 要被移開");
    assert.ok(result.movedAside.some((name) => name.includes("-wal")), "被移開的舊檔要回報出來");

    // .env 絕不能直接覆蓋(現有的可能比備份新)
    assert.equal(result.envSavedAs, ".env.from-backup");
    assert.equal(fs.readFileSync(path.join(projectRoot, ".env"), "utf8").includes("from-backup"), true);
    assert.ok(fs.existsSync(path.join(projectRoot, ".env.from-backup")));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("備份裡的登入狀態解不開(金鑰不對/內容毀損)：要把「先 key:import」講清楚，不能靜默跳過", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-drill-"));
  try {
    const dataDir = path.join(work, "data");
    const dbFile = makeSourceData(dataDir);
    const zipFile = path.join(work, "backup.zip");
    writeBackupZip({ dbFile, sessionDir: path.join(dataDir, "browser-sessions") }, zipFile);

    // 模擬「換了機器、金鑰不同」：密文被這台機器的金鑰解不開 == 內容驗證失敗
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(zipFile);
    const entry = zip.getEntries().find((e) => e.entryName.startsWith(`${BACKUP_ENTRY.sessionsEnc}/`))!;
    const tampered = entry.getData();
    tampered[tampered.length - 1] ^= 0xff;
    zip.updateFile(entry.entryName, tampered);
    zip.writeZip(zipFile);

    assert.throws(
      () => restoreDataBackup(zipFile, { dataDir: path.join(work, "restore-to"), projectRoot: work }),
      /key:import/,
      "錯誤訊息要直接給下一步指令",
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("備份還原：不是 Agent Hub 備份的 zip 要老實拒絕，而不是還原出半套資料", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-drill-"));
  try {
    const dataDir = path.join(work, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const other = path.join(work, "not-a-backup.zip");
    // 借用同一支打包函式做出「缺少資料庫」的 zip：拿一個純文字檔當 db 來源不行(格式檢查會過)，
    // 所以直接自己寫一個只有別的檔案的 zip。
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip();
    zip.addFile("readme.txt", Buffer.from("hello"));
    zip.writeZip(other);

    assert.throws(() => restoreDataBackup(other, { dataDir, projectRoot: work }), /不是 Agent Hub 的備份包/);
    assert.equal(fs.existsSync(path.join(dataDir, "agent-hub.db")), false, "拒絕的情況不能留下任何半套檔案");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
