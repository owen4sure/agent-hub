import { NextResponse } from "next/server";
import { deleteProvider, listModelChoices, listProviders, saveProvider } from "@/lib/modelProviders";
import { getModelPreference, listUsableModels, planModelChain, setModelPreference } from "@/lib/modelPolicy";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";

/**
 * 模型來源清單 + 攤平後的可選模型。
 *
 * 前端(模型下拉選單、設定頁)一律從這裡拿模型清單，**不要再從 lib/models.ts 的寫死陣列拿**——
 * 那份清單是在某一個免費 gateway 上實測的結果，使用者自己接的地端模型永遠不可能進到那裡面。
 */
export async function GET() {
  // usable = 依「文字任務」判斷現在真的叫得動的模型。全新安裝沒填 Base URL/金鑰時，內建那組的
  // 二十幾個代號會全部不在裡面——列出使用者根本沒有的模型只會讓他選了才發現不能用。
  const [usableText, usableVision] = await Promise.all([listUsableModels("text"), listUsableModels("vision")]);
  const usableRefs = new Set(usableText.map((m) => m.ref));
  const visionRefs = new Set(usableVision.map((m) => m.ref));
  return NextResponse.json({
    providers: listProviders().map((p) => ({
      id: p.id, label: p.label, baseUrl: p.baseUrl, models: p.models, vision: p.vision, timeoutMs: p.timeoutMs,
      local: p.local === true,
      builtin: Boolean(p.builtin),
      // 金鑰只回「有沒有設定」，不回值
      hasKey: Boolean(p.apiKey),
    })),
    choices: listModelChoices().map((c) => ({
      ...c,
      usable: usableRefs.has(c.ref),
      visionUsable: visionRefs.has(c.ref),
      local: usableText.find((m) => m.ref === c.ref)?.local ?? false,
    })),
    preference: getModelPreference(),
    // 目前**實際生效**的順序。使用者還沒排過時這就是自動預填的順序——設定頁直接把它顯示出來
    // 讓他拖(而不是給一張空白清單叫他自己想)，一動就變成他自己的偏好。
    effective: {
      text: (await planModelChain({ need: "text" })).chain.map((p) => p.ref),
      vision: (await planModelChain({ need: "vision" })).chain.map((p) => p.ref),
    },
  }, { headers: { "Cache-Control": "no-store" } });
}

/** 主力/救援順序與「不要自動換」——使用者自己排，平台不寫死。 */
export async function PUT(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { text?: unknown; vision?: unknown; strict?: unknown } | null;
  if (!body) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });
  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => String(x)) : undefined;
  const preference = setModelPreference({
    text: list(body.text),
    vision: list(body.vision),
    strict: body.strict === undefined ? undefined : body.strict === true,
  });
  recordAuditFromRequest(req, "model-preference.save", "preference", preference);
  return NextResponse.json({ ok: true, preference });
}

/** 新增/更新一個模型來源。 */
export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as {
    id?: unknown; label?: unknown; baseUrl?: unknown; apiKey?: unknown; models?: unknown; vision?: unknown; timeoutMs?: unknown;
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
      local: (body as { local?: unknown }).local === true,
      timeoutMs: Number(body.timeoutMs) || undefined,
    });
    recordAuditFromRequest(req, "model-provider.save", provider.id, {
      label: provider.label, baseUrl: provider.baseUrl, models: provider.models, vision: provider.vision, hadKey: Boolean(provider.apiKey),
    });
    return NextResponse.json({ ok: true, provider: { ...provider, apiKey: undefined } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "儲存失敗" }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  // **先把要刪的內容記下來再刪**：真實踩過——誤刪了一個來源之後，稽核紀錄只有 {models:1}，
  // 連模型代號叫什麼都無從得知，等於救不回來。稽核軌跡要能回答「刪掉的是什麼」才有意義。
  // 金鑰永遠不記(稽核軌跡不能變成第二個洩漏管道)，其餘欄位足以重建。
  const before = listProviders().find((p) => p.id === id);
  if (!deleteProvider(id)) return NextResponse.json({ error: "找不到這個來源（內建的那組不能刪）" }, { status: 400 });
  recordAuditFromRequest(req, "model-provider.delete", id, before
    ? { label: before.label, baseUrl: before.baseUrl, models: before.models, vision: before.vision, hadKey: Boolean(before.apiKey) }
    : null);
  return NextResponse.json({ ok: true });
}
