import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { MissingWorkflowSettingsError, QueueCapacityError, startWorkflowRun } from "@/lib/workflow/engine";
import { AcceptanceSpecOutdatedError } from "@/lib/workflow/acceptanceSpec";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";

// 粗略檢查即可，不追求 RFC 完整合規——這裡只是擋掉「忘了填」「打錯字漏掉 @」這種明顯錯誤，
// 不是要驗證信箱真的存在(那要真的寄出去才知道，而這正是這支 API 在做的事)。
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 「✉️ 測試寄送」：用這條流程真正會產生的主旨/內容/附件寄一封信，但收件人**強制只會是**
 * 這次請求裡明確填的那個信箱——不管節點設定裡的收件人/副本/密件副本欄位當下填了什麼，這裡一律
 * 忽略不用。使用者原話：「還要可以測試把信件傳給自己來檢視內容是否正確，千萬不能不小心真的傳到
 * 自己以外的地方」。
 *
 * 安全設計：這是唯一能在「正式執行」(dryRun:false)時對 nodeConfigOverrides 生效的路徑之一
 * (見 engine.ts 的 confirmedPreview 閘門)，能這樣做是因為 override 的內容**完全由這支 API 自己
 * 組出來**(`to` 固定等於請求裡的 testEmail、`cc`/`bcc` 固定清空)，不會、也不能被拿去覆寫成
 * 別的欄位(主旨/內容/附件仍然是這個節點真正存好的設定，只有收件人被鎖死)——不是「一般執行
 * API 開放前端塞任意覆寫」，是這支 API 本身只做這一件事。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; nid: string }> }) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const { id, nid } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const node = wf.nodes.find((n) => n.id === nid);
  if (!node) return NextResponse.json({ error: "找不到這個步驟(流程可能剛被改過)，請重新整理頁面再試" }, { status: 404 });
  if (node.type !== "webmail-send") return NextResponse.json({ error: "這個動作只能用在「用網頁信箱寄信」這種步驟" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { testEmail?: unknown };
  const testEmail = typeof body.testEmail === "string" ? body.testEmail.trim() : "";
  if (!testEmail) return NextResponse.json({ error: "請填要收測試信的信箱地址" }, { status: 400 });
  if (!LOOKS_LIKE_EMAIL.test(testEmail)) return NextResponse.json({ error: "這個信箱地址格式看起來不對，請確認有沒有打錯" }, { status: 400 });

  try {
    const runId = startWorkflowRun(id, {}, {
      trigger: "manual",
      dryRun: false, // 要真的寄出去才驗證得出登入狀態/簽名檔/附件實際運作正常，只是收件人鎖死
      onlyNodeIds: [nid],
      confirmedPreview: true, // override 是這支 API 自己組的固定值，不是從前端請求體直接塞的任意內容
      nodeConfigOverrides: { [nid]: { to: testEmail, cc: "", bcc: "" } },
    });
    recordAuditFromRequest(req, "workflow.node.test-send", id, { nodeId: nid });
    return NextResponse.json({ runId });
  } catch (err) {
    if (err instanceof MissingWorkflowSettingsError) {
      return NextResponse.json({ error: err.message, code: "MISSING_REQUIRED_SETTINGS", missing: err.missing }, { status: 400 });
    }
    if (err instanceof AcceptanceSpecOutdatedError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "無法送出測試信" },
      { status: err instanceof QueueCapacityError ? 429 : 400 },
    );
  }
}
