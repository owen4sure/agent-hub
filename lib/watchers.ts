import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";
import { listWorkflows } from "./workflow/store";
import { startWorkflowRun } from "./workflow/engine";
import { resolveParams } from "./relativeDate";

/**
 * 資料夾監聽觸發：trigger 節點的 config.watchPath 填了資料夾路徑的「正式」流程，
 * 每 10 秒掃一次，有新檔案就用該檔案觸發一次執行(下游拿 {{filePath}}/{{fileName}})。
 *
 * 設計要點：
 * - 「已處理」記錄存 DB 的 watch_seen(PRIMARY KEY 搶佔)：多進程(daemon+dev)同掃同一資料夾也只觸發一次；
 *   重啟不會把處理過的檔案再跑一遍。
 * - 檔案穩定性：mtime 距現在 < 4 秒的檔案先不碰(可能還在被複製/下載中)，等下一輪。
 * - 首次啟用：資料夾裡「既有」的檔案全部靜默登記、不觸發——使用者要的是「之後丟進來的」，
 *   不是把歷史檔案全部補跑一輪(那可能是幾百次執行)。
 * - 只監聽「正式」流程：草稿還在邊改邊測，背景亂觸發只會添亂。
 */

const TICK_MS = 10_000;
const STABLE_MS = 4_000;

export interface WatchCandidate {
  name: string;
  mtimeMs: number;
  size: number;
  isFile: boolean;
}

/** 純函式：這個檔案現在該不該當成「新檔案」處理(給單元測試用) */
export function shouldProcessFile(f: WatchCandidate, pattern: string, now: number): boolean {
  if (!f.isFile) return false;
  if (f.name.startsWith(".")) return false; // .DS_Store / 隱藏檔
  if (f.name.endsWith(".crdownload") || f.name.endsWith(".download") || f.name.endsWith(".part") || f.name.endsWith(".tmp")) return false; // 下載中的暫存檔
  if (pattern && !f.name.toLowerCase().includes(pattern.toLowerCase())) return false;
  if (now - f.mtimeMs < STABLE_MS) return false; // 可能還在寫入
  return true;
}

/** 純函式：檔案的唯一鍵(名稱+大小+mtime)——同名檔案被更新(新的 mtime/size)會視為新事件再觸發一次 */
export function fileKey(f: { name: string; size: number; mtimeMs: number }): string {
  return `${f.name}:${f.size}:${Math.round(f.mtimeMs)}`;
}

function scanOnce() {
  const db = getDb();
  let workflows;
  try {
    workflows = listWorkflows();
  } catch (err) {
    console.error("[watchers] 讀取 workflow 清單失敗:", err);
    return;
  }
  for (const wf of workflows) {
    try {
      if (wf.status !== "official") continue;
      const trigger = wf.nodes.find((n) => n.type === "trigger");
      const watchPath = typeof trigger?.config.watchPath === "string" ? trigger.config.watchPath.trim() : "";
      if (!watchPath) continue;
      if (!fs.existsSync(watchPath) || !fs.statSync(watchPath).isDirectory()) continue;
      const pattern = typeof trigger?.config.watchPattern === "string" ? trigger.config.watchPattern.trim() : "";

      const entries = fs.readdirSync(watchPath);
      const now = Date.now();
      const candidates: { key: string; abs: string; name: string }[] = [];
      for (const name of entries) {
        const abs = path.join(watchPath, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue; // 掃到一半被刪掉
        }
        const cand: WatchCandidate = { name, mtimeMs: stat.mtimeMs, size: stat.size, isFile: stat.isFile() };
        if (!shouldProcessFile(cand, pattern, now)) continue;
        candidates.push({ key: fileKey(cand), abs, name });
      }
      // 首次啟用的判斷不能用「有沒有任何 seen 記錄」——空資料夾第一輪掃不到東西、什麼都不會登記，
      // 之後丟進來的第一個檔案就會被誤當「既有檔案」靜默吞掉(而「先建空收件匣再啟用」正是最常見用法)。
      // 改用「路徑綁定的哨兵記錄」標記初始化：也順便讓「換監聽路徑」重新走一次靜默登記，
      // 不會把新資料夾裡的歷史檔案全部補跑一輪。
      const sentinelKey = `#seeded#:${watchPath}`;
      const claim = db.prepare(`INSERT OR IGNORE INTO watch_seen (workflow_id, file_key, seen_at) VALUES (?, ?, datetime('now'))`);
      const seeded = db.prepare(`SELECT 1 FROM watch_seen WHERE workflow_id = ? AND file_key = ? LIMIT 1`).get(wf.id, sentinelKey);
      if (!seeded) {
        for (const c of candidates) claim.run(wf.id, c.key); // 既有檔案靜默登記，不觸發
        claim.run(wf.id, sentinelKey);
        continue;
      }
      if (candidates.length === 0) continue;

      for (const c of candidates) {
        const claimed = claim.run(wf.id, c.key).changes === 1;
        if (!claimed) continue; // 沒搶到 = 這一輪之前(或別的進程)已處理過這個檔案
        try {
          const params = resolveParams(wf.triggerParams ?? [], {}, new Date());
          startWorkflowRun(wf.id, { ...params, filePath: c.abs, fileName: c.name }, { trigger: "watch", headed: false });
          console.log(`[watchers] ${wf.name}: 偵測到新檔案「${c.name}」，已觸發執行`);
        } catch (err) {
          console.error(`[watchers] 觸發 ${wf.id} 失敗:`, err);
        }
      }
    } catch (err) {
      // 單一流程掃描失敗不能中斷其他流程的監聽
      console.error(`[watchers] 掃描 ${wf.id} 失敗:`, err);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** server 啟動時呼叫一次；重複呼叫安全(不會啟第二個 timer) */
export function startWatchers() {
  if (timer) return;
  // 順手清掉 30 天前的舊記錄，watch_seen 不會無限長大。
  // 哨兵(#seeded#:路徑)要留著——被清掉等於資料夾被重新初始化，當下丟進來的檔案會被靜默吞掉。
  try {
    getDb().prepare(`DELETE FROM watch_seen WHERE seen_at < datetime('now', '-30 day') AND file_key NOT LIKE '#seeded#:%'`).run();
  } catch { /* 清理失敗不影響監聽 */ }
  scanOnce();
  timer = setInterval(scanOnce, TICK_MS);
}
