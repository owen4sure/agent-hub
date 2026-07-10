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
}

export function listFiles(workflowId?: string): RunFile[] {
  const db = getDb();
  if (workflowId) {
    return db
      .prepare(`SELECT * FROM run_files WHERE workflow_id = ? ORDER BY created_at DESC`)
      .all(workflowId) as RunFile[];
  }
  return db.prepare(`SELECT * FROM run_files ORDER BY created_at DESC`).all() as RunFile[];
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
