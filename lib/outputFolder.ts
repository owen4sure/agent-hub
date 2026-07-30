/**
 * 「產出的檔案要放哪個資料夾」。
 *
 * 為什麼需要(使用者原話)：「使用者可以在桌面自己新增資料夾然後指定產出的檔案要放去哪個資料夾，
 * 而不是都直接丟在桌面上」。原本 excel-process 是**寫死** `~/Desktop`，
 * write-file 則是要使用者自己在欄位裡貼一個絕對路徑——兩個都不合格：
 * 前者不給選，後者要小白知道什麼是絕對路徑。
 *
 * 設計原則：
 * ①**列給他選，不要叫他打路徑**。所以這裡提供「可選的上層位置(桌面/文件/下載)」+「裡面現有的資料夾」，
 *   並且可以當場建一個新的。
 * ②**不設定就完全不改變現有行為**。沒設定過 = 沿用舊行為(桌面)，不會有人的檔案突然跑去別的地方。
 * ③**只准放在家目錄底下**。使用者選的路徑會被拿去寫檔，所以要擋路徑穿越與系統目錄——
 *   這跟專案其他「拿使用者給的路徑去做事」的地方(urlGuard、workflow id 驗證)守同一條線。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "./db";

const SETTING_KEY = "outputFolder";

/** 可以當上層位置的地方。刻意只給這幾個常用的，不做「瀏覽整台電腦」——那對小白只是更難。 */
export const PARENT_CHOICES = [
  { key: "desktop", label: "桌面", dir: () => path.join(os.homedir(), "Desktop") },
  { key: "documents", label: "文件", dir: () => path.join(os.homedir(), "Documents") },
  { key: "downloads", label: "下載", dir: () => path.join(os.homedir(), "Downloads") },
] as const;

export function homeContains(target: string): boolean {
  const home = fs.realpathSync(os.homedir());
  let resolved: string;
  try {
    // realpath 之後再比：symlink 指到家目錄外面是最典型的繞過方式。
    resolved = fs.realpathSync(path.resolve(target));
  } catch {
    // 還不存在的路徑(要新建的資料夾)：用它已存在的最近上層來判斷。
    resolved = path.resolve(target);
    let probe = resolved;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    try { resolved = path.join(fs.realpathSync(probe), path.relative(probe, resolved)); } catch { return false; }
  }
  return resolved === home || resolved.startsWith(home + path.sep);
}

/** 使用者設定的產出資料夾；沒設定過回 null(呼叫端就沿用各自原本的預設行為)。 */
export function getOutputFolder(): string | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTING_KEY) as { value: string } | undefined;
  const value = row?.value?.trim();
  if (!value) return null;
  // 設定過但資料夾被使用者手動刪掉/改名了：回 null 而不是讓每次執行都爆錯，
  // 並讓畫面那張卡片自己顯示「找不到，請重新選」。
  if (!fs.existsSync(value) || !fs.statSync(value).isDirectory()) return null;
  if (!homeContains(value)) return null;
  return value;
}

/** 設定過但現在讀不到(被刪掉/改名/移到家目錄外)——畫面要能講出這件事。 */
export function getOutputFolderRaw(): string | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTING_KEY) as { value: string } | undefined;
  return row?.value?.trim() || null;
}

export function setOutputFolder(dir: string): { ok: true; dir: string } {
  const resolved = path.resolve(dir);
  if (!homeContains(resolved)) throw new Error("只能選你自己家目錄底下的資料夾（桌面、文件、下載…）");
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error("這個資料夾不存在");
  fs.accessSync(resolved, fs.constants.W_OK);
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(SETTING_KEY, resolved);
  return { ok: true, dir: resolved };
}

export function clearOutputFolder(): void {
  getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(SETTING_KEY);
}

export interface FolderChoice { name: string; dir: string; fileCount: number }

/** 列出某個上層位置底下的資料夾(給使用者選)。不遞迴、不列檔案——選資料夾就是選資料夾。 */
export function listFolders(parentKey: string): { parent: string; folders: FolderChoice[] } {
  const choice = PARENT_CHOICES.find((c) => c.key === parentKey) ?? PARENT_CHOICES[0];
  const parent = choice.dir();
  if (!fs.existsSync(parent)) return { parent, folders: [] };
  const folders: FolderChoice[] = [];
  for (const name of fs.readdirSync(parent)) {
    if (name.startsWith(".")) continue;
    const dir = path.join(parent, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      folders.push({ name, dir, fileCount: fs.readdirSync(dir).filter((f) => !f.startsWith(".")).length });
    } catch { /* 讀不到的(權限、壞掉的 symlink)就跳過，不要讓整份清單失敗 */ }
  }
  return { parent, folders: folders.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")) };
}

/** 在指定的上層位置底下建一個新資料夾（讓使用者不用切出去用 Finder 建）。 */
export function createFolder(parentKey: string, name: string): { dir: string } {
  const clean = name.trim().replace(/[/\\:*?"<>|]/g, "").slice(0, 60);
  if (!clean) throw new Error("請給資料夾一個名字");
  const choice = PARENT_CHOICES.find((c) => c.key === parentKey) ?? PARENT_CHOICES[0];
  const dir = path.join(choice.dir(), clean);
  if (!homeContains(dir)) throw new Error("只能建在你自己家目錄底下");
  if (fs.existsSync(dir)) return { dir }; // 已經有同名資料夾就直接用它，不要報錯逼他改名
  fs.mkdirSync(dir, { recursive: true });
  return { dir };
}

/**
 * 節點要把檔案「另外存一份給使用者」時的目標資料夾。
 *
 * 順序：節點自己設定的 > 全域設定的 > 呼叫端的預設(通常是桌面，維持舊行為)。
 * 回 null 代表不要另外複製。
 */
export function resolveExtraSaveDir(nodeConfigured: string | null | undefined, fallback: string | null = null): string | null {
  const fromNode = nodeConfigured?.trim();
  if (fromNode) return homeContains(fromNode) ? path.resolve(fromNode) : null;
  return getOutputFolder() ?? fallback;
}
