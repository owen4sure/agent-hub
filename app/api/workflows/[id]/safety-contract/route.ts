import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { findSafetyContractViolations, getSafetyContract, relaxSafetyContract } from "@/lib/workflow/safetyContract";
import { RELAXABLE_EFFECTS } from "@/lib/workflow/safetyContractUi";
import type { SideEffectTag } from "@/lib/workflow/sideEffects";

/**
 * 「只讀保護」契約的查詢與解除。
 *
 * 建立契約**不在這裡**：它只能由使用者在對話裡自己講出「只讀／不要修改／不要寫入」時，由 /build
 * 依原話記錄(見 safetyContract.recordReadOnlyContractFromUserText)。這條路由只負責對稱的另一半——
 * 使用者改變主意、明確授權寫入時的解除或縮小，並留下稽核軌跡。
 *
 * 刻意**不提供**「建立任意契約」或「由圖的內容自動解除」的入口：AI 產出的圖含寫入節點不構成授權。
 */
// 可放寬的項目跟畫面共用同一份清單(見 safetyContractUi.ts)——API 支援五類、畫面只列得出三類的話，
// 使用者按不到的那兩類等於不存在。

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const contract = getSafetyContract(id);
  if (!contract) return NextResponse.json({ contract: null, violations: [] });
  return NextResponse.json({
    contract: {
      bannedEffects: contract.bannedEffects,
      sourceText: contract.sourceText,
      createdAt: contract.createdAt,
      updatedAt: contract.updatedAt ?? null,
      updatedNote: contract.updatedNote ?? null,
      active: contract.bannedEffects.length > 0,
    },
    // 讓畫面能直接告訴使用者「現在按執行會被擋在哪裡」，不用等執行失敗才知道
    violations: findSafetyContractViolations(wf, contract).slice(0, 20),
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { note?: unknown; allowEffects?: unknown };
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : "使用者在流程頁明確解除只讀保護";
  let allowEffects: SideEffectTag[] | undefined;
  if (body.allowEffects !== undefined) {
    if (!Array.isArray(body.allowEffects)) return NextResponse.json({ error: "allowEffects 必須是陣列" }, { status: 400 });
    allowEffects = body.allowEffects.filter((t): t is SideEffectTag => typeof t === "string" && (RELAXABLE_EFFECTS as string[]).includes(t));
    if (allowEffects.length === 0) return NextResponse.json({ error: "allowEffects 裡沒有可以放寬的項目" }, { status: 400 });
  }
  const updated = relaxSafetyContract(id, note, allowEffects);
  if (!updated) return NextResponse.json({ error: "這條流程沒有只讀保護契約" }, { status: 404 });
  return NextResponse.json({ ok: true, bannedEffects: updated.bannedEffects, updatedAt: updated.updatedAt, updatedNote: updated.updatedNote });
}
