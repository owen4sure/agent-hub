import { NextResponse } from "next/server";
import { getSharedSecrets } from "@/lib/settingsStore";

/**
 * 明碼還原：使用者在 /settings 主動點「顯示並複製」才會打這支，跟 GET /api/secrets(頁面
 * 一載入就打、只回布林值)分開，明碼不會被動出現在一般的頁面載入回應裡。
 */
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  if (!key) return NextResponse.json({ error: "缺少 key" }, { status: 400 });
  const secrets = getSharedSecrets();
  if (!(key in secrets)) return NextResponse.json({ error: "找不到這個欄位" }, { status: 404 });
  return NextResponse.json({ value: secrets[key] });
}
