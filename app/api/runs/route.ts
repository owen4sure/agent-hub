import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

/** 全域執行紀錄:所有流程的歷史執行一次看(每條流程各自保留最近 20 筆,見 engine.pruneRuns) */
export async function GET() {
  try {
    const rows = getDb()
      .prepare(
        `SELECT r.id, r.workflow_id, r.status, r.trigger_type, r.reason, r.resolution, r.failed_node, r.started_at, r.finished_at,
                COALESCE(m.name, r.workflow_id) AS workflow_name
         FROM runs r LEFT JOIN workflows_meta m ON m.id = r.workflow_id
         ORDER BY r.started_at DESC LIMIT 200`,
      )
      .all();
    return NextResponse.json({ runs: rows });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "讀取執行紀錄失敗" }, { status: 500 });
  }
}
