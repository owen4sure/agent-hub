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

// 隱私掃描：真實踩過的事故——不知道這條規則的 AI 工具把真實內部報表分頁名稱/客戶產品名稱
// 寫死進了公開原始碼跟測試，一路推上了公開 GitHub repo(commit e4af5aa)才被發現。黑名單內容放在
// gitignore 掉的 data/privacy-blocklist.txt(見該檔說明)，這裡只負責讀取+掃描，不管理名單本身；
// 檔案不存在(例如別人 clone 這個 repo 沒有這份私人清單)就靜默跳過，不影響其他人使用這支腳本。
const blocklistPath = path.join(root, "data/privacy-blocklist.txt");
if (fs.existsSync(blocklistPath)) {
  const terms = fs.readFileSync(blocklistPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (terms.length > 0) {
    try {
      // LC_ALL=en_US.UTF-8 是關鍵：預設的 C locale 下 grep 對多位元組中文字元會有假陰性
      // (真實踩過)，看起來乾淨其實是 locale 沒比對到，不是真的沒有命中。
      // --untracked 一併掃還沒 git add 的新檔，不能只查已追蹤的舊檔案。
      const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      // git grep 的 exit code 語意：0=找到相符內容、1=乾淨沒命中、其他=指令本身出錯。
      // execSync 對非 0 exit code 會 throw，所以「沒 throw」代表真的命中、要當失敗處理；
      // catch 到的 exit code 1 才是我們要的正常/乾淨結果，不能一律吞掉，其他 code 仍要老實報錯。
      const hits = execSync(
        `git grep -InE --untracked "${pattern}" -- . ':!data/privacy-blocklist.txt'`,
        { cwd: root, encoding: "utf8", env: { ...process.env, LC_ALL: "en_US.UTF-8" } },
      );
      failures.push(`隱私黑名單命中(真實工作字眼流進公開 repo)：\n${hits.trim().slice(0, 3000)}`);
    } catch (err) {
      if (err.status !== 1) failures.push(`隱私掃描本身執行失敗：${(err.stderr?.toString() ?? err.message).slice(0, 500)}`);
    }
  }
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
