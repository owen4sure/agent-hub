import { createHash } from "node:crypto";
import { getDb } from "../db";
import { decryptSecret, encryptSecret } from "../secretVault";

export type RepeatCheckpointStatus = "running" | "success" | "failed";

export interface RepeatCheckpoint {
  itemIndex: number;
  itemFingerprint: string;
  status: RepeatCheckpointStatus;
  output: Record<string, unknown> | null;
  error: string | null;
  attempt: number;
}

/**
 * repeat-steps 是一個外層節點，但裡面可能包含寄信、寫表格等副作用。
 * 每個項目的完成輸出獨立記帳，讓外層重試不會把已經成功的項目再做一次。
 * output 可能含檔案路徑、信件內容或上游資料，故只以本機 vault 加密保存。
 */
export function itemFingerprint(item: unknown): string {
  let serialized = "";
  try { serialized = JSON.stringify(item); } catch { serialized = String(item); }
  return createHash("sha256").update(serialized).digest("hex");
}

export function getRepeatCheckpoints(runId: string, nodeId: string): Map<number, RepeatCheckpoint> {
  const rows = getDb().prepare(
    `SELECT item_index, item_fingerprint, status, output_json, error, attempt
       FROM repeat_item_checkpoints WHERE run_id=? AND node_id=? ORDER BY item_index`,
  ).all(runId, nodeId) as Array<{
    item_index: number;
    item_fingerprint: string;
    status: RepeatCheckpointStatus;
    output_json: string | null;
    error: string | null;
    attempt: number;
  }>;
  const result = new Map<number, RepeatCheckpoint>();
  for (const row of rows) {
    let output: Record<string, unknown> | null = null;
    if (row.output_json) {
      try {
        const parsed = JSON.parse(decryptSecret(row.output_json));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) output = parsed as Record<string, unknown>;
      } catch { /* 壞掉的檢查點不當成成功，讓這一項重新執行 */ }
    }
    result.set(row.item_index, {
      itemIndex: row.item_index,
      itemFingerprint: row.item_fingerprint,
      status: row.status,
      output,
      error: row.error,
      attempt: row.attempt,
    });
  }
  return result;
}

export function saveRepeatCheckpoint(input: {
  runId: string;
  nodeId: string;
  itemIndex: number;
  itemFingerprint: string;
  status: RepeatCheckpointStatus;
  output?: Record<string, unknown> | null;
  error?: string | null;
}): void {
  const db = getDb();
  const outputJson = input.output ? encryptSecret(JSON.stringify(input.output)) : null;
  db.prepare(
    `INSERT INTO repeat_item_checkpoints
      (run_id, node_id, item_index, item_fingerprint, status, output_json, error, attempt, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
     ON CONFLICT(run_id, node_id, item_index) DO UPDATE SET
       item_fingerprint=excluded.item_fingerprint,
       status=excluded.status,
       output_json=excluded.output_json,
       error=excluded.error,
       attempt=repeat_item_checkpoints.attempt + 1,
       updated_at=datetime('now')`,
  ).run(
    input.runId, input.nodeId, input.itemIndex, input.itemFingerprint, input.status,
    outputJson, input.error ?? null,
  );
}

