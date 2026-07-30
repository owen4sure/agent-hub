import { NextResponse } from "next/server";
import { deleteProvider, listModelChoices, listProviders, saveProvider } from "@/lib/modelProviders";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";

/**
 * 模型來源清單 + 攤平後的可選模型。
 *
 * 前端(模型下拉選單、設定頁)一律從這裡拿模型清單，**不要再從 lib/models.ts 的寫死陣列拿**——
 * 那份清單是在某一個免費 gateway 上實測的結果，使用者自己接的地端模型永遠不可能進到那裡面。
 */
export async function GET() {
  return NextResponse.json({
    providers: listProviders().map((p) => ({
      id: p.id, label: p.label, baseUrl: p.baseUrl, models: p.models, vision: p.vision,
      builtin: Boolean(p.builtin),
      // 金鑰只回「有沒有設定」，不回值
      hasKey: Boolean(p.apiKey),
    })),
    choices: listModelChoices(),
  }, { headers: { "Cache-Control": "no-store" } });
}

/** 新增/更新一個模型來源。 */
export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as {
    id?: unknown; label?: unknown; baseUrl?: unknown; apiKey?: unknown; models?: unknown; vision?: unknown;
  } | null;
  if (!body) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });
  try {
    const provider = saveProvider({
      id: String(body.id ?? ""),
      label: String(body.label ?? ""),
      baseUrl: String(body.baseUrl ?? ""),
      apiKey: String(body.apiKey ?? ""),
      models: typeof body.models === "string"
        ? body.models.split(/[,\n]/).map((m) => m.trim()).filter(Boolean)
        : Array.isArray(body.models) ? body.models.map((m) => String(m)) : [],
      vision: body.vision === true,
    });
    recordAuditFromRequest(req, "model-provider.save", provider.id, { models: provider.models.length });
    return NextResponse.json({ ok: true, provider: { ...provider, apiKey: undefined } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "儲存失敗" }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!deleteProvider(id)) return NextResponse.json({ error: "找不到這個來源（內建的那組不能刪）" }, { status: 400 });
  recordAuditFromRequest(req, "model-provider.delete", id);
  return NextResponse.json({ ok: true });
}
