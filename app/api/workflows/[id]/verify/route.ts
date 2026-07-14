import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { runWorkflowAndWait } from "@/lib/workflow/engine";
import { resolveParams } from "@/lib/relativeDate";
import { getDb } from "@/lib/db";

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * 「驗證看懂(只讀)」——使用者叫 AI「去看檔案、證明有沒有看懂」用的。
 * 拿使用者現在手上的資料檔，用只讀模式(dryRun)跑這條流程:照常「讀檔/抽取/計算」，
 * 但「寫回試算表、發通知」那幾步一律略過(engine 的 dryRunSkipKind)——絕不改使用者的資料。
 * 跑完把「各步驟實際算出來的值」撈出來回傳，讓使用者對照自己已知的答案，確認 AI 真的看懂了。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    filename?: string; dataBase64?: string; params?: Record<string, unknown>;
  };

  // 使用者(選填)給的現在資料檔:存到 data/uploads，當作要讀的輸入注入 filePath/attachmentPath/savedPath。
  // 有給檔案，engine 就會略過「去信箱抓附件」那幾步，改用這份檔案(dryRun 的 fetch 略過)。
  let savedPath: string | null = null;
  if (body.filename && body.dataBase64) {
    let buf: Buffer;
    try {
      buf = Buffer.from(body.dataBase64, "base64");
    } catch {
      return NextResponse.json({ error: "檔案內容編碼錯誤" }, { status: 400 });
    }
    if (buf.length > MAX_BYTES) return NextResponse.json({ error: "檔案太大(超過 20MB)" }, { status: 413 });
    const uploadDir = path.join(process.cwd(), "data", "uploads");
    fs.mkdirSync(uploadDir, { recursive: true });
    const ext = (body.filename.match(/\.[a-zA-Z0-9]+$/) ?? [".bin"])[0];
    savedPath = path.join(uploadDir, `verify-${randomUUID()}${ext}`);
    fs.writeFileSync(savedPath, buf);
  }

  const rawParams: Record<string, unknown> = { ...(body.params ?? {}) };
  if (savedPath) {
    // 多塞幾個常見的欄位名，抽取節點不管引用哪個都找得到這份檔案
    for (const k of ["filePath", "attachmentPath", "savedPath", "inputFile"]) rawParams[k] = savedPath;
  }
  const triggerParams = resolveParams(wf.triggerParams ?? [], rawParams, new Date());

  try {
    // 只讀模式、背景跑(不彈瀏覽器);讀+抽+算通常很快，給 4 分鐘上限
    const result = await runWorkflowAndWait(id, triggerParams, { dryRun: true, headed: false, timeoutMs: 4 * 60_000 });

    // 撈各步驟實際算出來的值(略過 trigger 與被 dryRun 跳過的寫出步驟)
    const db = getDb();
    const rows = db.prepare(
      `SELECT node_id, status, output_json FROM node_runs WHERE run_id = ? ORDER BY id`,
    ).all(result.runId) as { node_id: string; status: string; output_json: string | null }[];
    const labelOf = new Map(wf.nodes.map((n) => [n.id, n.label] as const));
    const typeOf = new Map(wf.nodes.map((n) => [n.id, n.type] as const));

    const values: { nodeLabel: string; computed: Record<string, unknown> }[] = [];
    const skippedWrites: string[] = [];
    for (const r of rows) {
      const label = labelOf.get(r.node_id) ?? r.node_id;
      if (typeOf.get(r.node_id) === "trigger") continue;
      if (r.status === "skipped") { skippedWrites.push(label); continue; }
      if (r.status !== "success" || !r.output_json) continue;
      const computed = pickComputedValues(r.output_json);
      if (Object.keys(computed).length > 0) values.push({ nodeLabel: label, computed });
    }

    return NextResponse.json({
      ok: result.status === "success",
      status: result.status,
      failedNode: result.failedNode ? labelOf.get(result.failedNode) ?? result.failedNode : null,
      error: result.error ?? null,
      runId: result.runId,
      values,
      skippedWrites,
    });
  } finally {
    // 驗證用的暫存檔用完就刪，不留使用者的資料在磁碟
    if (savedPath) fs.rmSync(savedPath, { force: true });
  }
}

/**
 * 從一個節點的輸出裡挑出「適合給人看的算出來的值」——數字、短字串(日期區間、名稱)這種，
 * 丟掉 HTML/base64/超長字串/大陣列這些雜訊，讓使用者一眼看到「他到底算出什麼」。
 */
function pickComputedValues(outputJson: string): Record<string, unknown> {
  let obj: unknown;
  try { obj = JSON.parse(outputJson); } catch { return {}; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") { if (v.length > 0 && v.length <= 200) out[k] = v; }
    else if (Array.isArray(v)) { if (v.length <= 20 && v.every((x) => typeof x !== "object")) out[k] = v; }
    // 巢狀物件/長字串/大陣列(HTML、base64、原始表格)略過——那不是使用者要對的「答案」
  }
  return out;
}
