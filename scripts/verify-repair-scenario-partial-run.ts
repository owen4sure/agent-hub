/**
 * 隔離 workflow 驗證——情境:「只測某一步、從某一步開始測、完整安全試跑、正式執行，
 * 四者的行為是否清楚且不混淆」。
 *
 * 手動跑: npx tsx scripts/verify-repair-scenario-partial-run.ts
 *
 * 用兩個有真實副作用(寫檔案)的節點串接，四種執行模式各跑一次，直接檢查
 * data/outputs/<runId>/ 底下實際出現了哪些檔案——這是最誠實的判準:節點如果
 * 這一輪真的執行了，它的檔案就會出現在「這次」的產出資料夾；沒執行(重播用舊值
 * 或被跳過)就不會出現，不靠節點回報的文字說法，直接看實際落地的檔案。
 */
import fs from "node:fs";
import path from "node:path";
import { createWorkflow, saveWorkflow, deleteWorkflow, getWorkflow } from "../lib/workflow/store";
import { startWorkflowRun, getRun } from "../lib/workflow/engine";

function waitForRun(runId: string, timeoutMs = 30_000): Promise<{ status: string; error: string | null }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const { run } = getRun(runId) as { run: { status: string; error: string | null; finished_at: string | null } | undefined };
      if (run?.finished_at) return resolve({ status: run.status, error: run.error });
      if (Date.now() - start > timeoutMs) return reject(new Error("等待執行結束逾時"));
      setTimeout(poll, 300);
    };
    poll();
  });
}

function outputsExist(runId: string): { step1: boolean; step2: boolean } {
  const dir = path.join(process.cwd(), "data", "outputs", runId);
  return {
    step1: fs.existsSync(path.join(dir, "step1.txt")),
    step2: fs.existsSync(path.join(dir, "step2.txt")),
  };
}

async function main() {
  const wf = createWorkflow("[驗證用-請勿保留] 部分執行語意情境");
  console.log(`建立隔離流程 ${wf.id}`);
  const results: Record<string, boolean> = {};

  try {
    wf.nodes = [
      { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 250, y: 40 } },
      { id: "n1", type: "write-file", label: "步驟1寫檔", config: { fileName: "step1.txt", content: "step1 內容" }, position: { x: 250, y: 160 } },
      { id: "n2", type: "write-file", label: "步驟2寫檔", config: { fileName: "step2.txt", content: "step2 內容，依賴 {{savedPath}}" }, position: { x: 250, y: 280 } },
    ];
    wf.edges = [{ from: "trigger", to: "n1" }, { from: "n1", to: "n2" }];
    saveWorkflow(wf);

    // A. 完整正式執行——兩步都該真的落地
    console.log("\n=== A. 完整正式執行 ===");
    const runIdA = startWorkflowRun(wf.id, {});
    const finalA = await waitForRun(runIdA);
    const outA = outputsExist(runIdA);
    console.log("結果：", finalA, outA);
    results["A.正式執行兩步都真的寫檔"] = finalA.status === "success" && outA.step1 && outA.step2;

    // B. 完整安全試跑(dryRun)——兩步都不該真的落地(寫入被攔下，只讀排練)
    console.log("\n=== B. 完整安全試跑(dryRun:true) ===");
    const runIdB = startWorkflowRun(wf.id, {}, { dryRun: true });
    const finalB = await waitForRun(runIdB);
    const outB = outputsExist(runIdB);
    console.log("結果：", finalB, outB);
    results["B.安全試跑不真的寫檔"] = !outB.step1 && !outB.step2;

    // C. 從 n2 開始執行——n1 不該重跑(沿用 A 的結果當種子)，n2 該真的執行
    console.log("\n=== C. 從 n2 開始執行(startAtNodeId) ===");
    const runIdC = startWorkflowRun(wf.id, {}, { startAtNodeId: "n2" });
    const finalC = await waitForRun(runIdC);
    const outC = outputsExist(runIdC);
    console.log("結果：", finalC, outC);
    results["C.從n2開始_n1不重跑_n2真的跑"] = finalC.status === "success" && !outC.step1 && outC.step2;

    // D. 只測 n1——n2 不該執行
    console.log("\n=== D. 只測 n1(onlyNodeIds) ===");
    const runIdD = startWorkflowRun(wf.id, {}, { onlyNodeIds: ["n1"] });
    const finalD = await waitForRun(runIdD);
    const outD = outputsExist(runIdD);
    console.log("結果：", finalD, outD);
    results["D.只測n1_n1真的跑_n2不跑"] = outD.step1 && !outD.step2;

    console.log("\n=== 總結 ===");
    let allOk = true;
    for (const [name, ok] of Object.entries(results)) {
      console.log(`${ok ? "✅" : "❌"} ${name}`);
      if (!ok) allOk = false;
    }
    if (!allOk) process.exitCode = 1;
  } finally {
    deleteWorkflow(wf.id);
    console.log(`已刪除隔離流程 ${wf.id}（不留殘留資料）`);
    if (getWorkflow(wf.id)) console.error("❌ 刪除後仍查得到，清理沒有成功！");
  }
}

main().catch((e) => {
  console.error("驗證腳本本身出錯：", e);
  process.exitCode = 1;
});
