import type Database from "better-sqlite3";
import { getDb } from "./db";

export interface RunFile {
  id: number;
  run_id: string;
  workflow_id: string;
  filename: string;
  path: string;
  mime: string;
  size: number;
  created_at: string;
  kind: "output" | "intermediate";
}

// 只列交付產出(kind='output')。中間檔(下載的附件、解壓出的檔案)照樣登記在 run_files
// (生命週期跟著 run、AI 對話還讀得到),但使用者的「產出檔案」頁不該被它們洗版。
export function listFiles(workflowId?: string, db: Database.Database = getDb()): RunFile[] {
  if (workflowId) {
    return db
      .prepare(`SELECT * FROM run_files WHERE workflow_id = ? AND kind = 'output' ORDER BY created_at DESC`)
      .all(workflowId) as RunFile[];
  }
  return db.prepare(`SELECT * FROM run_files WHERE kind = 'output' ORDER BY created_at DESC`).all() as RunFile[];
}

export function getFile(fileId: number): RunFile | undefined {
  if (!Number.isInteger(fileId)) return undefined;
  const db = getDb();
  return db.prepare(`SELECT * FROM run_files WHERE id = ?`).get(fileId) as RunFile | undefined;
}

export function deleteFile(fileId: number) {
  if (!Number.isInteger(fileId)) return;
  const db = getDb();
  db.prepare(`DELETE FROM run_files WHERE id = ?`).run(fileId);
}
