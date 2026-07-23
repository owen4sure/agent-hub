/**
 * 「小白自然語句 → 預期理解 → 實際模型回應」的驗收矩陣(2026-07 第三輪外部審查 P2：
 * 587 項單元測試裡跟建圖/改流程有關的測試幾乎都餵預先寫死的模型 JSON 回覆，沒有任何測試
 * 真的呼叫語言模型驗證它是否正確理解否定句/多附件角色這類白話情境)。
 *
 * 手動跑: npx tsx scripts/verify-chat-comprehension-natural-language.ts
 * 前提：正式服務要在 http://127.0.0.1:3000 跑著(B、C 兩項會真的打 /build API 並查磁碟上的
 * 持久化結果，不只是呼叫 buildWorkflow() 這個函式本身——2026-07 第四輪外部審查指出，只呼叫
 * 函式本身無法驗證「真正會寫入的 API 路徑」有沒有守住，例如 build/route.ts 的
 * explicitEditRefusal 閘門就是在 route 層而非 buildWorkflow() 內部)。
 *
 * 這裡用「答案/磁碟狀態是否符合可驗證的具體條件」而非人工肉眼判讀來給出通過/失敗，並把每次
 * 執行的完整結果(時間、模型、原始輸出、比對結果)寫進 scratch 報告檔，讓結論可以事後被獨立核對，
 * 不是只靠這支腳本自己聲稱「通過」。
 *
 * 跟 npm test 分開(不進 change-guard)：會打真實付費 API、依賴正式服務在跑、模型輸出本身有
 * 隨機性，不適合每次改程式碼都跑一次；比照 scripts/verify-repair-scenario-*.ts 的既有慣例單獨執行。
 *
 * 已知範圍限制(誠實記錄，不誇大這支腳本的驗證力)：
 * - A 項是端對端整合檢查，驗證的是「模型的最終答案有沒有把兩份附件的角色搞反」，不是逐一
 *   隔離驗證 inferAttachmentRoleHint 這個提示產生器本身的正確性——那部分由 builder.test.ts
 *   的單元測試涵蓋(不需要真實模型、跑得快、可重複)。這裡測的是「就算提示器算對了，模型讀了
 *   之後最終有沒有真的照著做」，兩者互補，不是互相取代。
 */
import fs from "node:fs";
import path from "node:path";
import { getClient } from "../lib/modelClient";
import { DEFAULT_MODEL } from "../lib/models";
import { buildWorkflow, type ChatMessage } from "../lib/workflow/builder";
import { createWorkflow, saveWorkflow, deleteWorkflow, getWorkflow } from "../lib/workflow/store";
import { listSchedules, deleteSchedule } from "../lib/scheduler";

const API_BASE = "http://127.0.0.1:3000";
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), model: DEFAULT_MODEL };

async function testAttachmentRoleComprehension(): Promise<boolean> {
  console.log("\n=== A. 多附件角色理解(來源資料 vs 範本格式，不能搞反)——整合檢查，非隔離測試提示器本身 ===");
  const history: ChatMessage[] = [{
    role: "user",
    parts: [
      { kind: "text", text: "我要把「銷售資料.csv」的數字填進「月報範本.csv」規定的格式。這兩份檔案都附上了。只回答兩行，不要其他任何文字：\n第一行「來源檔案：X」(X是實際要處理的原始數字資料檔名)\n第二行「目標格式檔案：Y」(Y是規定輸出格式、要照抄格式排版的範本檔名)" },
      { kind: "file", name: "銷售資料.csv", content: "產品,數量\nA,10\nB,20\n" },
      { kind: "file", name: "月報範本.csv", content: "月報格式：品項 | 數量(千分位) |\n最後一列要加總計" },
    ],
  }];
  const result = await buildWorkflow(getClient(), DEFAULT_MODEL, history, { nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [] });
  console.log("模型回應：", JSON.stringify(result, null, 2));
  report.testA = { history, result };
  const msg = "message" in result ? result.message : "";
  const sourceOk = /來源檔案[:：].*銷售資料/.test(msg);
  const targetOk = /目標格式檔案[:：].*月報範本/.test(msg);
  if (sourceOk && targetOk) {
    console.log("✅ 模型正確分辨「銷售資料.csv」是來源、「月報範本.csv」是格式範本，沒有搞反。");
    return true;
  }
  console.error(`❌ 模型沒有正確分辨兩份附件的角色(sourceOk=${sourceOk}, targetOk=${targetOk})——沒通過驗證。`);
  return false;
}

