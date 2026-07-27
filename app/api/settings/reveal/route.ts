import { NextResponse } from "next/server";
import { getGlobalSettings } from "@/lib/settingsStore";

/** 模型 API Key 明碼還原，同 /api/secrets/reveal 的設計：主動點擊才觸發，不隨頁面載入回傳。 */
export async function GET() {
  const { apiKey } = getGlobalSettings();
  if (!apiKey) return NextResponse.json({ error: "尚未設定 API Key" }, { status: 404 });
  return NextResponse.json({ value: apiKey });
}
