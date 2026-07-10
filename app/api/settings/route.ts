import { NextResponse } from "next/server";
import { getGlobalSettings, setGlobalSettings, getMaxConcurrent, setMaxConcurrent, getBuilderPrefs, setBuilderPrefs } from "@/lib/settingsStore";
import { defaultMaxConcurrent } from "@/lib/workflow/engine";

export async function GET() {
  const { baseUrl, apiKey } = getGlobalSettings();
  // 不回傳金鑰明碼——同一台機器上任何能連到這個 port 的人都讀得到 GET 回應，比對照 /api/secrets 的作法(只回布林值)
  return NextResponse.json({
    baseUrl,
    hasApiKey: Boolean(apiKey),
    maxConcurrent: getMaxConcurrent(defaultMaxConcurrent()),
    builderPrefs: getBuilderPrefs(),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { baseUrl?: string; apiKey?: string; maxConcurrent?: number; builderPrefs?: string } | null;
  if (!body) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });
  // apiKey/baseUrl 留空都代表「不改」，不能用空字串蓋掉——setGlobalSettings 只在值 !== undefined 時才寫入，
  // 且 getGlobalSettings 用 `?? DEFAULT`(空字串非 nullish 不會退回預設)，所以空字串一旦寫進去會讓 AI 呼叫失效且無法恢復。
  setGlobalSettings({ baseUrl: body.baseUrl ? body.baseUrl : undefined, apiKey: body.apiKey ? body.apiKey : undefined });
  if (typeof body.maxConcurrent === "number" && Number.isFinite(body.maxConcurrent)) setMaxConcurrent(body.maxConcurrent);
  // 偏好跟金鑰不同:清空是合法操作(「我不要這些偏好了」),所以吃空字串;undefined 才是不改
  if (typeof body.builderPrefs === "string") setBuilderPrefs(body.builderPrefs);
  return NextResponse.json({ ok: true });
}
