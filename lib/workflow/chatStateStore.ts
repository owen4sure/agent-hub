import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STORE_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), "data", "chat-state");
const MAX_BYTES = 1_000_000;

const ASSET_ID_RE = /^[a-f0-9-]{36}$/;

function validWorkflowId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}

function statePath(id: string): string {
  if (!validWorkflowId(id)) throw new Error("workflow id 格式不正確");
  return path.join(/* turbopackIgnore: true */ STORE_DIR, `${id}.json`);
}

export interface PersistedWorkflowChatState {
  chat: unknown[];
  pendingGraph: unknown | null;
  pendingExecution: unknown | null;
  /** 僅保存安全輸入卡的欄位定義；使用者實際輸入的帳密不在這份狀態裡。 */
  pendingInput?: unknown | null;
}

/**
 * macOS/iCloud 對同一份檔案的寫入衝突，會把後來那份重新命名成「id 2.json」「id 3.json」——
 * 這個資料夾本來就活在 iCloud 常同步的 Documents 底下，真的踩過。若正確檔名遺失，這份聊天紀錄
 * 就變成孤兒，getWorkflowChatState 只認 `${id}.json`，讀不到會讓使用者以為 AI 突然「失憶」，
 * 完全不知道原因(真實案例：wf-917a7777-copy-523d71-copy-4f9305 的聊天紀錄變成「...4f9305 2.json」，
 * 沒有對應的正常檔名，那條流程開啟時對話是空的)。id 只允許英數/底線/連字號(validWorkflowId)，
 * 不含正規表示式特殊字元，可以直接拼進 pattern 不用另外跳脫。
 */
function findDuplicateSuffixedState(id: string): string | null {
  // 目前唯一呼叫方(getWorkflowChatState)已經先靠 statePath()→validWorkflowId 擋過一次，這裡
  // 不會收到帶正規表示式特殊字元的 id；但這個函式本身不該假設呼叫順序，獨立驗證一次，
  // 避免以後有新呼叫方直接呼叫這支函式時，未經驗證的 id 被拼進 RegExp 建構式(code review 提醒)。
  if (!validWorkflowId(id)) return null;
  if (!fs.existsSync(STORE_DIR)) return null;
  const pattern = new RegExp(`^${id} \\d+\\.json$`);
  const candidates = fs.readdirSync(STORE_DIR).filter((name) => pattern.test(name));
  if (candidates.length === 0) return null;
  // 可能發生過不只一次重新命名衝突；用最後修改時間挑最新的那份，數字大小不保證是最新。
  candidates.sort((a, b) => fs.statSync(path.join(STORE_DIR, b)).mtimeMs - fs.statSync(path.join(STORE_DIR, a)).mtimeMs);
  return candidates[0];
}

export function getWorkflowChatState(id: string): PersistedWorkflowChatState | null {
  try {
    const target = statePath(id);
    let source = target;
    if (!fs.existsSync(/* turbopackIgnore: true */ target)) {
      const duplicate = findDuplicateSuffixedState(id);
      if (duplicate) source = path.join(/* turbopackIgnore: true */ STORE_DIR, duplicate);
    }
    const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ source, "utf8")) as PersistedWorkflowChatState;
    if (!Array.isArray(parsed.chat)) return null;
    // 從孤兒檔名救回來的話，順手改回正確檔名——下次直接命中正確路徑，也不會留著孤兒檔名讓人誤會壞掉。
    if (source !== target) {
      try { fs.renameSync(source, target); } catch { /* 改名失敗不影響這次已經讀到的結果 */ }
    }
    return { chat: parsed.chat, pendingGraph: parsed.pendingGraph ?? null, pendingExecution: parsed.pendingExecution ?? null, pendingInput: parsed.pendingInput ?? null };
  } catch {
    return null;
  }
}

export function saveWorkflowChatState(id: string, value: PersistedWorkflowChatState): void {
  if (!Array.isArray(value.chat) || value.chat.length > 100) throw new Error("對話紀錄格式不正確或超過 100 則");
  const raw = JSON.stringify({ chat: value.chat, pendingGraph: value.pendingGraph ?? null, pendingExecution: value.pendingExecution ?? null, pendingInput: value.pendingInput ?? null });
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("對話紀錄超過 1MB，請先清除不需要的舊對話");
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const target = statePath(id);
  const tmp = `${target}.${process.pid}-${randomUUID().slice(0, 6)}.tmp`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function deleteWorkflowChatState(id: string): void {
  if (!validWorkflowId(id)) return;
  fs.rmSync(statePath(id), { force: true });
}

/**
 * 已儲存的對話仍指著的附件不能因為剛好超過一般快取期限而失效。這裡只讀取聊天訊息裡的 assetId，
 * 不依賴瀏覽器 localStorage（使用者換瀏覽器／重整後它不可靠）。附件庫用這份集合決定哪些原檔要保留。
 */
export function referencedChatAttachmentIds(): Set<string> {
  const ids = new Set<string>();
  if (!fs.existsSync(STORE_DIR)) return ids;
  for (const filename of fs.readdirSync(STORE_DIR)) {
    if (!filename.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(STORE_DIR, filename), "utf8")) as PersistedWorkflowChatState;
      if (!Array.isArray(parsed.chat)) continue;
      for (const message of parsed.chat) {
        if (!message || typeof message !== "object") continue;
        const parts = (message as { parts?: unknown }).parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          const assetId = part && typeof part === "object" ? (part as { assetId?: unknown }).assetId : undefined;
          if (typeof assetId === "string" && ASSET_ID_RE.test(assetId)) ids.add(assetId);
        }
      }
    } catch {
      // 損壞的對話檔不能讓所有附件清理或讀取失效；正常流程仍照原本的 TTL 規則處理。
    }
  }
  return ids;
}
