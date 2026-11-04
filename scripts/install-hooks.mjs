#!/usr/bin/env node
/**
 * 裝 git pre-commit hook：commit 前自動跑隱私掃描。
 *
 * 為什麼不能只靠「記得跑 npm run check:change-guard」：這個 repo 是多個 AI 工具輪流改的
 * (Claude Code / Codex / Cursor…)，而真實事故正是某個不知道這條規則的工具把使用者真實工作用的
 * 內部報表分頁名稱、客戶產品名稱寫死進程式碼，一路推上公開 GitHub 才被發現。
 * 「人或 AI 記得執行」不是防線；commit 前自動擋才是。
 *
 * 只掃隱私(毫秒級)，不跑 lint/測試——hook 一旦讓 commit 變慢，下一步就是有人開始用
 * `--no-verify` 繞過它，那比沒有 hook 更糟。
 *
 * 由 postinstall 自動執行，使用者不用手動裝。
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const MARKER = "# agent-hub-privacy-hook";
const hookBody = `#!/bin/sh
${MARKER}
# 自動安裝(scripts/install-hooks.mjs)。掃到真實工作字眼就擋下 commit，避免流進公開 repo。
node "$(dirname "$0")/../../scripts/change-guard.mjs" --privacy-only || {
  echo ""
  echo "❌ commit 已被擋下：上面列出的字眼在隱私黑名單裡(data/privacy-blocklist.txt)。"
  echo "   把那些真實字眼從程式碼/測試/文件裡換成中性範例，再重新 commit。"
  exit 1
}
`;

const gitDir = path.join(root, ".git");
if (!fs.existsSync(gitDir)) {
  // 不是 git 工作區(例如當成套件被安裝)，沒有 hook 可裝，安靜結束。
  process.exit(0);
}

const hookPath = path.join(gitDir, "hooks", "pre-commit");
try {
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, "utf8");
    // 別人自己寫的 hook 不能覆蓋掉——那是破壞使用者的設定。只更新我們自己裝的那份。
    if (!existing.includes(MARKER)) {
      console.warn("⚠️ 已存在自訂的 pre-commit hook，沒有覆蓋它。要啟用隱私掃描請自行加上：node scripts/change-guard.mjs --privacy-only");
      process.exit(0);
    }
    if (existing === hookBody) process.exit(0);
  }
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, hookBody, { mode: 0o755 });
  console.log("✅ 已安裝 pre-commit 隱私掃描 hook");
} catch (err) {
  // 裝不上 hook 不該讓 npm install 失敗(例如 .git 是唯讀、或在 worktree 裡)。
  console.warn(`⚠️ pre-commit hook 沒裝成功(不影響安裝)：${err instanceof Error ? err.message : err}`);
}
