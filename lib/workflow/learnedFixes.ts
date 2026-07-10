import { getDb } from "../db";

export interface LearnedFix {
  id: number;
  node_type: string;
  error_signature: string;
  error_sample: string | null;
  before_json: string | null;
  after_json: string | null;
  note: string | null;
  created_at: string;
}

/** 把錯誤訊息濃縮成「特徵」——去掉數字/時間/路徑等會變動的部分，方便比對「類似問題」 */
export function errorSignature(error: string): string {
  return (error || "")
    .replace(/\d+/g, "#")
    .replace(/["'`].*?["'`]/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** 記下一次成功的修復(某型別節點 + 某類錯誤 → 這樣改就好了)，以後遇到類似的直接參考 */
export function recordFix(input: {
  nodeType: string;
  error: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  note?: string;
}) {
  const db = getDb();
  const sig = errorSignature(input.error);
  // 同型別+同錯誤特徵已存在就更新(保留最新有效解)，避免累積重複
  const existing = db
    .prepare(`SELECT id FROM learned_fixes WHERE node_type = ? AND error_signature = ?`)
    .get(input.nodeType, sig) as { id: number } | undefined;
  if (existing) {
    db.prepare(`UPDATE learned_fixes SET after_json=?, error_sample=?, created_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(input.after), input.error.slice(0, 500), existing.id);
    return;
  }
  db.prepare(
    `INSERT INTO learned_fixes (node_type, error_signature, error_sample, before_json, after_json, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    input.nodeType,
    sig,
    input.error.slice(0, 500),
    JSON.stringify(input.before),
    JSON.stringify(input.after),
    input.note ?? null,
  );
}

/** 找出這個型別節點、跟目前錯誤類似的過往成功修復，給 AI 當參考 */
export function findRelevantFixes(nodeType: string, error: string, limit = 3): LearnedFix[] {
  const db = getDb();
  const sig = errorSignature(error);
  const all = db
    .prepare(`SELECT * FROM learned_fixes WHERE node_type = ? ORDER BY created_at DESC`)
    .all(nodeType) as LearnedFix[];
  // 完全相同特徵優先，其次挑有共同關鍵詞的
  const exact = all.filter((f) => f.error_signature === sig);
  if (exact.length) return exact.slice(0, limit);
  const words = sig.split(" ").filter((w) => w.length >= 2);
  const scored = all
    .map((f) => ({ f, score: words.filter((w) => f.error_signature.includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.f);
}
