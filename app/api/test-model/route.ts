import { NextResponse } from "next/server";
import { testModel } from "@/lib/modelClient";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { model?: string } | null;
  const model = body?.model;
  if (typeof model !== "string" || !model.trim() || model.length > 160) return NextResponse.json({ ok: false, message: "model 格式不正確" }, { status: 400 });
  const result = await testModel(model.trim());
  return NextResponse.json(result);
}
