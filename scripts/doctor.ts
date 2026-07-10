#!/usr/bin/env npx tsx
/**
 * 健康檢查：`npm run doctor`。新同事 clone 下來第一次跑，或懷疑環境有問題時執行。
 * 每一項檢查都給「中文、可以直接照做」的修復方式，不會只丟一句英文錯誤訊息。
 * 這支腳本本身不假設任何東西已經裝好，所以刻意不 import 專案內其他會炸的模組(如 db.ts 會建 DB 檔)。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(__dirname, "..");
let hasError = false;

function ok(label: string) { console.log(`✅ ${label}`); }
function warn(label: string, fix: string) { console.log(`⚠️  ${label}\n   → ${fix}`); }
function fail(label: string, fix: string) { hasError = true; console.log(`❌ ${label}\n   → ${fix}`); }

console.log("🔍 Agent Hub 健康檢查\n");

// 1. Node 版本
const nodeVersion = process.versions.node;
const major = Number(nodeVersion.split(".")[0]);
if (major >= 20) ok(`Node.js ${nodeVersion}`);
else fail(`Node.js ${nodeVersion} 太舊`, "請安裝 Node.js 20 以上版本(建議用 nvm：nvm install 20)");

// 2. node_modules 是否裝過
if (fs.existsSync(path.join(ROOT, "node_modules"))) ok("已執行過 npm install");
else fail("還沒裝相依套件", "請先執行：npm install");

// 3. Playwright chromium 是否裝好(這是最常漏掉、只有真的跑到瀏覽器節點才會爆的那種問題)
try {
  const cacheDir = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const altCacheDir = path.join(os.homedir(), ".cache", "ms-playwright");
  const found = [cacheDir, altCacheDir].some((d) => fs.existsSync(d) && fs.readdirSync(d).some((n) => n.startsWith("chromium")));
  if (found) ok("Playwright 瀏覽器(Chromium)已安裝");
  else warn("找不到 Playwright 的 Chromium", "請執行：npx playwright install chromium");
} catch {
  warn("無法確認 Playwright 瀏覽器狀態", "保險起見可執行：npx playwright install chromium");
}

// 4. .env 是否存在(沒有也不是致命，設定頁可以填，但沒有的話第一次開網頁金鑰會是空的)
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  ok(".env 已建立");
} else {
  warn("還沒有 .env", "可用「cp .env.example .env」建立一份，再打開網頁的「設定」頁填入你的模型 API Key(或跟同事要那份 .env)");
}

// 5. data 目錄 / DB 檔可寫
const dataDir = path.join(ROOT, "data");
try {
  fs.mkdirSync(dataDir, { recursive: true });
  const testFile = path.join(dataDir, ".doctor-write-test");
  fs.writeFileSync(testFile, "ok");
  fs.rmSync(testFile);
  ok("data/ 目錄可以正常讀寫(本機資料庫、執行紀錄會存這裡)");
} catch (err) {
  fail("data/ 目錄無法寫入", `請確認 ${dataDir} 的權限，錯誤：${err instanceof Error ? err.message : String(err)}`);
}

// 6. port 3000 有沒有被佔用
try {
  execSync("lsof -i :3000 -sTCP:LISTEN", { stdio: "ignore" });
  warn("port 3000 目前被佔用", "如果等一下要用 npm run dev/start，得先關掉佔用 3000 的程式(可用「lsof -i :3000」查是誰)");
} catch {
  ok("port 3000 目前是空的");
}

// 7. 本機 Claude Code CLI(選用，非必要)：裝了+登入過的話，模型可以選「claude-code(本機訂閱)」，
// 不用另外申請 API key、通常也比免費/共用的 API 服務穩定
try {
  execSync("claude --version", { stdio: "ignore" });
  ok("偵測到本機 Claude Code CLI(可在模型選單選「claude-code(本機訂閱)」)");
} catch {
  warn("沒偵測到 Claude Code CLI(非必要)", "有 Claude 訂閱的話可以裝 Claude Code 並登入一次，之後模型選單就能選「claude-code(本機訂閱)」，不用另外申請 API key");
}

console.log(hasError ? "\n有項目需要處理，請照上面的建議修復後再跑一次。" : "\n🎉 一切就緒！可以執行 npm run dev 開始使用。");
process.exit(hasError ? 1 : 0);
