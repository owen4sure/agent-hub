import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

/**
 * launchd 日誌輪替(copytruncate)。
 *
 * 為什麼需要：常駐服務的 stdout/stderr 由 launchd 直接寫進
 * `~/Library/Logs/Agent Hub/engine(.error).log`，沒有任何機制阻止它無上限長大——
 * 一年跑下來就是幾 GB 的檔案，而且 macOS 的 newsyslog 設定檔在 /etc 底下，要 sudo 才放得進去。
 *
 * 為什麼是 copytruncate 而不是 rename：launchd 以 append 模式握著檔案控制代碼，
 * rename 之後它會**繼續寫進被改名的那個檔案**，輪替等於沒做。唯一安全的做法是
 * 「內容抄去封存檔 → 把原檔清空」；append 模式保證清空後的寫入從新的檔尾開始，不會空洞。
 */

export interface LogRotationOptions {
  dir: string;
  files: string[];
  /** 超過這個大小才輪替。 */
  maxBytes?: number;
  /** 留幾份 .N.gz 封存。 */
  keep?: number;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_KEEP = 3;

export function rotateLogsIfNeeded(opts: LogRotationOptions): void {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = opts.keep ?? DEFAULT_KEEP;
  for (const name of opts.files) {
    // 一個檔案輪替失敗(權限、磁碟滿)不能拖垮其他檔案，更不能往上炸到排程 tick。
    try {
      rotateOne(path.join(opts.dir, name), maxBytes, keep);
    } catch (err) {
      console.warn(`[logRotation] ${name} 輪替失敗(不影響服務)：${err instanceof Error ? err.message : err}`);
    }
  }
}

function rotateOne(file: string, maxBytes: number, keep: number): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // 檔案還不存在(服務沒寫過東西)，沒事
  }
  if (size < maxBytes) return;

  // 封存檔往後推：.2.gz → .3.gz、.1.gz → .2.gz，最舊的超過 keep 就淘汰
  fs.rmSync(`${file}.${keep}.gz`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${file}.${i}.gz`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}.gz`);
  }
  fs.writeFileSync(`${file}.1.gz`, gzipSync(fs.readFileSync(file)));
  fs.truncateSync(file, 0);
}

/** 常駐服務實際在用的日誌位置(跟 LaunchAgent plist 的 StandardOutPath/StandardErrorPath 一致)。 */
export function rotateEngineLogs(): void {
  rotateLogsIfNeeded({
    dir: path.join(os.homedir(), "Library", "Logs", "Agent Hub"),
    files: ["engine.log", "engine.error.log"],
  });
}
