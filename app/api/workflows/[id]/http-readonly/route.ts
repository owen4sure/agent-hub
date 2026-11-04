import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import {
  approveHttpReadOnly,
  httpRequestFingerprint,
  isHttpReadOnlyApproved,
  revokeHttpReadOnly,
} from "@/lib/workflow/httpReadOnlyApproval";
import { suggestsReadOnly } from "@/lib/workflow/sideEffects";

/**
 * 使用者對「某個 http-request 節點的這一份精確請求真的只是查詢」的確認。
 *
 * 為什麼要有這條路由：節點 config 上的 `readOnly` 是 AI 建圖/修復/匯入都能直接寫進去的欄位，
 * 拿它當安全批准等於 AI 自己批准自己(真實踩過的 P0)。真正的批准只能從這裡進來——它綁在
 * method/url/headers/body 的指紋上，AI 之後改動任何一項，批准就自動失效。
 *
 * 這條路由**只讀取磁碟上最新版的節點設定**來算指紋，不接受呼叫端傳來的 config：不然任何人
 * (包含建圖流程)只要送一份「假的、看起來無害的」設定就能換到一張對真實請求無效的批准。
 */
function nodeOf(workflowId: string, nodeId: unknown) {
  if (typeof nodeId !== "string" || !nodeId.trim()) return { error: "缺少 nodeId" } as const;
  const wf = getWorkflow(workflowId);
  if (!wf) return { error: "找不到這個流程" } as const;
  const node = wf.nodes.find((n) => n.id === nodeId);
  if (!node) return { error: "找不到這個步驟(流程可能剛被改過，請重新整理頁面)" } as const;
  if (node.type !== "http-request") return { error: "只有「打 API」步驟需要這個確認" } as const;
  return { node } as const;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const nodeId = new URL(req.url).searchParams.get("nodeId");
  const found = nodeOf(id, nodeId);
  if ("error" in found) return NextResponse.json({ error: found.error }, { status: 404 });
  const config = found.node.config ?? {};
  const method = String(config.method ?? "GET").trim().toUpperCase();
  return NextResponse.json({
    // 這個步驟需不需要確認：只有「不是 GET/HEAD」而且 AI 建議它是查詢時才需要。
    applicable: method !== "GET" && method !== "HEAD",
    aiSuggestsReadOnly: suggestsReadOnly(config),
    approved: isHttpReadOnlyApproved(id, found.node.id, config),
    fingerprint: httpRequestFingerprint(config),
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { nodeId?: unknown };
  const found = nodeOf(id, body.nodeId);
  if ("error" in found) return NextResponse.json({ error: found.error }, { status: 404 });
  const config = found.node.config ?? {};
  const method = String(config.method ?? "GET").trim().toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return NextResponse.json({ error: "GET/HEAD 本來就是讀取，不需要確認" }, { status: 400 });
  }
  const fingerprint = approveHttpReadOnly(id, found.node.id, config);
  return NextResponse.json({ ok: true, approved: true, fingerprint });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { nodeId?: unknown };
  if (typeof body.nodeId !== "string" || !body.nodeId.trim()) {
    return NextResponse.json({ error: "缺少 nodeId" }, { status: 400 });
  }
  revokeHttpReadOnly(id, body.nodeId);
  return NextResponse.json({ ok: true, approved: false });
}
