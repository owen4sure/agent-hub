import { NextResponse } from "next/server";
import { getGlobalSettings } from "@/lib/settingsStore";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";

/**
 * 模型 API Key 明碼還原，同 /api/secrets/reveal 的設計：主動點擊才觸發，不隨頁面載入回傳。
 * 一樣是 POST 不是 GET——理由見 /api/secrets/reveal 的說明(GET 不過 proxy 的 Origin 檢查)。
 */
export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const { apiKey } = getGlobalSettings();
  if (!apiKey) return NextResponse.json({ error: "尚未設定 API Key" }, { status: 404 });
  recordAuditFromRequest(req, "settings.reveal", "apiKey");
  return NextResponse.json({ value: apiKey });
}
