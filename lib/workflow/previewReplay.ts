import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "preview-inputs");
const MAX_AGE_MS = 24 * 60 * 60_000;

export interface PreviewReplay {
  token: string;
  workflowId: string;
  previewRunId: string;
  graphFingerprint: string;
  createdAt: number;
  triggerParams: Record<string, unknown>;
  secretOverrides: Record<string, string>;
  nodeConfigOverrides: Record<string, Record<string, unknown>>;
  retainedFiles: string[];
}

function validToken(token: string): boolean {
  return /^[a-f0-9-]{36}$/.test(token);
}

function recordPath(token: string, claimed = false): string {
  if (!validToken(token)) throw new Error("安全預覽憑證格式不正確");
  return path.join(/*turbopackIgnore: true*/ DIR, `${token}${claimed ? ".claimed" : ""}.json`);
}

function cleanup(): void {
  if (!fs.existsSync(DIR)) return;
  for (const name of fs.readdirSync(DIR).filter((item) => item.endsWith(".json"))) {
    const file = path.join(/*turbopackIgnore: true*/ DIR, name);
    try {
      const record = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as PreviewReplay;
      if (Date.now() - record.createdAt <= MAX_AGE_MS) continue;
      for (const retained of record.retainedFiles ?? []) fs.rmSync(retained, { force: true });
      fs.rmSync(file, { force: true });
    } catch {
      try { if (Date.now() - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
    }
  }
}

/** 保存「使用者剛核對的確切輸入」；正式確認不能改拿 workflow 舊網址或已被刪掉的暫存附件。 */
export function savePreviewReplay(input: Omit<PreviewReplay, "token" | "createdAt">): PreviewReplay {
  fs.mkdirSync(DIR, { recursive: true });
  cleanup();
  const record: PreviewReplay = { ...input, token: randomUUID(), createdAt: Date.now() };
  const target = recordPath(record.token);
  const tmp = `${target}.${process.pid}-${randomUUID().slice(0, 6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, target);
  return record;
}

/** rename 是跨進程原子的：同一個「確認執行」即使連點兩次，也只有一個請求拿得到憑證。 */
export function claimPreviewReplay(token: string, workflowId: string): PreviewReplay | null {
  cleanup();
  const source = recordPath(token);
  const claimed = recordPath(token, true);
  try { fs.renameSync(source, claimed); } catch { return null; }
  try {
    const record = JSON.parse(fs.readFileSync(claimed, "utf8")) as PreviewReplay;
    if (record.token !== token || record.workflowId !== workflowId || Date.now() - record.createdAt > MAX_AGE_MS) {
      fs.renameSync(claimed, source);
      return null;
    }
    return record;
  } catch {
    try { fs.renameSync(claimed, source); } catch { /* 損毀檔交給 cleanup */ }
    return null;
  }
}

/** 啟動正式 run 失敗（例如剛好少設定）時，把 claim 還回去，使用者補完可再次確認。 */
export function releasePreviewReplay(token: string): void {
  try { fs.renameSync(recordPath(token, true), recordPath(token)); } catch { /* 已被清理或已釋放 */ }
}

/** 測試／未來取消 API 用：兩種狀態都清掉，連同只為這次預覽保留的暫存附件。 */
export function discardPreviewReplay(token: string): void {
  let record: PreviewReplay | null = null;
  for (const claimed of [false, true]) {
    const file = recordPath(token, claimed);
    try {
      record ??= JSON.parse(fs.readFileSync(file, "utf8")) as PreviewReplay;
      fs.rmSync(file, { force: true });
    } catch { /* 不存在 */ }
  }
  for (const retained of record?.retainedFiles ?? []) fs.rmSync(retained, { force: true });
}
