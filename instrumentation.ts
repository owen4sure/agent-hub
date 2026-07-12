export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const engine = await import("./lib/workflow/engine");
    const scheduler = await import("./lib/scheduler");
    const watchers = await import("./lib/watchers");
    const { cleanupStaleProposals } = await import("./lib/workflow/fixProposals");
    engine.recoverCrashedRuns();
    cleanupStaleProposals(); // 清掉太舊沒人理/早就處理過的 AI 修法提案
    engine.pruneOrphanOutputs(); // 清掉已刪除 run 遺留的產出資料夾(釋放磁碟)
    const approvals = await import("./lib/approvals");
    approvals.pruneOrphanApprovals(); // 清掉指向已刪流程/已清紀錄的孤兒簽核(不留幽靈簽核卡)
    scheduler.startScheduler();
    watchers.startWatchers(); // 資料夾監聽觸發
    const mailWatcher = await import("./lib/mailWatcher");
    mailWatcher.startMailWatcher(); // 收信觸發(IMAP 輪詢，只掃有開啟的正式流程)
    const poller = await import("./lib/telegramPoller");
    poller.startTelegramPoller(); // Telegram 唯一接收端：簽核按鈕+訊息觸發(閒置時不碰 API)
  } catch (err) {
    console.error("instrumentation init failed:", err);
  }
}
