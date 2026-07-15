import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_MANUAL_FILES = 100;
const MAX_MANUAL_TOTAL_BYTES = 256 * 1024 * 1024;
const DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "uploads");

function cleanupManualUploads(): void {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  const files = fs.readdirSync(DIR)
    .filter((item) => item.startsWith("manual-"))
    .map((name) => {
      const file = path.join(/*turbopackIgnore: true*/ DIR, name);
      try { const stat = fs.statSync(file); return { file, mtime: stat.mtimeMs, size: stat.size }; } catch { return null; }
    })
    .filter((item): item is { file: string; mtime: number; size: number } => item !== null)
    .sort((a, b) => b.mtime - a.mtime);
  let total = 0;
  for (const [index, item] of files.entries()) {
    if (item.mtime < cutoff || index >= MAX_MANUAL_FILES || total + item.size > MAX_MANUAL_TOTAL_BYTES) {
      fs.rmSync(item.file, { force: true });
    } else total += item.size;
  }
}

/** 手動模擬「資料夾收到檔案／email 附件」用：一般使用者選檔即可，不必會找本機絕對路徑。 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { filename?: unknown; dataBase64?: unknown } | null;
  if (!body || typeof body.filename !== "string" || typeof body.dataBase64 !== "string" || body.filename.length > 500) {
    return NextResponse.json({ error: "檔案格式不正確" }, { status: 400 });
  }
  const encoded = body.dataBase64.replace(/\s/g, "");
  if (!encoded || encoded.length % 4 !== 0) return NextResponse.json({ error: "檔案內容編碼錯誤" }, { status: 400 });
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.toString("base64") !== encoded) return NextResponse.json({ error: "檔案內容編碼錯誤" }, { status: 400 });
  if (buffer.length > MAX_BYTES) return NextResponse.json({ error: "檔案超過 20MB，請縮小或拆分後再測" }, { status: 413 });

  fs.mkdirSync(DIR, { recursive: true });
  cleanupManualUploads();
  const ext = (path.basename(body.filename).match(/\.[a-zA-Z0-9]{1,12}$/) ?? [".bin"])[0];
  const target = path.join(/*turbopackIgnore: true*/ DIR, `manual-${randomUUID()}${ext}`);
  fs.writeFileSync(target, buffer);
  cleanupManualUploads();
  return NextResponse.json({ path: target, filename: path.basename(body.filename) });
}
