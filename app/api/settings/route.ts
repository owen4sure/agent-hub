import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getGlobalSettings, setGlobalSettings, getMaxConcurrent, setMaxConcurrent, getBuilderPrefs, setBuilderPrefs, getBuilderEffort, setBuilderEffort, getSetting, setSetting, type BuilderEffort } from "@/lib/settingsStore";
import { defaultMaxConcurrent } from "@/lib/workflow/engine";
import { latestDataBackup } from "@/lib/dataBackup";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";

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
    backupMirrorDir: getSetting("backupMirrorDir") ?? "",
    latestBackup: latestDataBackup(),
  });
}

export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
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
    return NextResponse.json({ error: "推理力度必須是「低」「中」「高」之一(API 格式：low/medium/high)" }, { status: 400 });
  }
  // 備份位置的驗證(含實際試寫)必須在**任何欄位寫入之前**——code review 抓到:原本這段在
  // setGlobalSettings 之後,同一個 POST 帶 apiKey+壞的備份位置時,apiKey 已默默存檔、
  // 請求卻回 400,使用者以為什麼都沒存,稽核軌跡也沒記到那筆已生效的變更。
  const bodyWithMirror = body as { backupMirrorDir?: unknown };
  let mirrorDirToSave: string | null = null;
  if (bodyWithMirror.backupMirrorDir !== undefined) {
    const raw = bodyWithMirror.backupMirrorDir;
    if (typeof raw !== "string" || raw.length > 1_000) return NextResponse.json({ error: "備份位置格式不正確" }, { status: 400 });
    const dir = raw.trim();
    if (dir === "") {
      mirrorDirToSave = ""; // 清空 = 不再抄第二份
    } else {
      if (!path.isAbsolute(dir)) return NextResponse.json({ error: "備份位置要填完整路徑(以 / 開頭,例如 /Volumes/隨身碟/agent-hub備份)" }, { status: 400 });
      // 存之前實際寫一次:「設定成功但外接碟其實掛不上」要在按下儲存的當下就發現,
      // 不是等到半夜備份失敗、隔天才在 log 裡看到
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, ".agent-hub-write-test");
        fs.writeFileSync(probe, "ok");
        fs.rmSync(probe, { force: true });
      } catch {
        return NextResponse.json({ error: `這個位置目前寫不進去：${dir}——請確認外接碟有插上、或資料夾有寫入權限` }, { status: 400 });
      }
      mirrorDirToSave = dir;
    }
  }
  // ── 所有驗證都過了,才開始寫入 ──
  // apiKey/baseUrl 留空都代表「不改」，不能用空字串蓋掉——setGlobalSettings 只在值 !== undefined 時才寫入，
  // 且 getGlobalSettings 用 `?? DEFAULT`(空字串非 nullish 不會退回預設)，所以空字串一旦寫進去會讓 AI 呼叫失效且無法恢復。
  setGlobalSettings({ baseUrl: typeof body.baseUrl === "string" && body.baseUrl ? body.baseUrl : undefined, apiKey: typeof body.apiKey === "string" && body.apiKey ? body.apiKey : undefined });
  if (typeof body.maxConcurrent === "number" && Number.isFinite(body.maxConcurrent)) setMaxConcurrent(body.maxConcurrent);
  // 偏好跟金鑰不同:清空是合法操作(「我不要這些偏好了」),所以吃空字串;undefined 才是不改
  if (typeof body.builderPrefs === "string") setBuilderPrefs(body.builderPrefs);
  if (typeof body.builderEffort === "string") setBuilderEffort(body.builderEffort as BuilderEffort);
  if (mirrorDirToSave !== null) setSetting("backupMirrorDir", mirrorDirToSave);
  recordAuditFromRequest(req, "settings.update", null, { fields: Object.keys(body ?? {}) });
  return NextResponse.json({ ok: true });
}
