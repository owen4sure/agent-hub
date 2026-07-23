/**
 * 隔離 workflow 的真實 AI 修復驗證——情境:「節點設定有誤，但不是 custom-code」。
 *
 * 手動跑: npx tsx scripts/verify-repair-scenario-wrong-config.ts
 *
 * 跟「上游欄位不存在」那個情境不同:這裡的 config 值是「語法上完全合法、型別也對，
 * 但語意上是錯的」——read-file 的 path 被寫死成一個不存在的絕對路徑字面字串(不是
 * {{變數}} 打錯字，是壓根沒有引用上游)，靜態 lint 抓不到，只有真的執行才會炸。
 * 驗證 AI 是否看得懂「上游 write-file 真正輸出的欄位是 savedPath」，把 path 改成
 * {{savedPath}}，而不是照著錯誤訊息字面提示亂猜成 {{filePath}}(那是給資料夾監聽
 * 觸發用的慣例欄位，這條流程是手動觸發、根本沒有這個欄位)。
 */
import { createWorkflow, saveWorkflow, deleteWorkflow, getWorkflow } from "../lib/workflow/store";
import { runWorkflowAndWait } from "../lib/workflow/engine";
import { aiRepairGraph } from "../lib/workflow/graphRepair";
import { getClient } from "../lib/modelClient";
import { CLAUDE_CODE_MODEL } from "../lib/claudeCodeClient";

async function main() {
  const wf = createWorkflow("[驗證用-請勿保留] 節點設定錯誤情境");
  wf.defaultModel = CLAUDE_CODE_MODEL;
  console.log(`建立隔離流程 ${wf.id}`);

  try {
    wf.nodes = [
      { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 250, y: 40 } },
      { id: "n_write", type: "write-file", label: "寫報表", config: { fileName: "report.txt", content: "測試內容" }, position: { x: 250, y: 160 } },
      // 刻意誤設:寫死一個不存在的絕對路徑，沒有引用上游 write-file 真正輸出的 {{savedPath}}
      { id: "n_read", type: "read-file", label: "讀回報表", config: { path: "/tmp/agent-hub-verify-wrong-path-does-not-exist.txt", maxChars: "20000" }, position: { x: 250, y: 280 } },
    ];
    wf.edges = [
      { from: "trigger", to: "n_write" },
      { from: "n_write", to: "n_read" },
    ];
    saveWorkflow(wf);

    console.log("執行流程，預期在 n_read 因路徑不存在而失敗…");
    const run = await runWorkflowAndWait(wf.id, {}, { timeoutMs: 60_000 });
    console.log("執行結果：", JSON.stringify(run, null, 2));

    if (run.status !== "failed" || run.failedNode !== "n_read") {
      console.error(`❌ 情境沒有照預期在 n_read 失敗(status=${run.status}, failedNode=${run.failedNode})——先確認 bug 場景本身建對了。`);
      return;
    }
    console.log("✅ Bug 場景如預期在 n_read 失敗。開始交給真實模型(Claude Code)修復…");

    const client = getClient();
    const repair = await aiRepairGraph(client, CLAUDE_CODE_MODEL, wf.id, "n_read", run.error ?? "", run.runId, { apply: false });
    console.log("模型診斷：", repair.explanation);
    console.log("模型提出的修改：", JSON.stringify(repair.edits, null, 2));
    if (repair.skipped.length) console.log("被判定無效而跳過的修改：", JSON.stringify(repair.skipped, null, 2));

    const nreadEdit = repair.edits.find((e) => e.nodeId === "n_read");
    const finalPath = String(nreadEdit?.after?.path ?? "");
    const correct = finalPath.includes("{{savedPath}}");
    const wrongGuess = finalPath.includes("{{filePath}}");

    if (correct) {
      console.log("✅ 模型正確識別上游 write-file 真正輸出的欄位是 savedPath，通過驗證。");
    } else if (wrongGuess) {
      console.error("❌ 模型照抄了錯誤訊息裡的通用提示 {{filePath}}，但這條流程是手動觸發，根本沒有這個欄位——沒有真的看懂上游圖，沒通過驗證。");
    } else {
      console.error(`❌ 模型沒有把 path 改成正確引用上游輸出，最終值是：${finalPath || "(沒有修改 n_read)"}——沒通過驗證。`);
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
