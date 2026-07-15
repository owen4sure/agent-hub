import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { getGlobalSettings, getSharedSecrets } from "@/lib/settingsStore";
import { redactKnownSecrets } from "@/lib/exportSanitizer";

// 匯出 workflow 定義(不含帳密)
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // id 不合法時 getWorkflow 會直接 throw(擋路徑穿越)，這裡先擋下來回 404 而不是 500
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const { apiKey } = getGlobalSettings();
  const bundle = redactKnownSecrets(
    { ...wf, builtin: false },
    { ...getSharedSecrets(), ...(apiKey ? { MODEL_API_KEY: apiKey } : {}) },
  );
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${id}.agenthub-workflow.json"`,
      "Cache-Control": "no-store",
    },
  });
}
