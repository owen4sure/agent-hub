import { NextResponse } from "next/server";
import { getSharedSecrets, setSharedSecrets } from "@/lib/settingsStore";

/** 全域共用帳密(依欄位名稱)：回傳哪些 key 已設定(不回傳明碼值)。 */
export async function GET() {
  const secrets = getSharedSecrets();
  const set = Object.fromEntries(Object.keys(secrets).map((k) => [k, true]));
  return NextResponse.json({ set });
}

/** 存共用帳密：{ secrets: { key: value } }，空字串的欄位略過(不清空既有值)。 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { secrets?: Record<string, unknown> };
  const raw = body.secrets && typeof body.secrets === "object" ? body.secrets : {};
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.length > 0) clean[k] = v;
  }
  if (Object.keys(clean).length > 0) setSharedSecrets(clean);
  const secrets = getSharedSecrets();
  return NextResponse.json({ ok: true, set: Object.fromEntries(Object.keys(secrets).map((k) => [k, true])) });
}
