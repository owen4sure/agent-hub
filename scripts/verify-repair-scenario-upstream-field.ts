/**
 * 隔離 workflow 的真實 AI 修復驗證——情境:「上游輸出欄位不存在，下游拿到 {{變數}}」。
 *
 * 手動跑(不進 npm test，因為打真實模型、慢且吃 token，跟 410 條快速確定性單元測試不是同一類):
 *   npx tsx scripts/verify-repair-scenario-upstream-field.ts
 *
 * 建立一條刻意有 bug 的隔離流程(set-variable 輸出 "orderTotal"，if-condition 卻打字錯
 * 引用 "{{orderTtoal}}")，真的執行到失敗，再把失敗現場交給 aiRepairGraph 用真實模型修，
 * 檢查它是否正確診斷成「打字打錯的欄位名」並修對，而不是瞎猜/砍掉整段邏輯/修到別的節點。
 * 全程用臨時 workflow，結束一律刪除，絕不碰使用者自己的草稿。
 */
import { createWorkflow, saveWorkflow, deleteWorkflow, getWorkflow } from "../lib/workflow/store";
import { runWorkflowAndWait } from "../lib/workflow/engine";
import { aiRepairGraph } from "../lib/workflow/graphRepair";
import { getClient } from "../lib/modelClient";
import { CLAUDE_CODE_MODEL } from "../lib/claudeCodeClient";

async function main() {
  const wf = createWorkflow("[驗證用-請勿保留] 上游欄位不存在情境");
  wf.defaultModel = CLAUDE_CODE_MODEL; // 明確鎖本機 Claude Code，不吃免費閘道現在是否健康
  console.log(`建立隔離流程 ${wf.id}`);

  try {
    wf.nodes = [
      { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 250, y: 40 } },
      { id: "n_set", type: "set-variable", label: "設定訂單金額", config: { name: "orderTotal", value: "100" }, position: { x: 250, y: 160 } },
      // 刻意打錯字：上游輸出的是 orderTotal，這裡引用 orderTtoal
      { id: "n_if", type: "if-condition", label: "判斷金額是否偏高", config: { left: "{{orderTtoal}}", op: ">", right: "50" }, position: { x: 250, y: 280 } },
      { id: "n_true", type: "set-variable", label: "標記偏高", config: { name: "result", value: "high" }, position: { x: 120, y: 400 } },
      { id: "n_false", type: "set-variable", label: "標記正常", config: { name: "result", value: "low" }, position: { x: 380, y: 400 } },
    ];
    wf.edges = [
      { from: "trigger", to: "n_set" },
      { from: "n_set", to: "n_if" },
      { from: "n_if", to: "n_true", fromPort: "true" },
      { from: "n_if", to: "n_false", fromPort: "false" },
    ];
    saveWorkflow(wf);

    console.log("執行流程，預期在 n_if 因未解析變數而失敗…");
    const run = await runWorkflowAndWait(wf.id, {}, { timeoutMs: 60_000 });
    console.log("執行結果：", JSON.stringify(run, null, 2));

    if (run.status !== "failed" || run.failedNode !== "n_if") {
      console.error(`❌ 情境沒有照預期在 n_if 失敗(status=${run.status}, failedNode=${run.failedNode})——先確認 bug 場景本身建對了，不是在測 AI 修復。`);
      return;
    }
    if (!/orderTtoal/.test(run.error ?? "")) {
      console.error(`❌ 失敗訊息沒有點名未解析的欄位「orderTtoal」，錯誤是：${run.error}——先確認 assertNoUnresolvedVars 有正確觸發。`);
      return;
    }
    console.log("✅ Bug 場景如預期在 n_if 失敗，且錯誤訊息點名了未解析的欄位。開始交給真實模型修復…");

    const client = getClient();
    console.log(`使用模型：${CLAUDE_CODE_MODEL}`);

    const repair = await aiRepairGraph(client, CLAUDE_CODE_MODEL, wf.id, "n_if", run.error ?? "", run.runId, { apply: false });
    console.log("模型診斷：", repair.explanation);
    console.log("模型提出的修改：", JSON.stringify(repair.edits, null, 2));
    if (repair.skipped.length) console.log("被判定無效而跳過的修改：", JSON.stringify(repair.skipped, null, 2));

    // 判準：修改後的圖裡，n_if 的 left 不能再引用不存在的 orderTtoal；且要嘛改成
    // 引用真正存在的 orderTotal，要嘛反過來把 n_set 的 name 改成 orderTtoal(兩種都是合理修法)。
    const nifEdit = repair.edits.find((e) => e.nodeId === "n_if");
    const nsetEdit = repair.edits.find((e) => e.nodeId === "n_set");
    const finalLeft = String(nifEdit?.after?.left ?? "{{orderTtoal}}");
    const finalSetName = String(nsetEdit?.after?.name ?? "orderTotal");
    const stillBroken = finalLeft.includes("orderTtoal") && finalSetName !== "orderTtoal";
    const fixedByRenamingIf = finalLeft.includes("orderTotal") && !finalLeft.includes("orderTtoal");
    const fixedByRenamingSet = finalSetName === "orderTtoal";

    if (stillBroken || !(fixedByRenamingIf || fixedByRenamingSet)) {
      console.error("❌ 模型沒有把打錯字的欄位名對正確——沒通過驗證。");
    } else {
      console.log(`✅ 模型正確識別並修正了打字錯誤(${fixedByRenamingIf ? "改了 if-condition 的引用" : "改了 set-variable 的變數名"})，通過驗證。`);
    }
  } finally {
    deleteWorkflow(wf.id);
    console.log(`已刪除隔離流程 ${wf.id}（不留殘留資料）`);
    const gone = getWorkflow(wf.id);
    if (gone) console.error("❌ 刪除後仍查得到該 workflow，清理沒有成功！");
  }
}

main().catch((e) => {
  console.error("驗證腳本本身出錯：", e);
  process.exitCode = 1;
});
