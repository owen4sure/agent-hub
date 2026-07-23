import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { listFiles } from "./files";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE run_files (
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
    INSERT INTO run_files (run_id, workflow_id, filename, path, mime, size, created_at, kind) VALUES
      ('r1', 'wf1', '月報.xlsx',   '/out/月報.xlsx',   'application/vnd.ms-excel', 100, '2026-07-15 10:00:00', 'output'),
      ('r1', 'wf1', '附件.zip',    '/dbg/附件.zip',    'application/zip',          200, '2026-07-15 09:59:00', 'intermediate'),
      ('r1', 'wf1', '解出來的.csv','/out/extracted/a.csv', 'text/csv',             50,  '2026-07-15 09:58:00', 'intermediate'),
      ('r2', 'wf2', '報表.pdf',    '/out/報表.pdf',    'application/pdf',          300, '2026-07-15 09:00:00', 'output');
  `);
  return db;
}

test("產出檔案清單只列交付產出，中間檔(附件/解壓檔)不洗版", () => {
  const db = makeDb();
  const all = listFiles(undefined, db);
  assert.deepEqual(all.map((f) => f.filename), ["月報.xlsx", "報表.pdf"]);

  const wf1 = listFiles("wf1", db);
  assert.deepEqual(wf1.map((f) => f.filename), ["月報.xlsx"]);
  db.close();
});
