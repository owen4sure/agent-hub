#!/usr/bin/env node
/**
 * 從備份還原：`npm run restore:backup -- <備份檔路徑>`（不給路徑就用最新的那一份）。
 *
 * 為什麼是命令列腳本而不是網頁上的按鈕：還原會直接換掉正在被使用的資料庫檔案。
 * 服務還開著的時候做這件事，會得到「一半舊一半新」的狀態(WAL 還沒寫回、正在跑的流程還在寫入)。
 * 所以這支腳本第一件事就是確認服務**沒有**在跑，是的話直接停下來並告訴使用者怎麼關。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const backupDir = path.join(root, "data", "backups");

function pickBackup() {
  const given = process.argv[2];
  if (given) return path.resolve(given);
  if (!fs.existsSync(backupDir)) return null;
  const files = fs.readdirSync(backupDir)
    .filter((name) => /^agent-hub-\d{4}-\d{2}-\d{2}\.zip$/.test(name))
    .sort();
  const latest = files.at(-1);
  return latest ? path.join(backupDir, latest) : null;
}

async function serverIsRunning() {
  try {
    const res = await fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(2_000) });
    return res.ok || res.status === 503; // 有人接電話就算在跑
  } catch {
    return false;
  }
}

const file = pickBackup();
if (!file) {
  console.error("❌ 找不到備份檔。用法：npm run restore:backup -- data/backups/agent-hub-YYYY-MM-DD.zip");
  process.exit(1);
}

if (await serverIsRunning()) {
  console.error(
    "❌ Agent Hub 正在執行中，不能在這個狀態下還原(會得到一半舊一半新的資料)。\n"
    + "   常駐服務：launchctl bootout gui/$(id -u)/com.agenthub.engine\n"
    + "   開發模式：把跑 npm run dev 的那個終端機關掉\n"
    + "   停好之後再重新執行這個指令。",
  );
  process.exit(1);
}

console.log(`↩️  準備從備份還原：${file}`);
// 用 tsx 執行 TypeScript 的還原邏輯——版面定義與驗證步驟跟建立備份共用同一份程式碼，
// 不在這支腳本裡另外實作一次(兩邊各寫一份遲早漂移，而漂移就是「備份還原不回來」的成因)。
const inline = `
import { restoreDataBackup } from "${path.join(root, "lib/dataBackup.ts").replace(/\\/g, "/")}";
const result = restoreDataBackup(process.argv[2]);
console.log("✅ 已還原：" + result.restored.join("、"));
if (result.movedAside.length) console.log("   舊資料已改名保留(確認沒問題後可自行刪除)：" + result.movedAside.join("、"));
if (result.envSavedAs) console.log("   備份裡的 .env 另存為 " + result.envSavedAs + "(沒有直接覆蓋現有的 .env，請自己比對)");
console.log("   驗證：完整性 " + result.verified.integrity + "、流程 " + result.verified.workflowRows + " 筆、設定 " + result.verified.settingRows + " 筆");
console.log("接下來：重新啟動 Agent Hub，打開 http://127.0.0.1:3000 確認流程都在。");
`;
const tmp = path.join(root, "data", `.restore-${process.pid}.mts`);
try {
  fs.writeFileSync(tmp, inline);
  execFileSync("npx", ["tsx", tmp, file], { cwd: root, stdio: "inherit" });
} catch {
  console.error("❌ 還原失敗(上面有原因)。現有資料沒有被刪除——若有 .before-restore-* 的檔案，把它們改回原名即可回到還原前的狀態。");
  process.exit(1);
} finally {
  fs.rmSync(tmp, { force: true });
}
