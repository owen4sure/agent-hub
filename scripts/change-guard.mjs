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
/**
 * `--privacy-only`：只跑隱私掃描，給 pre-commit hook 用。
 * hook 要在**每一次 commit** 前跑，所以不能跑 eslint(數十秒)——git grep 是毫秒級的，
 * 每次都跑也不會有人想繞過它。完整檢查仍然是 `npm run check:change-guard`。
 */
const privacyOnly = process.argv.includes("--privacy-only");
const requiredDocs = ["PROJECT_GOAL.md", "DEPENDENCY_MAP.md", "ARCHITECTURE.md", "CHANGE_CONTROL.md", "CHANGELOG.md"];
const checks = [
  ["workflow 一律以 saveWorkflow 保存", "lib/workflow/store.ts", /export function saveWorkflow/],
  // matcher 後來從單一字串變成陣列(頁面請求也要進 proxy 才能發本機權杖 cookie)，
  // 但「/api 全覆蓋」這件事不能被改掉——所以比對的是那個字面路徑，不是整行寫法。
  ["跨站防護仍覆蓋 API", "proxy.ts", /matcher:[\s\S]{0,120}"\/api\/:path\*"/],
  ["API 仍驗本機存取權杖", "proxy.ts", /localTokenMatches/],
  ["本機權杖仍是常數時間比對", "lib/localToken.ts", /timingSafeEqual/],
  ["整圖 AI 修復仍存在", "lib/workflow/graphRepair.ts", /export async function aiRepairGraph/],
  ["Google Slides 官方刷新節點仍存在", "lib/workflow/nodes/googleSlidesRefresh.ts", /refreshSheetsCharts/],
  ["建圖仍有結構檢查", "lib/workflow/builder.ts", /lintGraph/],
  ["引擎仍可取消執行", "lib/workflow/engine.ts", /AbortController/],
];

const failures = [];
if (!privacyOnly) {
  for (const file of requiredDocs) if (!fs.existsSync(path.join(root, file))) failures.push(`缺少治理文件：${file}`);
  for (const [name, file, pattern] of checks) {
    try { if (!pattern.test(read(file))) failures.push(`產品底線遺失：${name} (${file})`); }
    catch { failures.push(`無法讀取防護檔案：${file}`); }
  }
}

// 隱私掃描：真實踩過的事故——不知道這條規則的 AI 工具把真實內部報表分頁名稱/客戶產品名稱
// 寫死進了公開原始碼跟測試，一路推上了公開 GitHub repo(commit e4af5aa)才被發現。黑名單內容放在
// gitignore 掉的 data/privacy-blocklist.txt(見該檔說明)，這裡只負責讀取+掃描，不管理名單本身。
//
// 檔案不存在時**不能靜默跳過**(原本會，而那讓整個安全網形同不存在)：稽核指出兩個缺口疊加——
// ①清單被 gitignore、只存在作者那台機器 ②CI 根本沒跑這支腳本。結果是這個防護的唯一觸發時機
// 變成「有人剛好在那台機器上手動跑」。靜默跳過最惡劣的地方是它看起來像通過：
// 別的 AI 工具在別的環境跑完看到 ✅，會合理相信隱私掃描已經掃過了。
// 所以改成：沒有清單就大聲說「這一項沒有掃」，並告訴看到的人怎麼補。
const blocklistPath = path.join(root, "data/privacy-blocklist.txt");
const privacyScanRan = fs.existsSync(blocklistPath);
if (!privacyScanRan) {
  console.warn(
    "⚠️ 隱私黑名單掃描【沒有執行】：找不到 data/privacy-blocklist.txt。\n"
    + "   這台機器/這個環境無法檢查「真實工作字眼有沒有被寫進程式碼」——不要把這次的通過當成掃過了。\n"
    + "   作者本機：把真實字眼一行一個放進 data/privacy-blocklist.txt(該檔已被 gitignore，不會進公開 repo)。\n"
    + "   CI：把同一份內容放進 GitHub Secret `PRIVACY_BLOCKLIST`，workflow 會自動寫成檔案再跑這支腳本。",
  );
}
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
if (!privacyOnly) {
  try {
    execSync("npx eslint . --ext .ts,.tsx", { cwd: root, stdio: "pipe" });
  } catch (err) {
    const output = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
    failures.push(`lint 沒有通過(執行 npx eslint 才看得到完整訊息)：\n${output.trim().slice(0, 2000)}`);
  }
}

if (failures.length) {
  console.error("change guard failed:\n- " + failures.join("\n- "));
  process.exit(1);
}
// 「隱私掃描沒跑」跟「隱私掃描通過」必須是兩句不同的話——否則上面警告完又印一句通過，
// 看到的人(或 AI)只會記得後面那句 ✅。
const privacyNote = privacyScanRan ? "隱私掃描" : "隱私掃描【略過，未檢查】";
console.log(privacyOnly
  ? `✅ ${privacyNote}`
  : `✅ change guard：核心治理文件、產品底線與 lint 都通過(${privacyNote})`);
