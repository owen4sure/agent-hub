/**
 * 隔離 workflow 的真實 AI 修復驗證——情境:「網頁 selector 改版、真實 HTML/截圖已存在時，
 * AI 是否真的依證據修 selector」。
 *
 * 手動跑: npx tsx scripts/verify-repair-scenario-selector.ts
 *
 * 重現 AGENTS.md 記載的真實病灶案例:程式碼寫 div.thumbnail-item，但頁面上實際是
 * <g class="thumbnail-item">(SVG 元素，tag 不是 div)。custom-code 用真的 Playwright
 * 開一個本機 fixture 頁面(file://，不碰網路)，用錯的選擇器找不到元素就 throw，
 * 讓引擎照正常路徑把失敗當下的真實頁面 HTML 存到 node_runs 目錄——不是我自己塞資料，
 * 是走真實的「執行失敗→存證據」路徑，驗證 selectorProbe 證據鏈跟 aiRepairGraph 有沒有真的接上。
 * 驗證重點:AI 提的新選擇器是否真的能命中真實頁面上的 <g> 元素——不是比對選擇器字面文字
 * (模型可能合理地選擇拿掉 tag 前綴變成 .thumbnail-item，一樣正確，不該被判失敗)，而是拿新選擇器
 * 對同一份 fixture HTML 重播實測(用專案自己的 selectorProbe，跟系統真正的重播驗證閘門同一套)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkflow, saveWorkflow, deleteWorkflow, getWorkflow } from "../lib/workflow/store";
import { runWorkflowAndWait } from "../lib/workflow/engine";
import { aiRepairGraph } from "../lib/workflow/graphRepair";
import { getClient } from "../lib/modelClient";
import { CLAUDE_CODE_MODEL } from "../lib/claudeCodeClient";
import { extractSelectorsFromCode, probeSelectorsInHtml } from "../lib/workflow/selectorProbe";

const FIXTURE_HTML = `<!doctype html><html><body>
<div id="gallery">
  <g class="thumbnail-item" data-id="42">實際縮圖A</g>
  <g class="thumbnail-item" data-id="43">實際縮圖B</g>
</div>
</body></html>`;

async function main() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-selector-fixture-"));
  const fixturePath = path.join(fixtureDir, "gallery.html");
  fs.writeFileSync(fixturePath, FIXTURE_HTML, "utf-8");

  const wf = createWorkflow("[驗證用-請勿保留] selector 改版情境");
  wf.defaultModel = CLAUDE_CODE_MODEL;
  console.log(`建立隔離流程 ${wf.id}，fixture 頁面：${fixturePath}`);

  try {
    const code = `const page = await ctx.session.getPage();
await page.goto("file://${fixturePath}");
const count = await page.locator("div.thumbnail-item").count();
if (count === 0) throw new Error("找不到縮圖元素(div.thumbnail-item)，頁面可能改版了，選擇器命中 0 筆");
return { ...ctx.input, thumbnailCount: count };`;

    wf.nodes = [
      { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 250, y: 40 } },
      { id: "n_scrape", type: "custom-code", label: "抓縮圖數量", config: { intent: "打開圖庫頁面，數一下有幾張縮圖", code }, position: { x: 250, y: 160 } },
    ];
    wf.edges = [{ from: "trigger", to: "n_scrape" }];
    saveWorkflow(wf);

    console.log("執行流程，預期在 n_scrape 因選擇器命中 0 筆而失敗…");
    const run = await runWorkflowAndWait(wf.id, {}, { timeoutMs: 60_000, headed: false });
    console.log("執行結果：", JSON.stringify(run, null, 2));

    if (run.status !== "failed" || run.failedNode !== "n_scrape") {
      console.error(`❌ 情境沒有照預期在 n_scrape 失敗(status=${run.status}, failedNode=${run.failedNode})。`);
      return;
    }
    console.log("✅ Bug 場景如預期失敗，選擇器命中 0 筆。開始交給真實模型(Claude Code)修復…");

    const client = getClient();
    const repair = await aiRepairGraph(client, CLAUDE_CODE_MODEL, wf.id, "n_scrape", run.error ?? "", run.runId, { apply: false });
    console.log("模型診斷：", repair.explanation);
    console.log("模型提出的修改：", JSON.stringify(repair.edits, null, 2));
    if (repair.skipped.length) console.log("被判定無效而跳過的修改：", JSON.stringify(repair.skipped, null, 2));

    const edit = repair.edits.find((e) => e.nodeId === "n_scrape");
    const newCode = String(edit?.after?.code ?? "");
    if (!newCode) {
      console.error("❌ 模型沒有對 n_scrape 提出程式碼修改——沒通過驗證。");
    } else {
      // 不比對選擇器字面文字(拿掉 tag 前綴變成 .thumbnail-item 一樣正確)，而是對同一份 fixture
      // HTML 重播實測新選擇器——這才是「有沒有真的修對」的客觀判準，跟系統自己的驗證閘門同一套方法。
      const newSelectors = extractSelectorsFromCode(newCode);
      const probeResults = await probeSelectorsInHtml(FIXTURE_HTML, newSelectors);
      const hitsBothItems = probeResults.some((r) => r.count === 2);
      console.log("對 fixture 頁面重播實測新選擇器：", JSON.stringify(probeResults, null, 2));
      if (hitsBothItems) {
        console.log("✅ 模型依真實頁面證據提出的新選擇器，重播實測真的命中兩個 <g> 元素，通過驗證。");
      } else {
        console.error(`❌ 新選擇器重播實測沒有命中 2 筆——沒有真的修對，沒通過驗證。新程式碼：\n${newCode}`);
      }
    }
  } finally {
    deleteWorkflow(wf.id);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    console.log(`已刪除隔離流程 ${wf.id} 與 fixture 檔案（不留殘留資料）`);
    const gone = getWorkflow(wf.id);
    if (gone) console.error("❌ 刪除後仍查得到該 workflow，清理沒有成功！");
  }
}

main().catch((e) => {
  console.error("驗證腳本本身出錯：", e);
  process.exitCode = 1;
});