async function testHypotheticalQuestionDoesNotTriggerEdit(): Promise<boolean> {
  console.log("\n=== B. 純假設性提問(沒有「不要改」這類明確叫停字眼)，真的打 /build API，查磁碟是否被寫入 ===");
  const wf = createWorkflow("[驗證用-請勿保留] 假設性提問情境");
  try {
    saveWorkflow({
      ...wf,
      status: "official",
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "sheet", type: "google-sheet-read", label: "讀月報週會報表", config: { sheetName: "月報週會分頁" }, position: { x: 200, y: 0 } },
        { id: "notify", type: "telegram-notify", label: "通知", config: { message: "月報週會報表已更新" }, position: { x: 400, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "sheet" }, { from: "sheet", to: "notify" }],
    });
    const text = "如果我把讀取那個 Google 試算表節點的分頁名稱從「月報週會」改成「業務週會」，後面寄出的通知內容需要跟著改嗎？我還在想要不要換，先跟我說說看會有什麼影響就好。";
    const res = await fetch(`${API_BASE}/api/workflows/${wf.id}/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history: [{ role: "user", parts: [{ kind: "text", text }] }] }),
    });
    const body = await res.json();
    console.log("API 回應 phase：", body.phase);
    console.log("API 回應：", JSON.stringify(body, null, 2));
    const diskAfter = getWorkflow(wf.id)!;
    const sheetNode = diskAfter.nodes.find((n) => n.id === "sheet");
    const untouched = sheetNode?.config.sheetName === "月報週會分頁" && diskAfter.nodes.length === 3 && diskAfter.edges.length === 2;
    report.testB = { text, apiResponse: body, diskUntouched: untouched };
    if (body.phase === "edits" || !untouched) {
      console.error(`❌ 使用者明顯只是在問「如果...會怎樣」，但 API 回應 phase="${body.phase}"、磁碟未變動=${untouched}——沒通過驗證。`);
      return false;
    }
    console.log(`✅ 真的打了 /build API，磁碟上的節點設定完全沒被改動(phase="${body.phase}")。`);
    return true;
  } finally {
    deleteWorkflow(wf.id);
  }
}

async function testCopyThenPartialModifyPreservesLogic(): Promise<boolean> {
  console.log("\n=== C. 複製流程後只要求改一處，真的打 /build API，核對其餘節點/連線/觸發參數完全沒被動到 ===");
  const originalCode = "// 只計算本月新增件數，不能被覆寫\nreturn { ...ctx.input, monthlyNew: (ctx.input.rows || []).filter(r => r.status === '新戶').length };";
  const originalCalcConfig = { intent: "計算本月新增件數(status為新戶)，不要改動這個邏輯", code: originalCode };
  const wf = createWorkflow("[驗證用-請勿保留] 複製後局部修改情境");
  try {
    saveWorkflow({
      ...wf,
      status: "official",
      copyHandoff: {
        sourceName: "甲分公司月報",
        summary: "這條流程是從「甲分公司月報」複製來的，計算本月新戶數的邏輯已經對過帳、不要重寫。",
        copiedAt: new Date().toISOString(),
      },
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "calc", type: "custom-code", label: "計算本月新戶數", config: originalCalcConfig, position: { x: 200, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "calc" }],
    });
    const res = await fetch(`${API_BASE}/api/workflows/${wf.id}/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history: [{ role: "user", parts: [{ kind: "text", text: "把自動執行時間改成每天早上九點就好，其他都不要動。" }] }] }),
    });
    const body = await res.json();
    console.log("API 回應：", JSON.stringify(body, null, 2));
    const diskAfter = getWorkflow(wf.id)!;
    const calcNode = diskAfter.nodes.find((n) => n.id === "calc");
    // 不只查 code 字串——標籤、intent、其他 config 欄位、節點數量、連線都要完全比對，
    // 不能只核對其中一個欄位就宣稱「沒被動到」(第四輪外部審查指出的驗收不足)。
    const calcFullyUntouched = Boolean(calcNode) &&
      calcNode!.label === "計算本月新戶數" &&
      calcNode!.config.intent === originalCalcConfig.intent &&
      typeof calcNode!.config.code === "string" && calcNode!.config.code.trim() === originalCode.trim() &&
      diskAfter.nodes.length === 2 &&
      diskAfter.edges.length === 1 &&
      diskAfter.edges[0].from === "trigger" && diskAfter.edges[0].to === "calc";
    // 這個測試的重點不只是「其他東西沒被動到」——如果使用者實際要求的那項修改(排程)也沒被
    // 套用，測試會被動地「全部沒改」而通過，卻沒驗證到「這句話真的有被聽懂並執行」
    // (第四輪外部審查抓到的另一個真實回歸：「其他都不要動」曾經把使用者自己要求的那項修改
    // 也一起攔下，若這裡沒檢查排程真的有變，這個回歸不會被這支腳本抓到)。
    const schedules = listSchedules(wf.id);
    const scheduleApplied = schedules.some((s) => s.cron === "0 9 * * *" && s.enabled === 1);
    report.testC = { apiResponse: body, calcFullyUntouched, scheduleApplied, calcConfigAfter: calcNode?.config, nodeCountAfter: diskAfter.nodes.length, edgeCountAfter: diskAfter.edges.length, schedulesAfter: schedules };
    for (const s of schedules) deleteSchedule(s.id);
    if (!calcFullyUntouched || !scheduleApplied) {
      console.error(`❌ calcFullyUntouched=${calcFullyUntouched}, scheduleApplied=${scheduleApplied}——沒通過驗證。`);
      console.error("現在的 calc config：", JSON.stringify(calcNode?.config, null, 2));
      console.error("現在的排程：", JSON.stringify(schedules, null, 2));
      return false;
    }
    console.log("✅ 排程真的被改成每天早上9點(使用者實際要求的修改有被執行)，且 calc 節點的標籤/intent/程式碼、整體節點數與連線結構都跟修改前完全一致。");
    return true;
  } finally {
    deleteWorkflow(wf.id);
  }
}

