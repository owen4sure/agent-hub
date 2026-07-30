import { NextResponse } from "next/server";
import { getRetentionPolicy, setRetentionPolicy, sweepRetention } from "@/lib/retention";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";

/** 目前的保留期限設定，附「現在如果清理會刪掉多少」(預覽，不刪任何東西)。 */
export async function GET() {
  const preview = sweepRetention({ preview: true });
  return NextResponse.json({ policy: getRetentionPolicy(), preview }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * 改設定，或立刻執行一次清理(`{ runNow: true }`)。
 *
 * 刪除是不可逆的，所以「改設定」和「真的刪」刻意分成兩個動作：使用者先改天數、看預覽數字，
 * 確定了才按清理。設定改完不會馬上刪——不然他調數字的過程中就把東西刪掉了。
 */
export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as
    { debugArtifactDays?: unknown; runRecordDays?: unknown; runNow?: unknown } | null;
  if (!body) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });

  if (body.runNow === true) {
    const result = sweepRetention();
    recordAuditFromRequest(req, "retention.sweep", null, result);
    return NextResponse.json({ ok: true, policy: getRetentionPolicy(), result });
  }

  const policy = setRetentionPolicy({
    ...(body.debugArtifactDays !== undefined ? { debugArtifactDays: Number(body.debugArtifactDays) } : {}),
    ...(body.runRecordDays !== undefined ? { runRecordDays: Number(body.runRecordDays) } : {}),
  });
  recordAuditFromRequest(req, "retention.update", null, policy);
  return NextResponse.json({ ok: true, policy, preview: sweepRetention({ preview: true }) });
}
