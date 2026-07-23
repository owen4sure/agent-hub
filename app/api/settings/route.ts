import { NextResponse } from "next/server";
import { getGlobalSettings, setGlobalSettings, getMaxConcurrent, setMaxConcurrent, getBuilderPrefs, setBuilderPrefs, getBuilderEffort, setBuilderEffort, type BuilderEffort } from "@/lib/settingsStore";
import { defaultMaxConcurrent } from "@/lib/workflow/engine";

const BUILDER_EFFORT_VALUES = new Set<BuilderEffort>(["low", "medium", "high"]);

export async function GET() {
  const { baseUrl, apiKey } = getGlobalSettings();
  // 不回傳金鑰明碼——同一台機器上任何能連到這個 port 的人都讀得到 GET 回應，比對照 /api/secrets 的作法(只回布林值)
  return NextResponse.json({
    baseUrl,
    hasApiKey: Boolean(apiKey),
    maxConcurrent: getMaxConcurrent(defaultMaxConcurrent()),
    builderPrefs: getBuilderPrefs(),
    builderEffort: getBuilderEffort(),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { baseUrl?: unknown; apiKey?: unknown; maxConcurrent?: unknown; builderPrefs?: unknown; builderEffort?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });
  if (body.baseUrl !== undefined && (typeof body.baseUrl !== "string" || body.baseUrl.length > 2_000)) {
    return NextResponse.json({ error: "Base URL 格式不正確" }, { status: 400 });
  }
  if (body.apiKey !== undefined && (typeof body.apiKey !== "string" || body.apiKey.length > 20_000)) {
    return NextResponse.json({ error: "API Key 格式不正確" }, { status: 400 });
  }
  if (body.maxConcurrent !== undefined && (typeof body.maxConcurrent !== "number" || !Number.isInteger(body.maxConcurrent) || body.maxConcurrent < 1 || body.maxConcurrent > 8)) {
    return NextResponse.json({ error: "同時執行數必須是 1–8 的整數" }, { status: 400 });
  }
  if (body.builderPrefs !== undefined && (typeof body.builderPrefs !== "string" || body.builderPrefs.length > 2_000)) {
    return NextResponse.json({ error: "AI 建流程偏好最多 2,000 個字" }, { status: 400 });
  }
  if (body.builderEffort !== undefined && !BUILDER_EFFORT_VALUES.has(body.builderEffort as BuilderEffort)) {
    return NextResponse.json({ error: "推理力度必須是 low/medium/high 之一" }, { status: 400 });
  }
  // apiKey/baseUrl 留空都代表「不改」，不能用空字串蓋掉——setGlobalSettings 只在值 !== undefined 時才寫入，
  // 且 getGlobalSettings 用 `?? DEFAULT`(空字串非 nullish 不會退回預設)，所以空字串一旦寫進去會讓 AI 呼叫失效且無法恢復。
  setGlobalSettings({ baseUrl: typeof body.baseUrl === "string" && body.baseUrl ? body.baseUrl : undefined, apiKey: typeof body.apiKey === "string" && body.apiKey ? body.apiKey : undefined });
  if (typeof body.maxConcurrent === "number" && Number.isFinite(body.maxConcurrent)) setMaxConcurrent(body.maxConcurrent);
  // 偏好跟金鑰不同:清空是合法操作(「我不要這些偏好了」),所以吃空字串;undefined 才是不改
  if (typeof body.builderPrefs === "string") setBuilderPrefs(body.builderPrefs);
  if (typeof body.builderEffort === "string") setBuilderEffort(body.builderEffort as BuilderEffort);
  return NextResponse.json({ ok: true });
}