async function main() {
  const health = await fetch(`${API_BASE}/api/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`❌ 正式服務(${API_BASE})目前沒有回應——B、C 兩項需要真實 /build API，請先確認服務有跑起來再執行這支腳本。`);
    process.exitCode = 1;
    return;
  }
  const a = await testAttachmentRoleComprehension();
  const b = await testHypotheticalQuestionDoesNotTriggerEdit();
  const c = await testCopyThenPartialModifyPreservesLogic();
  console.log("\n=== 總結 ===");
  console.log(`A. 多附件角色理解：${a ? "✅ 通過" : "❌ 失敗"}`);
  console.log(`B. 假設性提問不觸發修改(真打 /build API)：${b ? "✅ 通過" : "❌ 失敗"}`);
  console.log(`C. 複製後局部修改不動既有邏輯(真打 /build API)：${c ? "✅ 通過" : "❌ 失敗"}`);
  report.finishedAt = new Date().toISOString();
  report.results = { A: a, B: b, C: c };
  const reportPath = path.join("/tmp", `verify-chat-comprehension-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n完整報告(含原始模型輸出/API回應/磁碟狀態比對)已寫入：${reportPath}`);
  if (!a || !b || !c) process.exitCode = 1;
}

main().catch((e) => {
  console.error("驗證腳本本身出錯：", e);
  process.exitCode = 1;
});
