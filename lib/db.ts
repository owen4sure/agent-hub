import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export const DATA_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
// data/ 內有明碼帳密、執行輸入輸出與除錯截圖。預設 mkdir/SQLite 會受 umask 影響，
// 常見結果是 0755/0644，讓同一台電腦的其他 OS 帳號也能讀。這是本機工具仍必須守住的隔離邊界。
// Windows 沒有相同的 POSIX mode 語意；chmod 失敗也不能讓整個產品無法開機，所以 best-effort。
function chmodPrivate(file: string, mode: number) {
  if (process.platform === "win32" || !fs.existsSync(file)) return;
  try { fs.chmodSync(file, mode); } catch { /* doctor 會把仍不安全的權限明確報出來 */ }
}
chmodPrivate(DATA_DIR, 0o700);

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
  // journal_mode=WAL 可能建立 -wal/-shm；三個檔案都含使用者資料，全部收緊。
  chmodPrivate(DB_PATH, 0o600);
  chmodPrivate(`${DB_PATH}-wal`, 0o600);
  chmodPrivate(`${DB_PATH}-shm`, 0o600);

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
      secret_overrides_json TEXT,
      node_config_overrides_json TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
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
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'output'
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

    -- 無人值守觸發(排程/監聽/webhook)的正式流程失敗，若原因被判定為「外部服務暫時性問題」
    -- (例如免費視覺模型當下無回應)，不是邏輯/帳密問題，AI 改設定也沒用，重跑同一份設定
    -- 很可能就直接成功——排一個延後自動重跑，而不是靜靜停在那裡等使用者自己想到要手動重試。
    CREATE TABLE IF NOT EXISTS pending_retries (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      trigger_params_json TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      retry_at TEXT NOT NULL,
      original_trigger TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_retries_due ON pending_retries(retry_at);

    -- 讓 AI 修(autofix)／自動測試(autorun)迴圈在「改節點設定→重跑驗證→決定保留或還原」這整個過程
    -- 可能橫跨好幾輪、幾十秒到幾分鐘；迴圈自己只在正常結束(成功/失敗/使用者取消/逾時)時才會呼叫
    -- restoreUnverified() 把沒驗證過的改動還原。若承載這個迴圈的進程中途死掉(部署重啟/crash/被殺)，
    -- 這段清理來不及跑，未驗證的節點改動就會半吊子永久留在流程上，事後完全看不出那是暫時改動
    -- (真實踩過的事故：一次「讓AI修」中途被服務重啟打斷，事後不確定當時節點內容是不是已驗證過的版本)。
    -- 這張表存「迴圈開始前的完整快照」，迴圈乾淨結束(不管哪種結局)都會刪掉這筆自己的紀錄；
    -- 只有「進程真的死了」才會留下孤兒列，交給下次啟動時的 recoverCrashedRepairs() 拿快照整個還原，
    -- 跟 runs.owner_pid 的崩潰復原(recoverCrashedRuns)是同一個道理，只是保護的是「迴圈中的節點改動」。
    CREATE TABLE IF NOT EXISTS repair_sessions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      before_json TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repair_sessions_wf ON repair_sessions(workflow_id, started_at);

    -- 寫入/發送類節點(google-sheet-append、send-email、telegram/line/slack-notify)標成 retryable：
    -- 引擎逾時或暫時性錯誤會整個節點重跑。問題是「重跑」跟「這次真的沒送到」是兩件不一定相同的事——
    -- 遠端有可能其實已經處理成功，只是我們這邊等回應逾時，重跑就會寄兩次信、多寫一列、發兩次通知。
    -- 這張表記錄「(這次執行, 這個節點)這個邏輯動作目前的狀態」，key 是 runId:nodeId(repeat-steps
    -- 內嵌步驟的 nodeId 本身已經帶迭代序號，天然唯一，不用額外處理)。status 見 lib/workflow/idempotency.ts
    -- 的說明：'pending'=已經要發起外部呼叫但結果還不確定(此時不自動重試,交給人判斷)；
    -- 'completed'=確定成功，重跑直接沿用記錄的輸出，不會重複產生外部副作用。
    CREATE TABLE IF NOT EXISTS idempotent_actions (
      key TEXT PRIMARY KEY,
      output_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_idempotent_actions_created ON idempotent_actions(created_at);
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
  addColumnIfMissing(db, "runs", "secret_overrides_json", "secret_overrides_json TEXT");
  addColumnIfMissing(db, "runs", "node_config_overrides_json", "node_config_overrides_json TEXT");
  // 安全試跑失敗後若從原處續跑，必須沿用「只讀」身分。沒存這欄會讓續跑的下游寫入步驟變正式執行。
  addColumnIfMissing(db, "runs", "dry_run", "dry_run INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "runs", "owner_pid", "owner_pid INTEGER");
  // 部分執行(從這步開始測/只測這幾步)挑「可沿用種子」的舊 run 時，必須核對圖版本——沒有這欄就只能
  // 盲挑「最近一次成功過的 run」，可能把已經改過設定/日期區間的舊邏輯結果，靜默當成今天的資料沿用。
  addColumnIfMissing(db, "runs", "graph_fingerprint", "graph_fingerprint TEXT");
  // 正式流程無人值守失敗的背景修法提案改用整圖感知修復(aiRepairGraph)後，真正原因可能在別的節點
  // (不只是失敗回報的那個)——這欄存「除了主要那格以外，還一併要改的節點」，套用提案時一起套。
  addColumnIfMissing(db, "fix_proposals", "extra_edits_json", "extra_edits_json TEXT");
  addColumnIfMissing(db, "node_runs", "attempt", "attempt INTEGER NOT NULL DEFAULT 1");
  // 分支節點(if/switch)這次選了哪個出口——「從失敗那步續跑」要重放上次的分支選擇，下游跳過邏輯才會一致
  addColumnIfMissing(db, "node_runs", "active_ports", "active_ports TEXT");
  addColumnIfMissing(db, "schedules", "last_fired_minute", "last_fired_minute TEXT");
  addColumnIfMissing(db, "schedules", "next_run_at", "next_run_at TEXT");
  addColumnIfMissing(db, "schedules", "params_json", "params_json TEXT");
  // 失敗自動重跑排的這筆記錄，原本是從哪個 run 失敗才排的——有這個才能到期時優先「續跑」那個
  // run(沿用失敗前已成功步驟的結果，不會讓已經寫入/寄出的副作用重演一次)，沒有的話只能整條
  // 從頭重跑。舊資料沒有這欄(NULL)一律退回從頭重跑，行為跟改動前一樣，不會出錯。
  addColumnIfMissing(db, "pending_retries", "run_id", "run_id TEXT");
  // idempotent_actions 原本只記「確定完成」——真實踩過的漏洞(code review 抓到)：這樣完全防不住
  // 「外部呼叫已經送出、但因為逾時而拋錯」這個最常見的觸發路徑，下一次重試照樣查不到紀錄、照樣
  // 真的送第二次。補上 pending 狀態：舊資料(這個功能剛推出時的既有紀錄，都是「確定完成」的動作)
  // 用 DEFAULT 'completed' 補齊，行為完全不變；新紀錄才會用到 'pending'。
  addColumnIfMissing(db, "idempotent_actions", "status", "status TEXT NOT NULL DEFAULT 'completed'");
  // Webhook 觸發用的秘密 token(每條流程一個)：URL 路徑就是認證，沒有 token 的人打不動
  addColumnIfMissing(db, "workflows_meta", "webhook_token", "webhook_token TEXT");
  // LINE 訊息觸發的 webhook token(每條流程一個)——跟一般 webhook 分開，各自啟用/停用
  addColumnIfMissing(db, "workflows_meta", "line_token", "line_token TEXT");
  // 檔案分兩種：'output'=給使用者的交付產出、'intermediate'=抓進來給下游/AI 對話用的中間檔
  // (下載的信件附件、解壓出的檔案)。中間檔照樣登記(生命週期跟著 run、對話還讀得到)，
  // 只是「產出檔案」頁不列出來——使用者只想看到真正的成品。
  addColumnIfMissing(db, "run_files", "kind", "kind TEXT NOT NULL DEFAULT 'output'");

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
