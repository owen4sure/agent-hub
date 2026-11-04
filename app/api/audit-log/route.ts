import { NextResponse } from "next/server";
import { AUDIT_ACTION_LABELS, AUDIT_ACTOR_LABELS, countAudit, listAudit } from "@/lib/auditLog";

/**
 * 稽核軌跡查詢。
 *
 * 為什麼要有畫面看得到：稽核軌跡的價值全部在「事後查得到」。只寫進 DB、沒有任何地方看得到，
 * 等於要求使用者自己開 sqlite——那在稽核上跟沒有一樣。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const action = url.searchParams.get("action") ?? undefined;
  const entries = listAudit({ limit: Number.isFinite(limit) ? limit : 100, ...(action ? { action } : {}) });
  return NextResponse.json({
    total: countAudit(),
    entries: entries.map((e) => ({
      ...e,
      actionLabel: AUDIT_ACTION_LABELS[e.action] ?? e.action,
      actorLabel: AUDIT_ACTOR_LABELS[e.actor] ?? e.actor,
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}
