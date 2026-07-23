export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { markComponentHealth } = await import("./lib/systemHealth");
  const init = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      markComponentHealth(name, true, "已啟動");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markComponentHealth(name, false, message);
      console.error(`[instrumentation] ${name} 啟動失敗:`, err);
    }
  };

  // 每個背景元件獨立啟動、獨立記錄。以前整串包在同一個 try：前面任何一次清理出錯，排程、
  // 資料夾、收信、Telegram 後面全部不會啟動，UI 卻完全看不出來。
  await init("engine", async () => {
    // 舊版把 Google Sheet 寫入網址放在設定頁。啟動時先搬進各寫入節點，確保使用者升級後
    // 不必重填，也不會再看到「一般試算表網址 / Apps Script 網址」混在同一區。
    const { migrateLegacySheetWriteUrl } = await import("./lib/sheetWriteUrlMigration");
    const migrated = migrateLegacySheetWriteUrl();
    if (migrated.nodes) console.info(`[migration] 已把舊 Google Sheet 寫入網址搬進 ${migrated.workflows} 條流程的 ${migrated.nodes} 個節點`);
    const engine = await import("./lib/workflow/engine");
    engine.recoverCrashedRuns();
    engine.pruneOrphanOutputs();
    const { recoverCrashedRepairs } = await import("./lib/workflow/repairSessions");
    recoverCrashedRepairs();
    const { cleanupStaleProposals } = await import("./lib/workflow/fixProposals");
    cleanupStaleProposals();
    const approvals = await import("./lib/approvals");
    approvals.pruneOrphanApprovals();
  });
  await init("scheduler", async () => (await import("./lib/scheduler")).startScheduler());
  await init("folderWatcher", async () => (await import("./lib/watchers")).startWatchers());
  await init("mailWatcher", async () => (await import("./lib/mailWatcher")).startMailWatcher());
  await init("telegramPoller", async () => (await import("./lib/telegramPoller")).startTelegramPoller());
  await init("backup", async () => (await import("./lib/dataBackup")).startDataBackups());
}
