/**
 * 隔離 workflow 的真實 AI 理解力驗證——情境:「使用者貼 CSV/圖片時，AI 是否真的理解原檔內容」。
 *
 * 手動跑: npx tsx scripts/verify-repair-scenario-comprehension.ts
 *
 * 跟前面幾個「修復」情境不同，這裡測的是「一開始有沒有真的讀懂」，不是修復迴圈。
 * 兩段各自獨立、各自建自己的隔離流程、各自清乾淨：
 *  A. CSV——真實 CSV 檔(帶一個容易被瞎猜答錯的陷阱數字)，custom-code 節點要求依實際內容
 *     算出正確總和，藏在 code 裡的計算不是憑空編的公式，逼真的執行結果驗證。
 *  B. 圖片——用 sharp 產生一張真實 PNG(白底黑字寫一組隨機驗證碼)，read-image 節點問 AI
 *     圖上寫什麼，答案要精確含有那組隨機字串——隨機字串排除了「模型碰巧編對」的可能性。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createWorkflow, saveWorkflow, deleteWorkflow, getWorkflow } from "../lib/workflow/store";
import { runWorkflowAndWait } from "../lib/workflow/engine";
import { CLAUDE_CODE_MODEL } from "../lib/claudeCodeClient";

function randCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  return (
    letters[Math.floor(Math.random() * letters.length)] +
    letters[Math.floor(Math.random() * letters.length)] +
    digits[Math.floor(Math.random() * digits.length)] +
    digits[Math.floor(Math.random() * digits.length)] +
    letters[Math.floor(Math.random() * letters.length)]
  );
}

async function testCsvComprehension(): Promise<boolean> {
  console.log("\n=== A. CSV 理解力測試(直接把真實 CSV 內容交給 Claude Code，不自己代寫計算程式碼) ===");
  // 陷阱:產品C的單價 999、數量 1，總價剛好卡在「看起來像整數湊數」的邊界，逼模型真的照著算，不是憑印象猜整數
  const csvContent = "產品,單價,數量\n產品A,120,3\n產品B,45,10\n產品C,999,1\n產品D,88,5\n";
  const expectedTotal = 120 * 3 + 45 * 10 + 999 * 1 + 88 * 5; // 360+450+999+440 = 2249
  console.log(`CSV 內容：\n${csvContent}正確總和應為 ${expectedTotal}`);

  const { callClaudeCode } = await import("../lib/claudeCodeClient");
  // 模擬 builder.ts 真的把附件檔案內容(MessagePart{kind:"file"})塞進 prompt 給模型看的方式，
  // 不是我自己先算好答案再看模型會不會抄——這裡問的是「單價乘數量的總和」，模型必須真的逐列讀數字相乘再加總。
  const prompt = `(附上檔案「sales.csv」的內容)\n${csvContent}\n\n請只讀上面這份 CSV，把每一列的「單價」乘以「數量」，再把所有列加總。只回答一個阿拉伯數字，不要任何其他文字或說明。`;
  const answer = (await callClaudeCode({ prompt })).trim();
  console.log(`Claude Code 的回答：「${answer}」`);
  const gotNumber = answer.match(/\d[\d,]*/)?.[0]?.replace(/,/g, "");
  if (gotNumber === String(expectedTotal)) {
    console.log("✅ AI 真的讀懂 CSV 內容並算出正確總和，通過驗證。");
    return true;
  }
  console.error(`❌ AI 給的答案(${gotNumber ?? "(無法解析出數字)"})跟正確總和(${expectedTotal})不符——沒通過驗證。`);
  return false;
}

async function testImageComprehension(): Promise<boolean> {
  console.log("\n=== B. 圖片理解力測試 ===");
  const code = randCode();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-image-fixture-"));
  const imgPath = path.join(tmpDir, "captcha.png");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120">
    <rect width="300" height="120" fill="white"/>
    <text x="20" y="75" font-size="40" font-family="monospace" fill="black">${code}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(imgPath);
  console.log(`產生的圖片：${imgPath}，正確答案應為「${code}」`);

  const wf = createWorkflow("[驗證用-請勿保留] 圖片理解力情境");
  wf.defaultModel = CLAUDE_CODE_MODEL;
  console.log(`建立隔離流程 ${wf.id}`);

  try {
    wf.nodes = [
      { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 250, y: 40 } },
      {
        id: "n_read_img", type: "read-image", label: "讀圖片文字",
        config: { source: imgPath, prompt: "這張圖片上白底黑字寫的是什麼英數字組合？只回那組字元，不要加任何說明或標點。", outputKey: "imageText" },
        position: { x: 250, y: 160 },
      },
    ];
    wf.edges = [{ from: "trigger", to: "n_read_img" }];
    saveWorkflow(wf);

    const run = await runWorkflowAndWait(wf.id, {}, { timeoutMs: 90_000 });
    console.log("執行結果：", JSON.stringify(run, null, 2));
    if (run.status !== "success") {
      console.error("❌ 流程沒有成功執行——沒通過驗證。");
      return false;
    }

    // 讀真實的 node output 比對答案（不透過 AI 二次轉述，直接查 DB 落地的執行紀錄）
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const row = db.prepare(`SELECT output_json FROM node_runs WHERE run_id = ? AND node_id = 'n_read_img' ORDER BY id DESC LIMIT 1`).get(run.runId) as { output_json: string } | undefined;
    const output = row ? JSON.parse(row.output_json) : {};
    const answer = String(output.imageText ?? "");
    console.log(`AI 讀到的文字：「${answer}」，正確答案：「${code}」`);
    if (answer.toUpperCase().includes(code.toUpperCase())) {
      console.log("✅ AI 正確讀出圖片上的隨機驗證碼，通過驗證。");
      return true;
    }
    console.error(`❌ AI 讀到的文字沒有包含正確答案——沒通過驗證。`);
    return false;
  } finally {
    deleteWorkflow(wf.id);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (getWorkflow(wf.id)) console.error("❌ 圖片情境刪除後仍查得到，清理失敗！");
  }
}

async function main() {
  const csvOk = await testCsvComprehension();
  const imgOk = await testImageComprehension();
  console.log("\n=== 總結 ===");
  console.log(`CSV 理解力：${csvOk ? "✅ 通過" : "❌ 失敗"}`);
  console.log(`圖片理解力：${imgOk ? "✅ 通過" : "❌ 失敗"}`);
  if (!csvOk || !imgOk) process.exitCode = 1;
}

main().catch((e) => {
  console.error("驗證腳本本身出錯：", e);
  process.exitCode = 1;
});
