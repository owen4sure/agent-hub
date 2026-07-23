#!/usr/bin/env node
/**
 * 快速防倒退檢查：不是取代測試，而是在任何 AI 工具改碼後先確認幾條不能被
 * 「順手刪掉」的產品底線仍存在。完整規則與人工驗收見 CHANGE_CONTROL.md。
 *
 * lint 也在這裡跑(不只是文件裡提醒「另外跑」)：AGENTS.md 原本只叫改碼的人另外記得跑
 * tsc/test，完全沒提到 lint——結果是 14 個 @typescript-eslint/no-explicit-any 錯誤在
 * lib/workflow/engine.fanout.test.ts 裡累積了一段時間都沒被發現，因為沒有任何一支「標準
 * 驗收流程」的腳本會主動跑它。把 lint 收進這支腳本，才能讓「任何工具跑 check:change-guard」
 * 這個唯一共同動作自動涵蓋 lint，不用每個人各自記得多跑一個指令。
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const requiredDocs = ["PROJECT_GOAL.md", "DEPENDENCY_MAP.md", "ARCHITECTURE.md", "CHANGE_CONTROL.md", "CHANGELOG.md"];
const checks = [
  ["workflow 一律以 saveWorkflow 保存", "lib/workflow/store.ts", /export function saveWorkflow/],
  ["跨站防護仍覆蓋 API", "proxy.ts", /matcher:\s*"\/api\/:path\*"/],
  ["整圖 AI 修復仍存在", "lib/workflow/graphRepair.ts", /export async function aiRepairGraph/],
  ["Google Slides 官方刷新節點仍存在", "lib/workflow/nodes/googleSlidesRefresh.ts", /refreshSheetsCharts/],
  ["建圖仍有結構檢查", "lib/workflow/builder.ts", /lintGraph/],
  ["引擎仍可取消執行", "lib/workflow/engine.ts", /AbortController/],
];

const failures = [];
for (const file of requiredDocs) if (!fs.existsSync(path.join(root, file))) failures.push(`缺少治理文件：${file}`);
for (const [name, file, pattern] of checks) {
  try { if (!pattern.test(read(file))) failures.push(`產品底線遺失：${name} (${file})`); }
  catch { failures.push(`無法讀取防護檔案：${file}`); }
}
try {
  execSync("npx eslint . --ext .ts,.tsx", { cwd: root, stdio: "pipe" });
} catch (err) {
  const output = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
  failures.push(`lint 沒有通過(執行 npx eslint 才看得到完整訊息)：\n${output.trim().slice(0, 2000)}`);
}

if (failures.length) {
  console.error("change guard failed:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("✅ change guard：核心治理文件、產品底線與 lint 都通過");
