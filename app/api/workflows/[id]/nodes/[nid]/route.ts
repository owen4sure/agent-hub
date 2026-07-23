import { NextResponse } from "next/server";
import { getClient } from "@/lib/modelClient";
import { getWorkflow } from "@/lib/workflow/store";
import { getWorkflowModel } from "@/lib/settingsStore";
import { editNode } from "@/lib/workflow/nodeEditor";
import { getDb } from "@/lib/db";
import { autorunActive } from "@/lib/workflow/busyLocks";
import type { MessagePart } from "@/lib/workflow/builder";

function isValidPart(p: unknown): p is MessagePart {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  if (o.kind === "text") return typeof o.text === "string";
  if (o.kind === "image") return typeof o.b64 === "string" && o.b64.length > 0 && o.b64.length < 12_000_000;
  if (o.kind === "file") return typeof o.name === "string" && typeof o.content === "string";
  return false;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; nid: string }> },
) {
  const { id, nid } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { parts?: unknown[]; repair?: boolean } | null;
  // 節點面板的附件是「這個節點專用」的小規模輸入(不像整條流程對話動輒十幾輪)，上限給緊一點：
  // 圖片最多 4 張(vision prompt 太多圖只會稀釋注意力)、檔案內容各裁到 12000 字(跟 nodeEditor 一致)、
  // 依使用者真實輸入順序保留(不打散重排)，AI 才知道某段文字在講哪一張圖/哪份檔案。
  let imageCount = 0;
  let fileCount = 0;
  // 超過上限被丟掉的張數/份數要老實回報給前端——不然使用者附了 6 張圖只有 4 張真的送到 AI，
  // 畫面卻只顯示「已更新這個節點」，完全不知道有 2 張被默默丟掉(踩過的真實使用情境：一次附多張
  // 螢幕截圖重現多步驟的失敗畫面，超過上限的那幾張連 AI 都沒看到)。
  let droppedImages = 0;
  let droppedFiles = 0;
  const parts: MessagePart[] = [];
  for (const raw of Array.isArray(body?.parts) ? body.parts : []) {
    if (!isValidPart(raw)) continue;
    if (raw.kind === "image") {
      if (imageCount >= 4) { droppedImages++; continue; }
      imageCount++;
      parts.push(raw);
    } else if (raw.kind === "file") {
      if (fileCount >= 4) { droppedFiles++; continue; }
      fileCount++;
      parts.push({ ...raw, content: raw.content.slice(0, 12_000) });
    } else {
      parts.push({ ...raw, text: raw.text.slice(0, 24_000) });
    }
  }
  const hasContent = parts.some((p) => p.kind !== "text" || p.text.trim().length > 0);
  if (!hasContent) return NextResponse.json({ error: "請描述要修改的內容" }, { status: 400 });

  // 自動測試/修復迴圈進行中不能同時手動微調同一條流程的節點——迴圈事後的止損還原(restoreUnverified)
  // 會依它自己記錄的「哪些節點已驗證修好」把節點 config 蓋回迴圈開始前的快照，這裡剛存的手動修改
  // 會被無聲蓋掉且沒有任何提示(踩過的競態)。
  if (autorunActive.has(id)) {
    return NextResponse.json({ error: "這條流程的自動測試/修復正在進行中，等它跑完再手動修改(不然會被還原動作蓋掉)" }, { status: 409 });
  }

  // repair 模式：找這個節點最近一次失敗的 run 以取截圖
  let repairRunId: string | undefined;
  if (body?.repair) {
    const row = getDb()
      .prepare(
        `SELECT run_id FROM node_runs WHERE node_id = ? AND status = 'failed' AND run_id IN (SELECT id FROM runs WHERE workflow_id = ?) ORDER BY id DESC LIMIT 1`,
      )
      .get(nid, id) as { run_id: string } | undefined;
    repairRunId = row?.run_id;
  }

  try {
    const client = getClient();
    const model = getWorkflowModel(id, wf.defaultModel);
    // 使用者離開畫面／取消 request 時，連同模型重試、SDK 呼叫與 Claude Code 備援一起中止；
    // 否則一次白話微調可能在瀏覽器早已不要結果後仍於背景耗到 90 秒逾時。
    const result = await editNode(client, model, id, nid, parts, {
      repairRunId, signal: req.signal,
    });
    return NextResponse.json({ ...result, ...(droppedImages > 0 ? { droppedImages } : {}), ...(droppedFiles > 0 ? { droppedFiles } : {}) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
