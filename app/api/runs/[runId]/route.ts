import { NextResponse } from "next/server";
import { getRun, getRunLogs } from "@/lib/workflow/engine";

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const { searchParams } = new URL(req.url);
  // 帶 ?afterId=abc 會變 NaN → SQL `id>NaN` 恆假 → 即時日誌永遠空、畫面卡住；非有限數一律當 0
  const parsedAfterId = Number(searchParams.get("afterId") ?? "0");
  const afterId = Number.isFinite(parsedAfterId) ? parsedAfterId : 0;
  const { run, nodeRuns } = getRun(runId);
  if (!run) return NextResponse.json({ error: "找不到這次執行紀錄" }, { status: 404 });
  const raw = run as Record<string, unknown>;
  let triggerParams: Record<string, unknown> = {};
  try {
    const parsed = raw.trigger_params_json ? JSON.parse(String(raw.trigger_params_json)) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      triggerParams = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([key, value]) => {
        if (key.startsWith("__") || /(?:secret|token|password|cookie|filepath|attachmentpath|savedpath)/i.test(key)) return false;
        return value === null || ["string", "number", "boolean"].includes(typeof value);
      }).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 500) : value]));
    }
  } catch { /* 壞的舊參數不顯示，執行紀錄本身仍可讀 */ }
  // 這三欄只供引擎續跑，不能回到瀏覽器；其中 secret_overrides_json 可能含一次性敏感值。
  const { secret_overrides_json: _secret, node_config_overrides_json: _overrides, trigger_params_json: _rawParams, owner_pid: _owner, ...publicRun } = raw;
  void _secret; void _overrides; void _rawParams; void _owner;
  return NextResponse.json({ run: publicRun, triggerParams, nodeRuns, logs: getRunLogs(runId, afterId) });
}
