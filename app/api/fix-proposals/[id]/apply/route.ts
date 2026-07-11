import { NextResponse } from "next/server";
import { getClient } from "@/lib/modelClient";
import { getWorkflowModel } from "@/lib/settingsStore";
import { getProposal, setProposalStatus, claimProposal } from "@/lib/workflow/fixProposals";
import { getWorkflow, saveWorkflow, backupWorkflow } from "@/lib/workflow/store";
import { runWorkflowAndWait } from "@/lib/workflow/engine";
import { checkRunSemantics } from "@/lib/workflow/resultCheck";
import { recordFix } from "@/lib/workflow/learnedFixes";
import { resolveParams } from "@/lib/relativeDate";
import { autorunActive } from "@/lib/workflow/busyLocks";

/**
 * 使用者在首頁通知橫幅按「套用並重跑」：把 AI 先前想好的提案套進 workflow，備份現況(可還原)，
 * 然後重跑一次驗證有沒有真的修好，回傳結果。
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proposal = getProposal(id);
  if (!proposal) return NextResponse.json({ error: "找不到這個提案(可能已經處理過了)" }, { status: 404 });
  if (proposal.status !== "pending") return NextResponse.json({ error: "這個提案已經處理過了" }, { status: 409 });

  // 這條正式流程若正在跑 autorun/autofix，不能同時套用提案——兩邊各自以自己讀到的舊快照
  // 存檔，晚存的那個會把對方的合法改動整批覆蓋掉(踩過同類 bug 才在其他修改入口都補上這道檢查，
  // 這裡以前漏接)。
  if (autorunActive.has(proposal.workflow_id)) {
    return NextResponse.json({ error: "這條流程的自動測試/修復正在進行中，等它跑完再套用提案(不然會互相蓋掉對方的修改)" }, { status: 409 });
  }

  const wf = getWorkflow(proposal.workflow_id);
  if (!wf) return NextResponse.json({ error: "workflow 已被刪除" }, { status: 404 });

  const node = wf.nodes.find((n) => n.id === proposal.node_id);
  // 提案可能是好幾天前的：那個節點可能已經被刪、或這期間又被改過了。套用前先確認還適用，
  // 免得拿舊的 AI 猜測覆蓋掉使用者後來的正確設定，或對一個不存在的節點回報「套用成功」的假象。
  if (!node) {
    setProposalStatus(id, "dismissed");
    return NextResponse.json({ error: "這個提案對應的步驟已經不存在了(流程被改過)，已自動忽略此提案" }, { status: 409 });
  }
  const before = JSON.parse(proposal.before_json) as Record<string, unknown>;
  if (JSON.stringify(node.config) !== JSON.stringify(before)) {
    setProposalStatus(id, "dismissed");
    return NextResponse.json({ error: "這一步的設定在提案之後又被改過了，為避免蓋掉你後來的修改，已忽略這個舊提案。需要的話請重新執行讓 AI 重想。" }, { status: 409 });
  }

  const after = JSON.parse(proposal.after_json) as Record<string, unknown>;

  // 真正動手改設定之前，原子地把提案從 pending 標成 applied(檢查+更新是同一句 UPDATE)。
  // 搶不到代表另一個請求已經在處理了(使用者連點兩下)——不能套用+重跑兩次。
  if (!claimProposal(id)) {
    return NextResponse.json({ error: "這個提案已經處理過了" }, { status: 409 });
  }
  backupWorkflow(proposal.workflow_id);
  // 存檔前以磁碟最新版為底(AGENTS 存檔鐵則2)：上面 claimProposal 之前檢查的是「提案建立時」的
  // before 快照，但真正寫入前不能再拿函式開頭那份 wf 整包蓋回去——就算這個 handler 自己中間沒有
  // await 空窗，也可能有另一個完全獨立的請求(例如使用者在節點面板手動微調)在這之前已經存了新版本。
  const fresh = getWorkflow(proposal.workflow_id);
  if (!fresh) return NextResponse.json({ error: "workflow 已被刪除" }, { status: 404 });
  const newNodes = fresh.nodes.map((n) => (n.id === proposal.node_id ? { ...n, config: after } : n));
  saveWorkflow({ ...fresh, nodes: newNodes });
  const triggerParams = resolveParams(wf.triggerParams ?? [], {}, new Date());
  const result = await runWorkflowAndWait(proposal.workflow_id, triggerParams, { headed: false });

  // 套用後重跑一路跑到「等人簽核」＝修好了(等簽核是設計行為不是失敗)，交還使用者去簽核
  if (result.status === "waiting") {
    return NextResponse.json({ ok: true, runId: result.runId, suspicion: undefined, waiting: "流程跑到「等人簽核」正確地停下來了——到首頁簽核卡按核准/拒絕就會繼續。" });
  }

  if (result.status === "success" && result.varWarnings === 0) {
    // 跟 autorun/autofix 同一套防污染標準：結構層(varWarnings)乾淨還不夠，全綠後再過一次語意驗收——
    // 這裡以前只看 status==='success' 就記學習庫，是三個記錄入口裡把關最鬆的一個，
    // 「表面成功但輸出是垃圾」的修法會被記進去、往後每次修復都被當「優先參考」誤導(污染會自我繁殖)。
    const client = getClient();
    const model = getWorkflowModel(proposal.workflow_id, wf.defaultModel);
    const verdict = await checkRunSemantics(client, model, proposal.workflow_id, result.runId);
    if (!verdict.suspicious) {
      recordFix({ nodeType: node.type, error: proposal.error ?? "", before, after, note: "AI看守正式流程時的修法提案，使用者確認套用" });
    }
    return NextResponse.json({ ok: true, runId: result.runId, suspicion: verdict.suspicious ? verdict.reason : undefined });
  }

  // 套用後重跑還是失敗(或有變數警告)：提案維持 applied(claimProposal 時就標了——設定已經真的改了，
  // 不該讓使用者以為還在 pending)，但明確告訴他這次驗證沒過，需要再看一次
  return NextResponse.json({ ok: false, runId: result.runId, error: result.error ?? "套用後重跑仍失敗，請到該流程查看詳情" });
}
