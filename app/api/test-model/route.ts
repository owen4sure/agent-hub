import { NextResponse } from "next/server";
import { testModel } from "@/lib/modelClient";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { model?: string } | null;
  const model = body?.model;
  if (!model) return NextResponse.json({ ok: false, message: "缺少 model" }, { status: 400 });
  const result = await testModel(model);
  return NextResponse.json(result);
}
