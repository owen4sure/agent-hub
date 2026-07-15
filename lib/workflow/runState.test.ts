import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { markPendingNodeRunsSkipped } from "./runState";

test("停止執行：所有尚未開始的節點都收尾為 skipped，不留下假 pending", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE node_runs (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      finished_at TEXT
    );
    INSERT INTO node_runs (run_id, node_id, status) VALUES
      ('r1', 'current', 'failed'),
      ('r1', 'next-a', 'pending'),
      ('r1', 'next-b', 'pending'),
      ('other', 'untouched', 'pending');
  `);

  assert.equal(markPendingNodeRunsSkipped(db, "r1"), 2);
  const rows = db.prepare(`SELECT run_id, node_id, status, finished_at FROM node_runs ORDER BY run_id, node_id`).all() as
    { run_id: string; node_id: string; status: string; finished_at: string | null }[];
  assert.deepEqual(rows.map(({ run_id, node_id, status }) => ({ run_id, node_id, status })), [
    { run_id: "other", node_id: "untouched", status: "pending" },
    { run_id: "r1", node_id: "current", status: "failed" },
    { run_id: "r1", node_id: "next-a", status: "skipped" },
    { run_id: "r1", node_id: "next-b", status: "skipped" },
  ]);
  assert.ok(rows.filter((row) => row.run_id === "r1" && row.status === "skipped").every((row) => row.finished_at));
  db.close();
});
