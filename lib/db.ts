import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "agent-hub.db");

declare global {
  var __agentHubDb: Database.Database | undefined;
}

// 不把金鑰寫死在程式碼裡(開源會外洩)。從環境變數讀，沒有就留空、由使用者在設定頁填。
export const DEFAULT_BASE_URL = process.env.AGENT_HUB_BASE_URL ?? "https://api.openai.com/v1";
export const DEFAULT_API_KEY = process.env.AGENT_HUB_API_KEY ?? "";
export { DEFAULT_MODEL, MODELS } from "./models";

function init(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  // WAL 允許多讀單寫，但寫鎖競爭時 better-sqlite3 預設是「立刻拋 SQLITE_BUSY」而不是等一下。
  // 本專案實際存在多進程同用一顆 DB 的情境(daemon 常駐 npm start + 使用者又開 npm run dev)，
  // 引擎密集寫 run_logs 的同時 scheduler 要搶 last_fired_minute，沒有等待就會互相炸 BUSY——
  // 排程那筆被 catch 吞掉的結果是「那一分鐘的排程靜默漏跑」。給 5 秒等待足以化解幾乎所有競爭。
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflows_meta (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wf_model (
      workflow_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS secrets (
      workflow_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (workflow_id, key)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      headed INTEGER NOT NULL DEFAULT 0,
      trigger_params_json TEXT,
      error TEXT,
      reason TEXT,
      resolution TEXT,
      failed_node TEXT,
      owner_pid INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_wf ON runs(workflow_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS node_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT,
      output_json TEXT,
      error TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_node_runs ON node_runs(run_id);

    CREATE TABLE IF NOT EXISTS run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      node_id TEXT,
      ts TEXT NOT NULL,
      line TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id);

    CREATE TABLE IF NOT EXISTS run_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      path TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_files_wf ON run_files(workflow_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      cron TEXT NOT NULL,
      params_json TEXT,
      last_fired_minute TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_wf ON schedules(workflow_id);

    CREATE TABLE IF NOT EXISTS learned_fixes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_type TEXT NOT NULL,
      error_signature TEXT NOT NULL,
      error_sample TEXT,
      before_json TEXT,
      after_json TEXT,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learned_fixes ON learned_fixes(node_type);

    -- 正式流程排程失敗時，AI 在背景想好的修法提案(不自動套用，等使用者一鍵確認)
    CREATE TABLE IF NOT EXISTS fix_proposals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_label TEXT NOT NULL,
      error TEXT,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fix_proposals_wf ON fix_proposals(workflow_id, status);

    -- 資料夾監聽觸發的「已處理檔案」記錄：同一顆資料目錄可能有多個進程(daemon+dev)同時掃描，
    -- 用 PRIMARY KEY + INSERT OR IGNORE 當原子搶佔鎖，誰先插入成功誰觸發，不會重複跑同一個檔案。
    CREATE TABLE IF NOT EXISTS watch_seen (
      workflow_id TEXT NOT NULL,
      file_key TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (workflow_id, file_key)
    );

    -- 等人簽核：流程跑到簽核節點會暫停(run 標 waiting)並建一筆 pending 簽核，
    -- 簽核人透過 /approve/<token> 網頁或 Telegram 內建按鈕決定，決定後流程從簽核節點續跑。
    -- token 是簽核連結的認證(跟 webhook token 同一套思路：拿到連結=有權簽核)。
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      decision_note TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, expires_at);
  `);

  // 無痛升級：schema 有變動時對既有 DB 補欄位，永遠不需要刪 DB(才不會弄丟已存的帳密/設定)。
  // 注意 CREATE TABLE IF NOT EXISTS 對「已存在的表」是 no-op、不會補欄位——所以「初版之後才加進
  // 既有表」的每一個欄位都必須在這裡列一次，否則拿舊 DB 跑新程式就缺欄位。
  // 曾差點踩到的實例：舊 DB 的 schedules 沒有 last_fired_minute，tick 的 UPDATE 每分鐘拋
  // no such column 又被 catch 吞掉 → 所有排程「看起來有開」實際永遠不觸發。
  // (NOT NULL 欄位補進舊表時必須帶 DEFAULT，不然 ALTER TABLE 會失敗)
  addColumnIfMissing(db, "runs", "reason", "reason TEXT");
  addColumnIfMissing(db, "runs", "resolution", "resolution TEXT");
  addColumnIfMissing(db, "runs", "failed_node", "failed_node TEXT");
  addColumnIfMissing(db, "runs", "trigger_type", "trigger_type TEXT NOT NULL DEFAULT 'manual'");
  addColumnIfMissing(db, "runs", "headed", "headed INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "runs", "trigger_params_json", "trigger_params_json TEXT");
  addColumnIfMissing(db, "runs", "owner_pid", "owner_pid INTEGER");
  addColumnIfMissing(db, "node_runs", "attempt", "attempt INTEGER NOT NULL DEFAULT 1");
  // 分支節點(if/switch)這次選了哪個出口——「從失敗那步續跑」要重放上次的分支選擇，下游跳過邏輯才會一致
  addColumnIfMissing(db, "node_runs", "active_ports", "active_ports TEXT");
  addColumnIfMissing(db, "schedules", "last_fired_minute", "last_fired_minute TEXT");
  addColumnIfMissing(db, "schedules", "next_run_at", "next_run_at TEXT");
  addColumnIfMissing(db, "schedules", "params_json", "params_json TEXT");
  // Webhook 觸發用的秘密 token(每條流程一個)：URL 路徑就是認證，沒有 token 的人打不動
  addColumnIfMissing(db, "workflows_meta", "webhook_token", "webhook_token TEXT");

  // 帳密改成全域共用(依 key)：把舊的「每個 workflow 各存一份」搬進共用區 __shared__，
  // 使用者已填過的帳密不會不見。已有共用值就不覆蓋(第一筆為準)，搬完刪掉舊的各別列。冪等。
  const hasOld = db.prepare(`SELECT 1 FROM secrets WHERE workflow_id != '__shared__' LIMIT 1`).get();
  if (hasOld) {
    db.exec(`
      INSERT OR IGNORE INTO secrets (workflow_id, key, value)
        SELECT '__shared__', key, value FROM secrets WHERE workflow_id != '__shared__';
      DELETE FROM secrets WHERE workflow_id != '__shared__';
    `);
  }

  const seed = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  seed.run("baseUrl", DEFAULT_BASE_URL);
  seed.run("apiKey", DEFAULT_API_KEY);

  return db;
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function getDb(): Database.Database {
  if (!global.__agentHubDb) {
    global.__agentHubDb = init();
  }
  return global.__agentHubDb;
}
