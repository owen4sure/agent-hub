import { NextResponse } from "next/server";
import { createWorkflow, saveWorkflow } from "@/lib/workflow/store";
import { convertN8nWorkflow } from "@/lib/workflow/n8nAnalyzer";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function POST(req: Request) {
  const raw = await req.text().catch(() => "");
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "n8n 流程檔案太大(上限 2MB)" }, { status: 413 });
  }
  const input = (() => { try { return JSON.parse(raw); } catch { return null; } })();
  if (!input) return NextResponse.json({ error: "請貼上有效的 n8n 流程 JSON" }, { status: 400 });
  try {
    const converted = convertN8nWorkflow(input);
    const wf = createWorkflow(converted.workflow.name || "n8n 安全轉換草稿");
    const draft = {
      ...wf,
      description: converted.workflow.description,
      nodes: converted.workflow.nodes,
      edges: converted.workflow.edges,
      importedUntrusted: true,
      n8nMigration: converted.migration,
    };
    saveWorkflow(draft);
    return NextResponse.json({ ok: true, id: draft.id, clearedCodeCount: converted.clearedCodeCount, clearedCredentialCount: converted.clearedCredentialCount, reviewCount: converted.reviewCount, unsupportedCount: converted.unsupportedCount, unsupportedNodeIds: converted.unsupportedNodeIds, sourceFingerprint: converted.migration.sourceFingerprint });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "無法轉換這個 n8n 流程" }, { status: 400 });
  }
}
